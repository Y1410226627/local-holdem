/**
 * 本地人机决策入口。
 *
 * 输入契约：只接受 PlayerView（类型上无法访问对手底牌），不使用任何网络 /
 * 大模型 / 外部服务。四档难度分别走独立的决策分支：
 *
 * - beginner：翻牌前查表（不看位置），松被动；翻牌后只看牌型强度与跟注成本；
 * - normal：起手牌范围 + 位置阈值；翻牌后牌力 vs 底池赔率，约 7% 诈唬；
 * - hard：翻牌后蒙特卡洛胜率（默认 8000 次），听牌半诈唬，多尺度下注；
 * - expert：蒙特卡洛（默认 20000 次）+ 基于行动历史的范围收窄 + SPR / 多街计划。
 *
 * 确定性：随机源固定为
 *   mulberry32(hashString(`${view.seed}#${difficulty}#${view.actions.length}`))
 * 绝不使用 Math.random。
 */
import type { Difficulty, LegalActions, PlayerAction } from '../game/types';
import type { PlayerView } from '../game/playerView';
import { hashString, mulberry32 } from '../game/cards';
import { DIFFICULTY_PROFILES, getDifficultyProfile, type DifficultyProfile } from './difficulty';
import { estimateEquity, type RangeWeight } from './equity';
import {
  analyzePostflop,
  handKey,
  positionOf,
  preflopStrength,
  preflopStrengthOf,
  preflopThresholdsForProfile,
  POSITION_LABELS,
  type PostflopAnalysis,
} from './rangeModel';

export interface AIDecisionOptions {
  /** 测试 / 降载用：限制蒙特卡洛模拟次数（取 min(默认值, maxIterations)）。 */
  maxIterations?: number;
  /**
   * 训练 / 回放用：强制使用指定的难度档位（不读取全局难度配置与训练覆盖）。
   * 自博弈训练脚本用它评估候选参数。
   */
  profileOverride?: DifficultyProfile;
}

export interface AIDebugInfo {
  difficulty: Difficulty;
  /** 人机风格简述（中文）。 */
  profile: string;
  /** 胜率 0..1。 */
  equity?: number;
  /** 底池赔率 0..1：跟注成本 / (底池 + 跟注成本)。 */
  potOdds?: number;
  /** 当前牌型中文（翻牌前为“起手牌 XX”）。 */
  handCategory?: string;
  /** 蒙特卡洛次数。 */
  iterations?: number;
  /** 中文决策依据。 */
  reasoning: string;
  /** 决策来源：本地算法 / 本地大模型。 */
  source?: 'local' | 'llm';
  /** 大模型名称（source === 'llm' 时）。 */
  model?: string;
  /** 大模型调用耗时（毫秒）。 */
  latencyMs?: number;
  /** 大模型原始响应（截断，用于调试）。 */
  rawResponse?: string;
}

export interface AIDecision {
  action: PlayerAction;
  debug: AIDebugInfo;
}

interface DecisionContext {
  view: PlayerView;
  legal: LegalActions;
  difficulty: Difficulty;
  profile: DifficultyProfile;
  rng: () => number;
  potOdds: number;
}

interface OpponentRead {
  playerId: number;
  raises: number;
  calls: number;
  checks: number;
  /** null 表示没有足够信息，使用均匀随机范围。 */
  range: RangeWeight | null;
}

/* ------------------------------------------------------------------ */
/* 通用辅助                                                            */
/* ------------------------------------------------------------------ */

function potOddsOf(view: PlayerView, legal: LegalActions): number {
  const cost = Math.max(0, legal.callAmount);
  if (cost === 0) return 0;
  const pot = Math.max(0, view.pot);
  return cost / (pot + cost);
}

export function isActionLegal(action: PlayerAction, legal: LegalActions): boolean {
  switch (action.type) {
    case 'fold':
      return legal.canFold;
    case 'check':
      return legal.canCheck;
    case 'call':
      return legal.canCall;
    case 'allin':
      return legal.canAllIn;
    case 'bet':
    case 'raise': {
      if (!Number.isInteger(action.amount)) return false;
      if (legal.currentBet === 0) {
        if (action.type !== 'bet' || !legal.canBet || legal.aggressiveType !== 'bet') return false;
      } else {
        if (action.type !== 'raise' || !legal.canRaise || legal.aggressiveType !== 'raise') {
          return false;
        }
      }
      if (action.amount <= legal.currentBet) return false;
      if (action.amount > legal.maxRaiseTo) return false;
      if (action.amount < legal.minRaiseTo && action.amount !== legal.maxRaiseTo) return false;
      return true;
    }
    default:
      return false;
  }
}

