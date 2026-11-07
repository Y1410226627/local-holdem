/**
 * 翻前 EV 引擎：把「查百分位阈值」换成「逐动作算期望值」。
 *
 * 为什么重做而不是继续打补丁：
 * 旧实现是三层阈值表（入池线 / 加注线 / 3-bet 线）+ 一堆随机混合系数。
 * 它有三个结构性缺陷，靠调参修不掉：
 *   ① 跟注额不参与决策（`ctx.potOdds` 在翻前一次都没被读）；
 *   ② 位置只影响阈值高低，不影响「这手牌在这里值多少钱」；
 *   ③ 加注只看牌力，不看弃牌率——对手从不弃牌时加注毫无意义。
 *
 * 现在每个合法动作都算 EV，取最大：
 *   EV(弃牌) = 0
 *   EV(过牌) = 权益 × 底池 × 权益实现率
 *   EV(跟注) = 权益 × (底池 + 跟注额) × 权益实现率 − 跟注额
 *   EV(加注) = 弃牌率 × 底池 + (1−弃牌率) × [对跟注范围权益 × (底池 + 2×投入) × 实现率 − 投入]
 *
 * 三个输入是近似的，都在函数里写明依据：
 *   - 对手范围（前百分之几）：由加注尺度 / PFR / 加注轮次估计（见 preflopCall.ts）；
 *   - 权益实现率：位置相关，IP > 1、OOP < 1，多人底池递减；
 *   - 弃牌率：优先用对手公开统计，无样本时用「开池 / 3-bet / 4-bet」的先验。
 *
 * 只用公开信息（自己底牌、底池、筹码、位置、对手公开统计）。
 */
import type { Card } from '../game/types';
import type { Position } from './rangeModel';
import { equityVsTopRange } from './preflopCall';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export interface PreflopEvInput {
  hero: readonly [Card, Card];
  /** 当前底池（已含对手本轮下注）。 */
  pot: number;
  /** 需要跟注的筹码。 */
  callAmount: number;
  /** 自己剩余筹码（不含本手已投入）。 */
  stack: number;
  /** 自己本手已投入的筹码。 */
  committed: number;
  minRaiseTo: number;
  maxRaiseTo: number;
  canCheck: boolean;
  canCall: boolean;
  canRaise: boolean;
  /** 计划加注到的总额（由调用方按难度档位算好）。 */
  raiseTo: number;
  /** 面对加注时：估计对手加注范围（前百分之几）。无人加注时传 0.6。 */
  raiserRange: number;
  /** 本街已发生的加注次数（0 = 我们开池）。 */
  raiseCount: number;
  /** 仍在牌局里的对手数量。 */
  opponentCount: number;
  /** 对手面对下注的平均弃牌率（null = 无样本）。 */
  foldToBet: number | null;
  position: Position;
  /** 是否允许「跛入」。开池阶段（无人加注且无人跛入）应当只有加注或弃牌。 */
  allowLimp: boolean;
  rng: () => number;
  /** 蒙特卡洛样本数（默认 200）。 */
  samples?: number;
  /**
   * 风险溢价系数：对「跟注 / 加注」按投入比例扣掉一点 EV。
   *
   * 依据：权益是 200 次蒙特卡洛的估计（标准误约 3.5%），对手范围也是估计值。
   * 在 0 EV 附近做决策等于在噪声上做决策，所以要求一个正的安全边际。
   * 不扣这一项时，引擎会把所有「勉强不亏」的边缘牌都打进去（实测 UTG 开池 34%）。
   */
  riskPremium?: number;
}

export interface PreflopEvOption {
  kind: 'fold' | 'check' | 'call' | 'raise';
  /** 加注到的总额（仅 kind === 'raise'）。 */
  amount?: number;
  ev: number;
}

export interface PreflopEvResult {
  best: PreflopEvOption;
  options: PreflopEvOption[];
  /** 对「对手当前范围」的权益。 */
  equity: number;
  /** 对「跟注范围」（比当前范围更紧）的权益。 */
  equityCalled: number;
  /** 权益实现率。 */
  realization: number;
  /** 估计的全下弃牌率（所有对手都弃）。 */
  foldEquity: number;
}

/**
 * 权益实现率：原始胜率能兑现成多少底池份额。
 *
 * 有位置可以多兑现（可以免费看牌、控制底池、按需下注），无位置少兑现。
 * 多人底池实现率下降（更多对手意味着更多被压制的情形）。
 *
 * 数值来自本项目对引擎的实测（IP 0.985 / OOP 1.009 的原始测量偏中性，
 * 这里取略强的位置差异，避免把「不会利用位置」这个缺陷固化进模型）。
 */
export function realizationFor(
  position: Position,
  opponentCount: number,
  hero?: readonly [Card, Card],
): number {
  const base =
    position === 'late' ? 1.08 : position === 'middle' ? 1.0 : position === 'blinds' ? 0.92 : 0.96;
  const positional = base * Math.max(0.85, 1 - 0.05 * Math.max(0, opponentCount - 1));
  return positional * playabilityFactor(hero);
}

/**
 * 牌型可玩性：同样的原始胜率，能兑现成多少底池份额。
 *
 * 同花、连张能兑现更多（成牌时更容易拿到价值、有更多半诈唬机会）；
 * 间隔大的杂色牌兑现更少（成对子也常被压制，很难打大底池）。
 * 这修正了「所有牌都按同一个实现率」的粗糙假设——它正是「开池跛入 35%」的元凶之一。
 */
