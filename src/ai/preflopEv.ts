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
  /** 对手统计的置信度 0..1（按样本手数）；决定「实测值」和「先验」的权重。 */
  readConfidence?: number;
  /** 对手「有加注机会时的加注率」0..1（无样本传 null），用于估被再加注的概率。 */
  pfrOpportunity?: number | null;
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
  /** 对「再加注范围」（最紧）的权益。 */
  equityReraised: number;
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
  confidence = 0.5,
): number {
  // 直接估「所有人都弃牌」的概率，而不是「单人弃牌率 ^ 人数」。
  // 后者会把 6 人桌开池算成 0.62^5 = 8.6%，严重低估加注的弃牌收益。
  //
  // 但反过来也不能把「面对 3-bet 后的 32%」原样用到多人池：
  // 3-bet 之后还能行动的人，范围已经强于随机牌，而且人越多「所有人同时弃牌」越难。
  // v0.26 实测漏洞：6 人桌 3-bet 池里 94o / J6o / 55 被算成正 EV 全下（EV 模型给 32% 弃牌率），
  // 人类玩家在实战里一眼就能看出这是乱推。因此 raiseCount>=1 时把先验按剩余对手数摊薄。
  // 开池（raiseCount=0）的先验不动：它是对着 6 人桌 UTG 开池频率校准出来的。
  const n = Math.max(1, opponentCount);
  const prior =
    raiseCount <= 0
      ? clamp(0.55 - 0.05 * (n - 1), 0.2, 0.6)
      : raiseCount === 1
        ? clamp(0.45 / n, 0.08, 0.45)
        : n === 1
          ? 0.3
          : clamp(0.18 / n, 0.015, 0.18);
  if (foldToBet === null) return clamp(prior, 0.02, 0.9);
  // 收缩估计：样本越多越信实测值。
  // 旧实现固定 45% 权重给先验，等于「永远不太相信数据」——一个从不弃牌的对手
  // 也照样被估成 25% 弃牌率，加注的弃牌收益被凭空放大。
  const w = clamp(0.15 + 0.75 * confidence, 0.15, 0.9);
  // 加注之后的多人池：把平均弃牌率按独立弃牌合成（p^n），
  // 否则「平均每人弃 40%」会被当成「所有人一起弃 40%」，全下的弃牌收益被高估数倍。
  const measured =
    raiseCount <= 0 ? foldToBet : Math.pow(clamp(foldToBet, 0.01, 0.99), n);
  return clamp((1 - w) * prior + w * measured, 0.02, 0.9);
}

/**
 * 我们加注后被对手再加注的概率。
 *
 * 这一项之前漏了，导致模型认为「3-bet 任何两张都赚」——因为弃牌收益按整个底池算，
 * 而被跟注时的损失算得太轻。现实中 4-bet 会直接吃掉我们的全部投入。
 *
 * 有对手样本时按「有加注机会时的加注率」的平方估：平方是因为「他会加注」不等于
 * 「他会再加注我的加注」，开池频率远高于 3-bet 频率；但极端值必须对——
 * 一个每次轮到他加注就推的人，我们开池后他 100% 会推，这时再用 10% 的先验
 * 就会让我们拿 3BB 去开池、被推了再弃，白送 3BB（实测 150 手白扔 42 个大盲）。
 */
export function reraiseFor(raiseCount: number, pfrOpportunity?: number | null): number {
  const prior = raiseCount <= 0 ? 0.1 : raiseCount === 1 ? 0.15 : 0.05;
  if (pfrOpportunity === null || pfrOpportunity === undefined) return prior;
  const measured = clamp(pfrOpportunity, 0, 1) ** 2;
  return clamp(Math.max(prior, measured), 0, 0.95);
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
  const rawFold = foldEquityFor(raiseCount, opponentCount, foldToBet, input.readConfidence ?? 0.5);
  const rawReraise = reraiseFor(raiseCount, input.pfrOpportunity);
  // 三种结局（全弃 / 跟注 / 再加注）的概率必须加起来 ≤ 1。
  // 对手既不爱弃牌又爱再加注时（疯子），两项会同时很高，必须等比压缩，
  // 否则 (1 − 弃牌率 − 再加注率) 变成负数，「被跟注」这个结局反而倒扣 EV。
  const over = rawFold + rawReraise;
  const scale = over > 0.95 ? 0.95 / over : 1;
  const foldEquity = rawFold * scale;
  const reraiseChance = rawReraise * scale;

  // 对「当前对手范围」的权益
  const equity = equityVsTopRange(hero, raiserRange, rng, samples);
  // 对「会跟注我们加注的范围」的权益：比当前范围更紧（约六成宽度，下限 3%）
  const callRange = Math.max(0.03, raiserRange * 0.55);
  const equityCalled =
    callRange >= raiserRange - 1e-6 ? equity : equityVsTopRange(hero, callRange, rng, samples);
  // 再加注范围：比跟注范围更紧（他 3-bet 用的牌比跟注用的少）
  const reraiseRange = Math.max(0.03, raiserRange * 0.45);
  const equityReraised =
    reraiseRange >= raiserRange - 1e-6 ? equity : equityVsTopRange(hero, reraiseRange, rng, samples);

  const options: PreflopEvOption[] = [];

  // 弃牌：相对当前筹码，收益为 0
  options.push({ kind: 'fold', ev: 0 });

  // 过牌：免费看翻牌
  if (canCheck) {
    options.push({ kind: 'check', ev: equity * pot * realization });
  }

  // 跟注（跛入）
  if (canCall && allowLimp) {
    // 跟注就把自己打光 → 之后没有翻后：不存在「被位置压制」「被迫弃掉权益」这些损失，
    // 权益实现率必须正好是 1。旧实现一律按位置给 0.70~1.08，
    // 等于把「跟全下」的价值系统性砍掉三成（Q9o 对随机牌 55.1%，按 0.70 折算只剩 38.6%）。
    const callRealization = callAmount >= stack - 1e-6 ? 1 : realization;
    const ev =
      equity * (pot + callAmount) * callRealization - callAmount - riskPremium * callAmount;
    options.push({ kind: 'call', ev });
  }

  // 加注
  if (canRaise && Number.isFinite(raiseTo) && raiseTo > 0) {
    const target = clamp(Math.round(raiseTo), minRaiseTo, maxRaiseTo);
    const invest = Math.max(1, target - committed);
    if (target > 0 && invest > 0) {
      const calledPot = pot + 2 * invest;
      // 全下加注被跟 → 同样没有翻后，实现率取 1
      const raiseRealization = target >= maxRaiseTo - 1e-6 ? 1 : realization;
      const evCalled = equityCalled * calledPot * raiseRealization - invest;
      // 被再加注后我们还有一次决策：按对「再加注范围」的权益和全下赔率决定跟或弃。
      // 旧实现直接记成「损失全部投入」，等于假设我们面对再加注 100% 弃牌——
      // 碰到「每手都推」的对手时，这个假设会把开池算成大亏，机器人于是干脆不开池、
      // 白送 0.5BB 盲注（实测从 +361 BB/100 掉到 −19.6）。
      const evReraised = Math.max(
        -invest,
        equityReraised * calledPot * raiseRealization - invest,
      );
      // 三种结局：所有人弃牌（赢底池）/ 有人跟注（打到摊牌）/ 被再加注（再决策一次）
      const ev =
        foldEquity * pot +
        (1 - foldEquity - reraiseChance) * evCalled +
        reraiseChance * evReraised -
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

  return { best, options, equity, equityCalled, equityReraised, realization, foldEquity };
}