export function fallbackAction(legal: LegalActions): PlayerAction {
  if (legal.canCheck) return { type: 'check' };
  if (legal.canCall) return { type: 'call' };
  return { type: 'fold' };
}

/** 最后一道安全阀：任何内部生成的动作都必须通过合法性检查。 */
function finalizeAction(action: PlayerAction, legal: LegalActions): PlayerAction {
  if (isActionLegal(action, legal)) return action;
  return fallbackAction(legal);
}

/**
 * 生成下注 / 加注动作（必要时转为 allin）。
 * 返回 null 表示当前局面没有进攻权限（如 short all-in 关闭了加注权）。
 */
function buildAggressive(legal: LegalActions, target: number): PlayerAction | null {
  if (!legal.aggressiveType) return null;
  if (!Number.isFinite(target)) return null;
  const { minRaiseTo, maxRaiseTo, currentBet } = legal;
  if (maxRaiseTo <= currentBet) return null;

  let amount = Math.round(target);
  if (amount > maxRaiseTo) amount = maxRaiseTo;
  if (amount < minRaiseTo) {
    if (maxRaiseTo < minRaiseTo) amount = maxRaiseTo; // 短全下
    else amount = minRaiseTo;
  }
  if (amount <= currentBet) return null;
  if (amount > maxRaiseTo) amount = maxRaiseTo;
  if (amount < minRaiseTo && amount !== maxRaiseTo) return null;

  if (amount === maxRaiseTo && legal.canAllIn) return { type: 'allin' };
  return { type: legal.aggressiveType, amount };
}

function targetFromFraction(view: PlayerView, legal: LegalActions, fraction: number): number {
  const pot = Math.max(view.bigBlind, view.pot);
  const base = legal.currentBet + (pot + legal.callAmount) * fraction;
  return Math.round(base);
}

function pickSize(rng: () => number, sizes: readonly number[]): number {
  if (sizes.length === 0) return 0.5;
  const index = Math.min(sizes.length - 1, Math.floor(rng() * sizes.length));
  return sizes[index];
}

function countOpponents(view: PlayerView): number {
  return view.players.filter(
    (player) =>
      player.id !== view.viewerId &&
      (player.status === 'active' || player.status === 'allin'),
  ).length;
}

function countLimpers(view: PlayerView): number {
  let count = 0;
  for (const record of view.actions) {
    if (record.street !== view.street) continue;
    if (record.action.type === 'call') count++;
  }
  return count;
}

function positionLabel(view: PlayerView): string {
  return POSITION_LABELS[positionOf(view)];
}

/* ------------------------------------------------------------------ */
/* 翻牌前                                                              */
/* ------------------------------------------------------------------ */

function openRaiseTarget(
  ctx: DecisionContext,
  profile: DifficultyProfile,
): number {
  const { view, legal, difficulty, rng } = ctx;
  const variance =
    difficulty === 'expert' ? rng() * 0.9 : difficulty === 'hard' ? rng() * 0.5 : 0;
  const limpers = countLimpers(view);
  const multiplier = profile.preflop.openRaiseBB + variance + limpers * 0.8;
  const raw = Math.round(view.bigBlind * multiplier);
  return Math.max(legal.minRaiseTo, raw, Math.round(view.bigBlind * 2));
}

function threeBetTarget(ctx: DecisionContext, profile: DifficultyProfile): number {
  const { view, legal, difficulty, rng } = ctx;
  const variance =
    difficulty === 'expert' ? rng() * 0.7 : difficulty === 'hard' ? rng() * 0.4 : 0;
  const multiplier = profile.preflop.threeBetMultiplier + variance;
  return Math.max(legal.minRaiseTo, Math.round(view.currentBet * multiplier));
}

interface PreflopResult {
  action: PlayerAction;
  reasoning: string;
}