export function playabilityFactor(hero?: readonly [Card, Card]): number {
  if (!hero) return 1;
  const [a, b] = hero;
  const high = Math.max(a.rank, b.rank);
  const low = Math.min(a.rank, b.rank);
  const suited = a.suit === b.suit;
  const gap = high - low - 1;
  let factor = 1;
  if (suited) factor += 0.12;
  if (high === low) factor += 0.06; // 口袋对子：成三条时很好收价值
  if (gap <= 1) factor += 0.06;
  else if (gap >= 4) factor -= 0.14;
  if (gap >= 6) factor -= 0.06;
  if (!suited && gap >= 3) factor -= 0.10;
  return clamp(factor, 0.62, 1.16);
}

/**
 * 估计「我们加注后所有人弃牌」的概率。
 *
 * 优先用对手公开的 fold-to-bet；无样本时用先验：
 * 开池（无人加注）约 62%，面对一个加注做 3-bet 约 55%，4-bet 以上约 35%。
 * 多人底池按对手数取幂（每个对手独立弃牌）。
 */
export function foldEquityFor(
  raiseCount: number,
  opponentCount: number,
  foldToBet: number | null,
): number {
  // 直接估「所有人都弃牌」的概率，而不是「单人弃牌率 ^ 人数」。
  // 后者会把 6 人桌开池算成 0.62^5 = 8.6%，严重低估加注的弃牌收益。
  //
  // 先验是对着公开 GTO 开池范围校准出来的（见 README「翻前 EV 引擎」一节）：
  // 目标是让 6 人桌 UTG 开池落在 15%~20%，而不是拍一个数。
  const prior =
    raiseCount <= 0
      ? clamp(0.55 - 0.05 * (opponentCount - 1), 0.2, 0.6)
      : raiseCount === 1
        ? 0.45
        : 0.32;
  if (foldToBet === null) return prior;
  return clamp(0.45 * prior + 0.55 * foldToBet, 0.1, 0.9);
}

/**
 * 我们加注后被对手再加注的概率。
 *
 * 这一项之前漏了，导致模型认为「3-bet 任何两张都赚」——因为弃牌收益按整个底池算，
 * 而被跟注时的损失算得太轻。现实中 4-bet 会直接吃掉我们的全部投入。
 */
export function reraiseFor(raiseCount: number): number {
  if (raiseCount <= 0) return 0.1;
  if (raiseCount === 1) return 0.15;
  return 0.05;
}

export function evaluatePreflop(input: PreflopEvInput): PreflopEvResult {
  const {
    hero,
    pot,
    callAmount,
    stack,
    committed,
    minRaiseTo,
    maxRaiseTo,
    canCheck,
    canCall,
    canRaise,
    raiseTo,
    raiserRange,
    raiseCount,
    opponentCount,
    foldToBet,
    position,
    allowLimp,
    rng,
  } = input;
  const samples = input.samples ?? 200;
  const riskPremium = input.riskPremium ?? 0.06;
  const realization = realizationFor(position, opponentCount, hero);
  const foldEquity = foldEquityFor(raiseCount, opponentCount, foldToBet);
  const reraiseChance = reraiseFor(raiseCount);

  // 对「当前对手范围」的权益
  const equity = equityVsTopRange(hero, raiserRange, rng, samples);
  // 对「会跟注我们加注的范围」的权益：比当前范围更紧（约六成宽度，下限 3%）
  const callRange = Math.max(0.03, raiserRange * 0.55);
  const equityCalled =
    callRange >= raiserRange - 1e-6 ? equity : equityVsTopRange(hero, callRange, rng, samples);

  const options: PreflopEvOption[] = [];

  // 弃牌：相对当前筹码，收益为 0
  options.push({ kind: 'fold', ev: 0 });

  // 过牌：免费看翻牌
  if (canCheck) {
    options.push({ kind: 'check', ev: equity * pot * realization });
  }

  // 跟注（跛入）
  if (canCall && allowLimp) {
    const ev = equity * (pot + callAmount) * realization - callAmount - riskPremium * callAmount;
    options.push({ kind: 'call', ev });
  }

  // 加注
  if (canRaise && Number.isFinite(raiseTo) && raiseTo > 0) {
    const target = clamp(Math.round(raiseTo), minRaiseTo, maxRaiseTo);
    const invest = Math.max(1, target - committed);
    if (target > 0 && invest > 0) {
      const calledPot = pot + 2 * invest;
      const evCalled = equityCalled * calledPot * realization - invest;
      // 三种结局：所有人弃牌（赢底池）/ 有人跟注（打到摊牌）/ 被再加注（我们弃牌，损失投入）
      const ev =
        foldEquity * pot +
        (1 - foldEquity - reraiseChance) * evCalled +
        reraiseChance * -invest -
        riskPremium * invest;
      options.push({ kind: 'raise', amount: target, ev });
    }
  }

  let best = options[0];
  for (const option of options) {
    if (option.ev > best.ev) best = option;
  }

  // 筹码不足时不能「加注」，退化成全下——由调用方按 legal 处理
  void stack;

  return { best, options, equity, equityCalled, realization, foldEquity };
}