function decidePreflop(
  ctx: DecisionContext,
  strength: number,
  key: string,
): PreflopResult {
  const { view, legal, difficulty, profile, rng } = ctx;
  const facingRaise = view.currentBet > view.bigBlind;
  const position = positionOf(view);
  const positionText = POSITION_LABELS[position];
  const thresholds = preflopThresholdsForProfile(profile, position);

  if (difficulty === 'beginner') {
    // 入门 AI：完全按起手牌强度查表，不看位置；只小额跟注，极少加注。
    const playable = strength >= profile.preflop.play;
    const premium = strength >= 0.95;
    const raiseChance = facingRaise ? 0.18 : 0.16;
    const raiseTarget = facingRaise
      ? Math.max(legal.minRaiseTo, Math.round(view.currentBet * 2.2))
      : Math.max(legal.minRaiseTo, Math.round(view.bigBlind * 2.2));
    const aggressive =
      premium && rng() < raiseChance ? buildAggressive(legal, raiseTarget) : null;

    let action: PlayerAction;
    if (aggressive) {
      action = aggressive;
    } else if (playable) {
      action = legal.canCall
        ? { type: 'call' }
        : legal.canCheck
          ? { type: 'check' }
          : { type: 'fold' };
    } else {
      action = legal.canCheck ? { type: 'check' } : { type: 'fold' };
    }

    // 小概率随机失误：把可跟的牌弃掉（入门 AI 会犯错）。
    if (
      action.type === 'call' &&
      legal.canFold &&
      rng() < profile.preflop.errorRate
    ) {
      action = { type: 'fold' };
    }

    const actionText =
      action.type === 'raise' || action.type === 'allin'
        ? '偶尔用超大牌小额加注'
        : action.type === 'call'
          ? '小额跟注'
          : action.type === 'check'
            ? '过牌'
            : '弃牌';
    const reasoning =
      `入门风格：起手牌 ${key} 强度 ${strength.toFixed(2)}，` +
      `${playable ? '达到' : '低于'}入池线 ${profile.preflop.play.toFixed(2)}；` +
      `不看位置，${actionText}。`;
    return { action, reasoning };
  }

  // normal / hard / expert：范围表 + 位置阈值 + 混合策略。
  const positionFactor =
    position === 'late' ? 1.15 : position === 'blinds' ? 0.8 : position === 'middle' ? 1 : 0.9;
  const bluffRaise =
    strength < thresholds.play &&
    rng() < profile.preflop.bluffRaiseRate * positionFactor;
  const mixRaise =
    strength >= thresholds.play &&
    strength < thresholds.raise &&
    rng() < profile.preflop.mixRaiseRate;
  const trap =
    strength >= thresholds.threeBet && rng() < profile.preflop.trapRate;
  const wantRaise = (strength >= thresholds.raise || mixRaise || bluffRaise) && !trap;

  const target = facingRaise
    ? threeBetTarget(ctx, profile)
    : openRaiseTarget(ctx, profile);
  const aggressive = wantRaise ? buildAggressive(legal, target) : null;

  let action: PlayerAction;
  if (aggressive) {
    action = aggressive;
  } else if (strength >= thresholds.play) {
    action = legal.canCall
      ? { type: 'call' }
      : legal.canCheck
        ? { type: 'check' }
        : { type: 'fold' };
  } else if (legal.canCheck) {
    action = { type: 'check' };
  } else {
    action = { type: 'fold' };
  }

  const actionText =
    action.type === 'raise' || action.type === 'allin'
      ? facingRaise
        ? '再加注'
        : '开池加注'
      : action.type === 'call'
        ? '跟注'
        : action.type === 'check'
          ? '过牌'
          : '弃牌';
  const reasonTag =
    difficulty === 'expert'
      ? '专家风格：位置与对手行动倾向加权'
      : difficulty === 'hard'
        ? '困难风格：位置范围表 + 混合频率'
        : '普通风格：位置范围表';

  const reasoning =
    `${reasonTag}：${positionText}起手牌 ${key} 强度 ${strength.toFixed(2)}；` +
    `入池线 ${thresholds.play.toFixed(2)}、加注线 ${thresholds.raise.toFixed(2)}、` +
    `3-bet 线 ${thresholds.threeBet.toFixed(2)}；` +
    `${facingRaise ? '面对加注' : '无人加注'}，${actionText}` +
    `${bluffRaise ? '（弱牌偷加注）' : mixRaise ? '（中等牌混合加注）' : trap ? '（强牌慢玩）' : ''}。`;
  return { action, reasoning };
}

/* ------------------------------------------------------------------ */
/* 翻牌后：四档独立分支                                                */
/* ------------------------------------------------------------------ */

interface PostflopResult {
  action: PlayerAction;
  reasoning: string;
}

function decideBeginnerPostflop(
  ctx: DecisionContext,
  analysis: PostflopAnalysis,
): PostflopResult {
  const { view, legal, profile, rng } = ctx;
  const strength = analysis.madeStrength;
  const callCost = legal.callAmount;
  const potFraction = callCost / Math.max(1, view.pot);
  const cheap = callCost <= view.bigBlind * 2 || potFraction <= 0.2;
  const strong = strength >= 0.72;

  let action: PlayerAction;
  let note: string;

  if (legal.canCheck) {
    if (strength >= 0.86) {
      const bet = buildAggressive(legal, targetFromFraction(view, legal, 0.33));
      if (bet && rng() < 0.22) {
        action = bet;
        note = '牌型很强，小额下注';
      } else {
        action = { type: 'check' };
        note = '没有下注压力，过牌';
      }
    } else {
      action = { type: 'check' };
      note = '牌力一般，过牌';
    }
  } else {
    const raise = strong
      ? buildAggressive(legal, targetFromFraction(view, legal, 0.33))
      : null;
    if (strong && raise && rng() < 0.05) {
      action = raise;
      note = '强牌偶尔小额加注';
    } else if (strong || strength >= 0.42 || cheap || (potFraction <= 0.5 && strength >= 0.3)) {
      action = { type: 'call' };
      note = cheap ? '跟注成本低，弱牌也跟' : '牌力够用，跟注';
    } else {
      action = { type: 'fold' };
      note = '跟注成本过高且牌力弱';
    }
  }

  if (
    action.type === 'call' &&
    legal.canFold &&
    rng() < profile.postflop.errorRate &&
    strength < 0.5
  ) {
    action = { type: 'fold' };
    note = '随机失误：放弃边缘牌';
  }

  const reasoning =
    `入门风格：当前牌型 ${analysis.categoryName}，成牌强度 ${strength.toFixed(2)}，` +
    `跟注成本 ${callCost}（底池占比 ${(potFraction * 100).toFixed(0)}%）；${note}。`;
  return { action, reasoning };
}

function decideNormalPostflop(
  ctx: DecisionContext,
  analysis: PostflopAnalysis,
): PostflopResult {
  const { view, legal, profile, rng } = ctx;
  const strength = analysis.strength;
  const required = ctx.potOdds + profile.postflop.callMargin;
  const inPosition = positionOf(view) === 'late';
  const betAction = buildAggressive(legal, targetFromFraction(view, legal, 0.5));

  let action: PlayerAction;
  let note: string;

  if (legal.canCheck) {
    if (strength >= profile.postflop.valueThreshold && betAction && rng() < 0.78) {
      action = betAction;
      note = '牌力达到价值线，半池下注';
    } else if (strength >= 0.5 && betAction && rng() < 0.42) {
      action = betAction;
      note = '中等牌力主动下注半池';
    } else if (betAction && inPosition && rng() < profile.postflop.bluffRate) {
      action = betAction;
      note = '晚位约 7% 诈唬频率';
    } else {
      action = { type: 'check' };
      note = '过牌控池';
    }
  } else {
    const raise = buildAggressive(legal, targetFromFraction(view, legal, 0.5));
    if (strength >= 0.86 && raise && rng() < 0.55) {
      action = raise;
      note = '强牌加注半池';
    } else if (strength >= required) {
      action = { type: 'call' };
      note = `牌力 ${strength.toFixed(2)} 高于所需 ${required.toFixed(2)}，跟注`;
    } else if (analysis.draw.hasDraw && ctx.potOdds <= 0.3 && rng() < 0.22) {
      action = { type: 'call' };
      note = '听牌按隐含赔率跟注';
    } else {
      action = { type: 'fold' };
      note = '牌力低于底池赔率，弃牌';
    }
  }

  const reasoning =
    `普通风格：牌型 ${analysis.categoryName}，综合强度 ${strength.toFixed(2)}，` +
    `底池赔率 ${(ctx.potOdds * 100).toFixed(1)}%，所需安全线 ${(required * 100).toFixed(1)}%；` +
    `${inPosition ? '晚位' : '非晚位'}，${note}。`;
  return { action, reasoning };
}

function decideHardPostflop(
  ctx: DecisionContext,
  analysis: PostflopAnalysis,
  equity: number,
  iterations: number,
): PostflopResult {
  const { view, legal, profile, rng } = ctx;
  const required = ctx.potOdds + profile.postflop.callMargin;
  const inPosition = positionOf(view) === 'late';
  const opponentCount = countOpponents(view);
  const semiChance = profile.postflop.semiBluffRate + (opponentCount <= 2 ? 0.08 : 0);
  const semi =
    analysis.draw.hasDraw && equity >= 0.25 && rng() < semiChance;
  const betSizes = profile.postflop.betSizes;

  let action: PlayerAction;
  let note: string;

  if (legal.canCheck) {
    const bet = buildAggressive(
      legal,
      targetFromFraction(view, legal, pickSize(rng, betSizes)),
    );
    if (equity >= 0.74 && bet) {
      action = bet;
      note = '蒙特卡洛胜率很高，价值下注';
    } else if (equity >= 0.55 && bet && rng() < 0.55) {
      action = bet;
      note = '胜率占优，主动下注';
    } else if (semi && bet) {
      action = bet;
      note = '听牌半诈唬：胜率 + 弃牌率';
    } else if (bet && inPosition && rng() < profile.postflop.bluffRate) {
      action = bet;
      note = '晚位按频率诈唬';
    } else {
      action = { type: 'check' };
      note = '胜率不足，过牌';
    }
  } else {
    const raise = buildAggressive(
      legal,
      targetFromFraction(view, legal, pickSize(rng, profile.postflop.raiseSizes)),
    );
    if (equity >= 0.78 && raise && rng() < 0.58) {
      action = raise;
      note = '胜率极高，价值加注';
    } else if (equity >= required) {
      action = { type: 'call' };
      note = `胜率 ${(equity * 100).toFixed(1)}% 高于所需 ${(required * 100).toFixed(1)}%，跟注`;
    } else if (semi && raise) {
      action = raise;
      note = '听牌半诈唬加注，利用弃牌率';
    } else if (
      analysis.draw.hasDraw &&
      equity >= Math.max(0.2, required * 0.75) &&
      rng() < 0.3
    ) {
      action = { type: 'call' };
      note = '听牌按潜在赔率跟注';
    } else {
      action = { type: 'fold' };
      note = '胜率不足，弃牌';
    }
  }

  const reasoning =
    `困难风格：${analysis.categoryName}，蒙特卡洛 ${iterations} 次胜率 ` +
    `${(equity * 100).toFixed(1)}%，底池赔率 ${(ctx.potOdds * 100).toFixed(1)}%，` +
    `${opponentCount} 名对手；${note}。`;
  return { action, reasoning };
}

function pickExpertSize(view: PlayerView, rng: () => number, strong: boolean): number {
  const sizes = DIFFICULTY_PROFILES.expert.postflop.betSizes;
  if (view.street === 'river' && strong && rng() < 0.3) {
    return sizes[sizes.length - 1];
  }
  const limit = view.street === 'river' ? sizes.length : Math.max(1, sizes.length - 1);
  const index = Math.min(limit - 1, Math.floor(rng() * limit));
  return sizes[Math.max(0, index)];
}

function multiStreetPlan(
  view: PlayerView,
  equity: number,
  analysis: PostflopAnalysis,
): string {
  if (view.street === 'flop') {
    if (equity >= 0.62) return '计划转牌继续价值下注';
    if (analysis.draw.hasDraw) return '计划转牌继续半诈唬';
    return '计划转牌按牌力收缩';
  }
  if (view.street === 'turn') {
    if (equity >= 0.65) return '计划河牌继续价值下注';
    if (analysis.draw.hasDraw) return '计划河牌看牌或半诈唬';
    return '计划河牌控池';
  }
  if (equity >= 0.8) return '河牌极化下注';
  if (equity >= 0.55) return '河牌按摊牌价值决策';
  return '河牌放弃边缘牌';
}

function decideExpertPostflop(
  ctx: DecisionContext,
  analysis: PostflopAnalysis,
  equity: number,
  iterations: number,
  reads: readonly OpponentRead[],
): PostflopResult {
  const { view, legal, profile, rng } = ctx;
  const required = ctx.potOdds + profile.postflop.callMargin;
  const spr = view.self.stack / Math.max(1, view.pot);
  const inPosition = positionOf(view) === 'late';
  const opponentCount = countOpponents(view);
  const totalRaises = reads.reduce((sum, read) => sum + read.raises, 0);
  const totalCalls = reads.reduce((sum, read) => sum + read.calls, 0);
  const semiChance = profile.postflop.semiBluffRate + (opponentCount <= 2 ? 0.1 : 0);
  const semi =
    analysis.draw.hasDraw && equity >= 0.28 && rng() < semiChance;
  const plan = multiStreetPlan(view, equity, analysis);

  let action: PlayerAction;
  let note: string;

  if (legal.canCheck) {
    const size = pickExpertSize(view, rng, equity >= 0.7);
    const bet = buildAggressive(legal, targetFromFraction(view, legal, size));
    if (equity >= 0.78) {
      if (spr <= 2.5 && legal.canAllIn && legal.maxRaiseTo > legal.currentBet) {
        action = { type: 'allin' };
        note = 'SPR 很低且胜率极高，直接全下';
      } else if (bet) {
        action = bet;
        note = '高胜率价值下注（多尺度）';
      } else {
        action = { type: 'check' };
        note = '无法下注，过牌';
      }
    } else if (equity >= profile.postflop.valueThreshold && bet && rng() < 0.7) {
      action = bet;
      note = '胜率超过价值线，混合尺度下注';
    } else if (semi && bet) {
      action = bet;
      note = '听牌半诈唬，兼顾弃牌率';
    } else if (
      bet &&
      rng() <
        profile.postflop.bluffRate * (inPosition ? 1.2 : 0.7)
    ) {
      action = bet;
      note = inPosition ? '晚位极化诈唬' : '按平衡频率诈唬';
    } else {
      action = { type: 'check' };
      note = '过牌，保留摊牌价值';
    }
  } else {
    const raise = buildAggressive(
      legal,
      targetFromFraction(view, legal, pickExpertSize(view, rng, equity >= 0.7)),
    );
    if (
      (equity >= 0.82 || (spr <= 2 && equity >= 0.6)) &&
      legal.canAllIn &&
      (spr <= 3 || equity >= 0.88)
    ) {
      action = { type: 'allin' };
      note = '低 SPR + 高胜率，全下施压';
    } else if ((equity >= 0.82 || (spr <= 2 && equity >= 0.6)) && raise) {
      action = raise;
      note = '高胜率加注，做大底池';
    } else if (equity >= 0.66 && raise && rng() < 0.48) {
      action = raise;
      note = '强牌混合加注，保持价值/诈唬平衡';
    } else if (equity >= required) {
      action = { type: 'call' };
      note = `胜率 ${(equity * 100).toFixed(1)}% 高于安全线 ${(required * 100).toFixed(1)}%，跟注`;
    } else if (semi && raise && rng() < 0.35) {
      action = raise;
      note = '半诈唬加注，利用范围优势';
    } else {
      action = { type: 'fold' };
      note = '胜率低于安全线，弃牌';
    }
  }

  const reasoning =
    `专家风格：${analysis.categoryName}，范围收窄后蒙特卡洛 ${iterations} 次胜率 ` +
    `${(equity * 100).toFixed(1)}%，底池赔率 ${(ctx.potOdds * 100).toFixed(1)}%，` +
    `SPR ${spr.toFixed(2)}；对手 ${opponentCount} 人（加注 ${totalRaises} 次 / 跟注 ${totalCalls} 次）；` +
    `${note}；${plan}。`;
  return { action, reasoning };
}

/* ------------------------------------------------------------------ */
/* expert：基于行动历史的简化范围收窄                                  */
/* ------------------------------------------------------------------ */

function buildOpponentReads(view: PlayerView): OpponentRead[] {
  const reads: OpponentRead[] = [];
  for (const player of view.players) {
    if (player.id === view.viewerId) continue;
    if (player.status !== 'active' && player.status !== 'allin') continue;
    let raises = 0;
    let calls = 0;
    let checks = 0;
    for (const record of view.actions) {
      if (record.actorId !== player.id) continue;
      switch (record.action.type) {
        case 'bet':
        case 'raise':
        case 'allin':
          raises++;
          break;
        case 'call':
          calls++;
          break;
        case 'check':
          checks++;
          break;
        default:
          break;
      }
    }

    let range: RangeWeight | null = null;
    if (raises > 0) {
      // 加注越多 → 越偏向强范围（拒绝采样时弱牌接受率极低）。
      const exponent = 1.15 + Math.min(3, raises) * 0.18;
      range = (first, second) => {
        const strength = preflopStrengthOf(first, second);
        return Math.min(1, 0.03 + Math.pow(strength, exponent) * 1.15);
      };
    } else if (calls > 0) {
      // 跟注多 → 偏向中等范围（两端权重低）。
      const center = 0.5 + Math.min(0.15, calls * 0.02);
      range = (first, second) => {
        const strength = preflopStrengthOf(first, second);
        const distance = Math.abs(strength - center);
        return Math.max(0.08, 1 - distance * 2.4);
      };
    }
    reads.push({ playerId: player.id, raises, calls, checks, range });
  }
  return reads;
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

function resolveIterations(
  profile: DifficultyProfile,
  options: AIDecisionOptions,
): number {
  const base = profile.postflop.mcIterations;
  if (base <= 0) return 0;
  if (options.maxIterations === undefined) return base;
  const requested = Math.floor(options.maxIterations);
  if (!Number.isFinite(requested)) return base;
  return Math.max(1, Math.min(base, requested));
}

/**
 * 做出一次决策。
 * @throws Error('当前不是该玩家的行动回合') 当 view.legal 为 null。
 */
export async function decide(
  view: PlayerView,
  difficulty: Difficulty,
  options: AIDecisionOptions = {},
): Promise<AIDecision> {
  const legal = view.legal;
  if (!legal) throw new Error('当前不是该玩家的行动回合');

  const profile = options.profileOverride ?? getDifficultyProfile(difficulty);
  const rng = mulberry32(hashString(`${view.seed}#${difficulty}#${view.actions.length}`));
  const potOdds = potOddsOf(view, legal);
  const ctx: DecisionContext = {
    view,
    legal,
    difficulty,
    profile,
    rng,
    potOdds,
  };

  let action: PlayerAction;
  let reasoning: string;
  let handCategory: string;
  let equity: number | undefined;
  let iterations: number | undefined;

  const isPreflop = view.street === 'preflop' || view.board.length < 3;
  if (isPreflop) {
    const strength = preflopStrength(view.self.holeCards);
    const key = handKey(view.self.holeCards);
    const result = decidePreflop(ctx, strength, key);
    action = result.action;
    reasoning = result.reasoning;
    handCategory = `起手牌 ${key}`;
  } else {
    const analysis = analyzePostflop(view.self.holeCards, view.board);
    handCategory = analysis.categoryName;

    let result: PostflopResult;
    if (difficulty === 'beginner') {
      result = decideBeginnerPostflop(ctx, analysis);
    } else if (difficulty === 'normal') {
      result = decideNormalPostflop(ctx, analysis);
    } else {
      const rounds = resolveIterations(profile, options);
      let reads: OpponentRead[] = [];
      const equityOptions =
        difficulty === 'expert' && rounds > 0
          ? (() => {
              reads = buildOpponentReads(view);
              return {
                ranges: reads.map((read) => read.range),
                maxRangeAttempts: 8,
              };
            })()
          : undefined;
      const equityResult = await estimateEquity(view, rounds, rng, equityOptions);
      equity = equityResult.equity;
      iterations = equityResult.iterations;
      if (difficulty === 'hard') {
        result = decideHardPostflop(ctx, analysis, equity, iterations);
      } else {
        if (reads.length === 0) reads = buildOpponentReads(view);
        result = decideExpertPostflop(ctx, analysis, equity, iterations, reads);
      }
    }
    action = result.action;
    reasoning = result.reasoning;
  }

  const safeAction = finalizeAction(action, legal);
  return {
    action: safeAction,
    debug: {
      difficulty,
      profile: profile.style,
      equity,
      potOdds,
      handCategory,
      iterations,
      reasoning,
    },
  };
}
