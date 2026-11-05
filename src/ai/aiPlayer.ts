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
 *   derivedRng(view.seed, difficulty, actions.length, styleId)
 * 绝不使用 Math.random。
 */
import type { Difficulty, LegalActions, PlayerAction } from '../game/types';
import type { PlayerView } from '../game/playerView';
import { derivedRng } from '../game/cards';
import {
  DIFFICULTY_PROFILES,
  getChallengeProfile,
  getDifficultyProfile,
  type DifficultyProfile,
} from './difficulty';
import { gtoBoundaryAdjust, gtoClosenessFor, gtoEvSizeChoice } from './gto';
import { gtoPushFoldAdvice } from './gtoAdvice';
import { depthLimitedSearch, estimateActionEv } from './search';
import { solveRiverEndgame } from './riverSolver';
import {
  applyChallengeVariant,
  buildChallengeRanges,
  challengeArchetype,
  challengeArchetypeLabel,
  challengeFoldEquity,
  chooseChallengeSize,
  chooseTimingHint,
  rangesForView,
  readBettingTells,
  readTimingTells,
  timingHintLabel,
  type OpponentBettingTell,
  type OpponentTimingTell,
  type TimingHint,
} from './challenge';
import {
  applyStyleVariant,
  sampleSizeIndex,
  styleLabel,
  variationRateFor,
} from './style';
import {
  applyExploitation,
  applyMoodToProfile,
  chooseEvBetFraction,
  humanMistakeRate,
  moodLabel,
  summarizeOpponents,
  type OpponentSummary,
} from './humanModel';
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
  type PreflopThresholds,
} from './rangeModel';

export interface AIDecisionOptions {
  /** 测试 / 降载用：限制蒙特卡洛模拟次数（取 min(默认值, maxIterations)）。 */
  maxIterations?: number;
  /**
   * 挑战模式（宗师 AI）：使用挑战档 profile + 宗师原型 + 读下注细节 / 思考时间。
   * 训练 / 对照评估时忽略（profileOverride 优先）。
   */
  challenge?: boolean;
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
  /** 挑战模式的计时伪装策略（调试用）。 */
  timing?: string;
  /** 挑战模式的宗师原型名称。 */
  archetype?: string;
}

export interface AIDecision {
  action: PlayerAction;
  /** 挑战模式：建议 UI 用的思考时间伪装（fast / normal / slow）。 */
  timingHint?: TimingHint;
  debug: AIDebugInfo;
}

interface DecisionContext {
  view: PlayerView;
  legal: LegalActions;
  difficulty: Difficulty;
  profile: DifficultyProfile;
  rng: () => number;
  potOdds: number;
  /** 当前情绪（-2 上头 .. +2 自信，0 平稳）。 */
  mood: number;
  /** 跨手对手公开统计汇总（困难 / 专家据此调整策略）。 */
  opponents: OpponentSummary;
  /** 挑战模式（宗师 AI）。 */
  challenge: boolean;
  /** GTO / 均衡接近度 0..1（难度越高越接近均衡策略）。 */
  closeness: number;
  /** 挑战模式的宗师原型 id。 */
  archetypeId?: number;
  /** 当前手读到的对手思考时间（挑战模式）。 */
  timingTells: OpponentTimingTell[];
  /** 当前手读到的对手下注细节（挑战模式）。 */
  bettingTells: OpponentBettingTell[];
  /** 风格原型 id（体验随机层；undefined 时不施加风格）。 */
  styleId?: number;
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

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

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

function pickSize(rng: () => number, sizes: readonly number[], styleId?: number): number {
  if (sizes.length === 0) return 0.5;
  return sizes[sampleSizeIndex(rng, sizes, styleId)] ?? sizes[0];
}

/**
 * 真人化：有对手统计样本时，按「fold-equity 近似 EV」挑下注尺度；
 * 没样本时仍按风格偏好随机挑尺度（保持种子可复现）。
 */
function pickBetFraction(
  ctx: DecisionContext,
  equity: number,
  fractions: readonly number[],
): number {
  const { view, legal, rng, opponents } = ctx;
  if (opponents.count > 0 && opponents.confidence > 0 && fractions.length > 0) {
    const choice = chooseEvBetFraction({
      fractions,
      pot: view.pot,
      equity,
      currentBet: legal.currentBet,
      legal,
      foldToBetRate: opponents.avgFoldToBet,
      opponentCount: countOpponents(view),
    });
    if (choice) return choice.fraction;
  }
  return pickSize(rng, fractions, ctx.styleId);
}

function isAggressiveActionType(type: PlayerAction['type']): boolean {
  return type === 'bet' || type === 'raise' || type === 'allin';
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

/** 本街已经出现的进攻动作次数（用于翻牌前面对加注时收紧范围）。 */
function countRaisesThisStreet(view: PlayerView): number {
  let count = 0;
  for (const record of view.actions) {
    if (record.street !== view.street) continue;
    const type = record.action.type;
    if (type === 'bet' || type === 'raise' || type === 'allin') count++;
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

  // GTO 短码单挑：用抽象 CFR 的 push/fold 均衡解指导全下 / 跟注（接近度越高越常用）。
  if (ctx.closeness >= 0.1) {
    const advice = gtoPushFoldAdvice(view);
    if (advice && rng() < ctx.closeness) {
      const takeChart = rng() < advice.frequency;
      if (takeChart) {
        if (advice.action === 'push' && legal.canAllIn) {
          return {
            action: { type: 'allin' },
            reasoning: `${advice.note}；按均衡频率选择全下。`,
          };
        }
        if (advice.action === 'call' && legal.canCall) {
          return {
            action: { type: 'call' },
            reasoning: `${advice.note}；按均衡频率选择跟注。`,
          };
        }
        if (advice.action === 'fold' && legal.canFold) {
          return {
            action: { type: 'fold' },
            reasoning: `${advice.note}；按均衡频率选择弃牌。`,
          };
        }
      }
    }
  }
  const positionText = POSITION_LABELS[position];
  // 真人化：面对 3-bet / 多人加注时收紧范围；晚位对多人溜入便宜看牌时小幅放宽。
  const baseThresholds = preflopThresholdsForProfile(profile, position);
  const raiseCount = countRaisesThisStreet(view);
  const tighten = facingRaise
    ? Math.min(0.2, 0.05 + Math.max(0, raiseCount - 1) * 0.045)
    : 0;
  const limpers = countLimpers(view);
  const loosen = !facingRaise && limpers >= 2 && position === 'late' ? 0.03 : 0;
  const thresholds: PreflopThresholds =
    tighten === 0 && loosen === 0
      ? baseThresholds
      : {
          play: clamp01(baseThresholds.play + tighten - loosen),
          raise: clamp01(
            Math.max(baseThresholds.play + tighten - loosen, baseThresholds.raise + tighten),
          ),
          threeBet: clamp01(
            Math.max(baseThresholds.raise + tighten, baseThresholds.threeBet + tighten),
          ),
        };

  if (difficulty === 'beginner' && !ctx.challenge) {
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
  const reasonTag = ctx.challenge
    ? '挑战宗师：位置 / 范围 / 读人后决策'
    : difficulty === 'expert'
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
      targetFromFraction(view, legal, pickBetFraction(ctx, equity, betSizes)),
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
      targetFromFraction(view, legal, pickBetFraction(ctx, equity, profile.postflop.raiseSizes)),
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

function pickExpertBetFraction(ctx: DecisionContext, equity: number): number {
  const { view, rng } = ctx;
  const sizes = DIFFICULTY_PROFILES.expert.postflop.betSizes;
  if (view.street === 'river' && equity >= 0.7 && rng() < 0.3) {
    return sizes[sizes.length - 1];
  }
  const limit = view.street === 'river' ? sizes.length : Math.max(1, sizes.length - 1);
  return pickBetFraction(ctx, equity, sizes.slice(0, limit));
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
    const size = pickExpertBetFraction(ctx, equity);
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
      targetFromFraction(view, legal, pickExpertBetFraction(ctx, equity)),
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
/* 挑战模式：读下注 / 计时 + 范围建模 + EV 极化施压                     */
/* ------------------------------------------------------------------ */

/** 汇总当前手的「对手偏弱」信号（快速过牌 / 小注封锁等公开信息）。 */
function opponentWeakSignals(ctx: DecisionContext): { weak: boolean; note: string } {
  const timingWeak = ctx.timingTells.find(
    (tell) => tell.tell === 'fast' && tell.context === 'passive' && tell.confidence >= 0.45,
  );
  const bettingWeak = ctx.bettingTells.find(
    (tell) => tell.smallBetRate >= 0.55 && tell.bigBetRate === 0 && tell.aggressiveActions >= 1,
  );
  const parts: string[] = [];
  if (timingWeak) parts.push(`${timingWeak.playerName} 快速过牌 / 跟注（偏弱）`);
  if (bettingWeak) parts.push(`${bettingWeak.playerName} 小注偏多（偏弱 / 封锁）`);
  return { weak: parts.length > 0, note: parts.join('；') };
}

function decideChallengePostflop(
  ctx: DecisionContext,
  analysis: PostflopAnalysis,
  equity: number,
  iterations: number,
): PostflopResult {
  const { view, legal, profile, rng, opponents } = ctx;
  const archetype = challengeArchetype(ctx.archetypeId);
  const post = profile.postflop;
  const spr = view.self.stack / Math.max(1, view.pot);
  const inPosition = positionOf(view) === 'late';
  const opponentCount = countOpponents(view);
  const weakSignals = opponentWeakSignals(ctx);

  // 读最后一条主动动作的计时：长考后下注 → 两极，多抓诈；秒打 → 偏价值，收紧跟注。
  const lastAggressive = [...view.actions]
    .reverse()
    .find((record) => isAggressiveActionType(record.action.type));
  const aggressorTiming = lastAggressive
    ? ctx.timingTells.find((tell) => tell.playerId === lastAggressive.actorId)
    : undefined;
  let required = ctx.potOdds + post.callMargin;
  if (aggressorTiming && aggressorTiming.confidence >= 0.4) {
    if (aggressorTiming.tell === 'slow' && aggressorTiming.context === 'aggressive') {
      required -= 0.03 * aggressorTiming.confidence;
    } else if (aggressorTiming.tell === 'fast' && aggressorTiming.context === 'aggressive') {
      required += 0.025 * aggressorTiming.confidence;
    }
  }
  required = Math.max(0.05, Math.min(0.9, required));

  // 对手越爱跟注 → 价值线越薄；越紧 → 越标准。
  const valueThreshold = Math.max(
    0.5,
    Math.min(0.92, post.valueThreshold + (opponents.avgVpip !== null && opponents.avgVpip > 0.55 ? -0.04 : 0)),
  );
  const foldEquity = challengeFoldEquity(opponents, opponentCount, 0.75, aggressorTiming?.tell);
  const semi =
    analysis.draw.hasDraw &&
    equity >= 0.25 &&
    rng() < post.semiBluffRate * (0.85 + archetype.aggression * 0.2);
  const bluffChance = Math.min(
    0.6,
    post.bluffRate *
      archetype.aggression *
      (weakSignals.weak ? 1.5 : 1) *
      (foldEquity >= 0.5 ? 1.2 : 0.85),
  );
  const pureBluff =
    rng() < bluffChance &&
    opponentCount >= 1 &&
    (inPosition || opponentCount <= 2 || weakSignals.weak);
  const monster = equity >= 0.85;
  const strong = equity >= valueThreshold;
  const trapSlowplay =
    strong && rng() < profile.preflop.trapRate * archetype.trap * (view.street === 'flop' ? 0.8 : 0.45);

  const sizeChoice = (raise: boolean, isBluff: boolean) => {
    const baseFractions = raise ? post.raiseSizes : post.betSizes;
    const scaledFractions = baseFractions.map((fraction) =>
      Math.max(0.15, Math.min(2, fraction * archetype.sizing)),
    );
    const base = chooseChallengeSize({
      fractions: baseFractions,
      pot: view.pot,
      equity,
      currentBet: legal.currentBet,
      callAmount: legal.callAmount,
      legal,
      foldToBetRate: opponents.avgFoldToBet,
      opponentCount,
      street: view.street,
      archetypeId: ctx.archetypeId,
      isBluff,
    });
    const gto = gtoEvSizeChoice({
      fractions: scaledFractions,
      pot: view.pot,
      equity,
      currentBet: legal.currentBet,
      callAmount: legal.callAmount,
      legal,
      foldToBetRate: opponents.avgFoldToBet,
      opponentCount,
      closeness: ctx.closeness,
      rng,
    });
    if (rng() < ctx.closeness) {
      return { fraction: gto.fraction, ev: base.ev, note: gto.note || base.note };
    }
    return base;
  };

  let action: PlayerAction;
  let note: string;

  if (legal.canCheck) {
    const valueFraction = sizeChoice(false, false).fraction;
    const bluffFraction = sizeChoice(false, true).fraction;
    const valueBet = buildAggressive(legal, targetFromFraction(view, legal, valueFraction));
    const bluffBet = buildAggressive(legal, targetFromFraction(view, legal, bluffFraction));
    if (trapSlowplay) {
      action = { type: 'check' };
      note = '陷阱：强牌慢玩，诱导下一条街';
    } else if (valueBet && (strong ? rng() < 0.82 : false)) {
      if (monster && spr <= 2.2 && legal.canAllIn) {
        action = { type: 'allin' };
        note = '低 SPR + 极高胜率：直接全下施压';
      } else {
        action = valueBet;
        note = sizeChoice(false, false).note + '价值下注';
      }
    } else if (bluffBet && semi && rng() < 0.75) {
      action = bluffBet;
      note = '听牌半诈唬：胜率 + 弃牌率';
    } else if (bluffBet && pureBluff) {
      action = bluffBet;
      note =
        '读弱点强施压 / 纯诈唬' +
        (weakSignals.note ? '（' + weakSignals.note + '）' : '（范围劣势下抢池）');
    } else {
      action = { type: 'check' };
      note = '过牌控池，保留摊牌价值';
    }
  } else {
    const valueRaiseTarget = sizeChoice(true, false).fraction;
    const bluffRaiseTarget = sizeChoice(true, true).fraction;
    const valueRaise = buildAggressive(legal, targetFromFraction(view, legal, valueRaiseTarget));
    const bluffRaise = buildAggressive(legal, targetFromFraction(view, legal, bluffRaiseTarget));
    if (monster || (spr <= 2 && equity >= 0.66)) {
      if (legal.canAllIn && (spr <= 3 || equity >= 0.9)) {
        action = { type: 'allin' };
        note = '低 SPR + 强牌：全下最大化价值';
      } else if (valueRaise) {
        action = valueRaise;
        note = '强牌加注，做大底池';
      } else {
        action = { type: 'call' };
        note = '强牌无法加注，跟注';
      }
    } else if (strong && valueRaise && rng() < 0.55) {
      action = valueRaise;
      note = '价值加注，做大底池';
    } else if (equity >= required) {
      if (
        aggressorTiming?.tell === 'slow' &&
        aggressorTiming.context === 'aggressive' &&
        valueRaise &&
        rng() < 0.35
      ) {
        action = valueRaise;
        note = '读长考：对手偏两极，选择加注反制';
      } else {
        action = { type: 'call' };
        note = '胜率高于必要线，跟注';
      }
    } else if (semi && foldEquity >= 0.42 && bluffRaise) {
      action = bluffRaise;
      note = '半诈唬加注，利用弃牌率';
    } else if (pureBluff && foldEquity >= 0.55 && bluffRaise && rng() < 0.6) {
      action = bluffRaise;
      note = '读弱点强力诈唬加注';
    } else if (equity >= required - 0.08 && weakSignals.weak && rng() < 0.5) {
      action = { type: 'call' };
      note = '抓诈：读对手弱信号跟注';
    } else {
      action = { type: 'fold' };
      note = '胜率低于安全线，弃牌';
    }
  }

  // 深度受限搜索（借鉴 DeepStack / Pluribus 的轻量版）：比较一步 EV，按接近度概率采用更优动作。
  if (ctx.closeness >= 0.2) {
    const searched = depthLimitedSearch({
      view,
      legal,
      equity,
      opponentCount,
      foldToBetRate: opponents.avgFoldToBet,
      timingWeak: weakSignals.weak,
      closeness: ctx.closeness,
    });
    if (searched.length > 0 && rng() < ctx.closeness * 0.65) {
      const heuristicEv = estimateActionEv({
        action,
        view,
        legal,
        equity,
        opponentCount,
        foldToBetRate: opponents.avgFoldToBet,
      });
      const best = searched[0];
      if (heuristicEv === null || best.ev > heuristicEv + Math.max(1, view.pot) * 0.04) {
        action = best.action;
        note = note + '；深度受限搜索：选择' + best.label;
      }
    }
  }

  const timingText =
    ctx.timingTells.length > 0
      ? ctx.timingTells
          .slice(0, 2)
          .map((tell) => tell.playerName + '：' + tell.note)
          .join('；')
      : '无计时样本';
  const bettingText =
    ctx.bettingTells.length > 0
      ? ctx.bettingTells
          .slice(0, 2)
          .map((tell) => tell.playerName + '：' + tell.note)
          .join('；')
      : '无尺度样本';
  const reasoning =
    `挑战（${archetype.label}）：${analysis.categoryName}，范围建模 + 读人后 MC ${iterations} 次胜率 ` +
    `${(equity * 100).toFixed(1)}%，必要胜率 ${(required * 100).toFixed(1)}%，SPR ${spr.toFixed(2)}；` +
    `读计时：${timingText}；读尺度：${bettingText}；${note}。`;
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

    const stats = player.stats;
    let range: RangeWeight | null = null;
    if (raises > 0) {
      // 加注越多 → 越偏向强范围（拒绝采样时弱牌接受率极低）。
      let exponent = 1.15 + Math.min(3, raises) * 0.18;
      if (stats && stats.hands > 0) {
        // 公开统计：越松 / 越爱主动加注，其加注范围越宽；越紧越窄。
        exponent -= (stats.vpipRate - 0.4) * 0.5;
        exponent -= (stats.pfrRate - 0.15) * 0.6;
        exponent = Math.max(0.7, Math.min(3.2, exponent));
      }
      range = (first, second) => {
        const strength = preflopStrengthOf(first, second);
        return Math.min(1, 0.03 + Math.pow(strength, exponent) * 1.15);
      };
    } else if (calls > 0) {
      // 跟注多 → 偏向中等范围（两端权重低）；松玩家的跟注范围更宽。
      let center = 0.5 + Math.min(0.15, calls * 0.02);
      if (stats && stats.hands > 0) {
        center = Math.max(0.35, Math.min(0.7, center + (stats.vpipRate - 0.4) * 0.25));
      }
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

/**
 * 体验随机：在基础决策之上做小幅、合法的随机化。
 * 只在风格概率触发时生效，且所有动作仍经过合法性检查；不会替代基础胜率 / 赔率逻辑。
 */
function maybeStyleVariation(
  ctx: DecisionContext,
  action: PlayerAction,
  reference: number | undefined,
): { action: PlayerAction; note: string } | null {
  const { view, legal, profile, rng, difficulty, styleId } = ctx;
  const rate = variationRateFor(styleId, difficulty);
  if (rate <= 0 || rng() >= rate) return null;
  if (view.board.length < 3) return null;

  // 1) 进攻动作随机换一个合法尺度（真人也会偶尔调整下注大小）。
  if ((action.type === 'bet' || action.type === 'raise') && legal.aggressiveType) {
    const fractions =
      action.type === 'bet' ? profile.postflop.betSizes : profile.postflop.raiseSizes;
    const baseFraction = fractions[0] ?? 0.5;
    const candidateFractions =
      fractions.length > 1
        ? fractions
        : [baseFraction * (rng() < 0.5 ? 0.6 : 1.6)];
    const fraction = candidateFractions[sampleSizeIndex(rng, candidateFractions, styleId)] ??
      candidateFractions[0];
    const alt = buildAggressive(legal, targetFromFraction(view, legal, fraction));
    if (alt && JSON.stringify(alt) !== JSON.stringify(action)) {
      return { action: alt, note: '（风格随机化：调整了下注尺度）' };
    }
  }

  if (reference === undefined) return null;
  const required = ctx.potOdds + profile.postflop.callMargin;

  // 2) 牌力接近临界值时，在跟注 / 弃牌之间随机化（避免永远同一选择）。
  if (Math.abs(reference - required) <= 0.03) {
    if (action.type === 'call' && legal.canFold && rng() < 0.5) {
      return { action: { type: 'fold' }, note: '（边缘牌随机弃牌）' };
    }
    if (action.type === 'fold' && legal.canCall && rng() < 0.5) {
      return { action: { type: 'call' }, note: '（边缘牌随机跟注）' };
    }
  }

  // 3) 强牌偶尔慢玩（过牌），弱牌偶尔抢下底池（小额下注）。
  if (reference >= 0.72 && action.type !== 'check' && legal.canCheck && rng() < 0.3) {
    return { action: { type: 'check' }, note: '（强牌随机慢玩）' };
  }
  if (reference <= 0.26 && action.type === 'check' && legal.canBet) {
    const fractions = profile.postflop.betSizes;
    const fraction = fractions[sampleSizeIndex(rng, fractions, styleId)] ?? fractions[0] ?? 0.5;
    const alt = buildAggressive(legal, targetFromFraction(view, legal, fraction));
    if (alt) return { action: alt, note: '（弱牌随机诈唬）' };
  }
  return null;
}

/**
 * 真人化失误层：按难度 + 情绪以低概率做出「不够最优但像真人」的动作。
 * 入门概率最高（约 1/5），专家最低（约 1/100）；所有动作仍经合法性检查。
 * 导出仅供测试 / 调试使用。
 */
export function maybeHumanMistake(
  ctx: DecisionContext,
  action: PlayerAction,
  reference: number | undefined,
  hasDraw: boolean,
): { action: PlayerAction; note: string } | null {
  const { view, legal, difficulty, rng } = ctx;
  if (view.board.length < 3) return null;
  const rate = humanMistakeRate(difficulty, ctx.mood);
  if (rate <= 0 || rng() >= rate) return null;
  const cost = legal.callAmount;
  const potFraction = cost / Math.max(1, view.pot);

  // 1) 小注忍不住跟（粘性 / 好奇心）：入门、普通最常见。
  if (action.type === 'fold' && legal.canCall) {
    const sticky = cost > 0 && (cost <= view.bigBlind * 2 || potFraction <= 0.18);
    if (sticky && (difficulty === 'beginner' || difficulty === 'normal')) {
      return { action: { type: 'call' }, note: '（真人式失误：小注忍不住跟注）' };
    }
    if (hasDraw && potFraction <= 0.35) {
      return { action: { type: 'call' }, note: '（真人式失误：追听牌没算赔率）' };
    }
    if (
      (difficulty === 'hard' || difficulty === 'expert') &&
      reference !== undefined &&
      reference >= 0.3 &&
      reference <= 0.44 &&
      potFraction <= 0.45
    ) {
      return { action: { type: 'call' }, note: '（真人式失误：忍不住抓诈）' };
    }
  }

  // 2) 该价值下注时手软过牌（入门 / 普通）。
  if (
    (action.type === 'bet' || action.type === 'raise') &&
    legal.canCheck &&
    (difficulty === 'beginner' || difficulty === 'normal')
  ) {
    return { action: { type: 'check' }, note: '（真人式失误：错过价值下注）' };
  }

  // 3) 被大注吓退：边缘牌面对大注弃牌（入门 / 普通更常见）。
  if (
    action.type === 'call' &&
    legal.canFold &&
    potFraction >= 0.55 &&
    reference !== undefined &&
    reference < 0.55 &&
    (difficulty === 'beginner' || difficulty === 'normal' || rng() < 0.5)
  ) {
    return { action: { type: 'fold' }, note: '（真人式失误：被大注吓退）' };
  }

  // 4) 上头乱加注：负情绪时偶尔用弱牌打大底池。
  if (
    ctx.mood <= -0.8 &&
    (action.type === 'check' || action.type === 'call') &&
    (legal.canBet || legal.canRaise) &&
    reference !== undefined &&
    reference < 0.45 &&
    rng() < 0.45
  ) {
    const target = buildAggressive(legal, targetFromFraction(view, legal, 0.8));
    if (target) {
      return { action: target, note: '（真人式失误：上头乱加注）' };
    }
  }

  // 3) 强牌慢玩过头（入门）。
  if (
    difficulty === 'beginner' &&
    reference !== undefined &&
    reference >= 0.75 &&
    legal.canCheck &&
    action.type !== 'check'
  ) {
    return { action: { type: 'check' }, note: '（真人式失误：强牌慢玩过头）' };
  }
  return null;
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

  // 挑战模式：训练 / 对照评估（profileOverride）时关闭，保证训练语义不变。
  const challenge = options.challenge === true && !options.profileOverride;
  const baseProfile =
    options.profileOverride ?? (challenge ? getChallengeProfile() : getDifficultyProfile(difficulty));
  const styleId = view.self.styleId;
  const mood = options.profileOverride ? 0 : (view.self.mood ?? 0);
  const opponents = summarizeOpponents(view);
  // profileOverride 用于训练 / 对照评估：保持参数原样，不叠加风格 / 情绪 / 读人层。
  let profile = options.profileOverride
    ? baseProfile
    : applyStyleVariant(baseProfile, styleId);
  if (!options.profileOverride) {
    const layerDifficulty: Difficulty = challenge ? 'expert' : difficulty;
    profile = applyMoodToProfile(profile, mood, layerDifficulty);
    profile = applyExploitation(profile, opponents, layerDifficulty);
    if (challenge) profile = applyChallengeVariant(profile, view.self.challengeArchetypeId);
  }
  const rng = derivedRng(
    view.seed,
    difficulty,
    view.actions.length,
    styleId ?? 0,
    challenge ? 1 : 0,
  );
  const closeness = options.profileOverride ? 0 : gtoClosenessFor(difficulty, challenge);
  const potOdds = potOddsOf(view, legal);
  const archetypeId = challenge ? view.self.challengeArchetypeId : undefined;
  const timingTells = challenge ? readTimingTells(view) : [];
  const bettingTells = challenge ? readBettingTells(view) : [];
  const ctx: DecisionContext = {
    view,
    legal,
    difficulty,
    profile,
    rng,
    potOdds,
    mood,
    opponents,
    challenge,
    closeness,
    archetypeId,
    timingTells,
    bettingTells,
    styleId: options.profileOverride ? undefined : styleId,
  };

  let action: PlayerAction;
  let reasoning: string;
  let handCategory: string;
  let equity: number | undefined;
  let iterations: number | undefined;
  let variationReference: number | undefined;
  let analysisHasDraw = false;

  const isPreflop = view.street === 'preflop' || view.board.length < 3;
  if (isPreflop) {
    const strength = preflopStrength(view.self.holeCards);
    const key = handKey(view.self.holeCards);
    const result = decidePreflop(ctx, strength, key);
    action = result.action;
    reasoning = challenge
      ? '挑战（' + challengeArchetypeLabel(archetypeId) + '）：' + result.reasoning
      : result.reasoning;
    handCategory = `起手牌 ${key}`;
  } else {
    const analysis = analyzePostflop(view.self.holeCards, view.board);
    handCategory = analysis.categoryName;
    variationReference = analysis.strength;
    analysisHasDraw = analysis.draw.hasDraw;

    let result: PostflopResult;
    if (challenge) {
      const rounds = resolveIterations(profile, options);
      const rangeModel = buildChallengeRanges(view, timingTells, bettingTells);
      const ranges = rounds > 0 ? rangesForView(view, rangeModel) : [];
      const equityResult = await estimateEquity(
        view,
        rounds,
        rng,
        rounds > 0 ? { ranges, maxRangeAttempts: 10 } : undefined,
      );
      equity = equityResult.equity;
      iterations = equityResult.iterations;
      variationReference = equity;
      result = decideChallengePostflop(ctx, analysis, equity, iterations);
    } else if (difficulty === 'beginner') {
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
      variationReference = equity;
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

  // GTO 近似层：在底池赔率临界做均衡混合，并补足一定比例的平衡诈唬。
  if (!isPreflop && !options.profileOverride && ctx.closeness >= 0.2) {
    const adjusted = gtoBoundaryAdjust({
      action,
      equity: variationReference ?? 0.5,
      potOdds,
      legal,
      closeness: ctx.closeness,
      rng,
    });
    if (adjusted) {
      action = adjusted.action;
      reasoning = reasoning + adjusted.note;
    }
    if (
      action.type === 'check' &&
      legal.canBet &&
      (variationReference ?? 1) < 0.32 &&
      rng() < ctx.closeness * 0.12
    ) {
      const fraction = ctx.profile.postflop.betSizes[0] ?? 0.5;
      const bluffBet = buildAggressive(
        legal,
        targetFromFraction(view, legal, Math.max(0.15, Math.min(1, fraction))),
      );
      if (bluffBet) {
        action = bluffBet;
        reasoning = reasoning + '（GTO 平衡诈唬候选：按均衡比例补足诈唬组合）';
      }
    }
  }

  // B2：河牌子博弈求解（Libratus/DeepStack endgame 轻量版）：按均衡频率混合下注 / 跟注。
  if (challenge && !isPreflop && view.street === "river" && ctx.closeness >= 0.5) {
    const solver = solveRiverEndgame(view, {
      mode: legal.canCheck ? "bet" : "call",
      iterations: 160,
      maxCombos: 8,
    });
    if (solver && rng() < ctx.closeness) {
      if (solver.mode === "bet" && legal.canCheck) {
        const betHalf = solver.frequencies.betHalf ?? 0;
        const betPot = solver.frequencies.betPot ?? 0;
        const roll = rng();
        const fraction = roll < betHalf ? 0.5 : roll < betHalf + betPot ? 1 : null;
        if (fraction !== null && legal.aggressiveType) {
          const bet = buildAggressive(legal, targetFromFraction(view, legal, fraction)) as PlayerAction | null;
          if (bet) {
            action = bet;
            reasoning = reasoning + "（河牌子博弈求解：" + Math.round((fraction === 0.5 ? betHalf : betPot) * 100) + "% 下注频率）";
          }
        } else if (fraction === null && legal.canCheck) {
          action = { type: "check" };
          reasoning = reasoning + "（河牌子博弈求解：过牌频率 " + Math.round((solver.frequencies.check ?? 0) * 100) + "%）";
        }
      } else if (legal.canCall) {
        const callFrequency = solver.frequencies.call ?? 0.5;
        if (rng() < callFrequency) {
          action = { type: "call" };
          reasoning = reasoning + "（河牌子博弈求解：跟注频率 " + Math.round(callFrequency * 100) + "%）";
        } else if (legal.canFold) {
          action = { type: "fold" };
          reasoning = reasoning + "（河牌子博弈求解：弃牌频率 " + Math.round((1 - callFrequency) * 100) + "%）";
        }
      }
    }
  }
  // 体验随机：风格触发的合法小幅变化（尺度 / 慢玩 / 边缘牌随机化）；挑战模式用自身随机化。
  if (!isPreflop && !challenge) {
    const varied = maybeStyleVariation(ctx, action, variationReference);
    if (varied) {
      action = varied.action;
      reasoning = `${reasoning}${varied.note}`;
    }
  }

  // 真人化失误层：低概率的人类式偏差（入门 > 普通 > 困难 > 专家）；训练 / 对照评估时关闭；挑战模式不犯错。
  if (!isPreflop && !options.profileOverride && !challenge) {
    const mistake = maybeHumanMistake(ctx, action, variationReference, analysisHasDraw);
    if (mistake) {
      action = mistake.action;
      reasoning = reasoning + mistake.note;
    }
  }

  const moodText = options.profileOverride ? null : moodLabel(mood);
  if (moodText) reasoning = reasoning + '（手感：' + moodText + '）';

  const safeAction = finalizeAction(action, legal);
  const styleName = options.profileOverride ? null : styleLabel(styleId);
  const tags: string[] = [];
  if (styleName) tags.push(styleName + '型');
  if (challenge) tags.push(challengeArchetypeLabel(archetypeId));
  if (!options.profileOverride && closeness >= 0.5) {
    tags.push('GTO ' + Math.round(closeness * 100) + '%');
  }
  if (!options.profileOverride && challenge && closeness >= 0.5) {
    tags.push('搜索');
  }
  const moodTag = options.profileOverride ? null : moodLabel(mood);
  if (moodTag) tags.push(moodTag);
  if (!options.profileOverride && opponents.count > 0 && difficulty !== 'beginner') {
    tags.push('读对手');
  }
  const timingHint =
    challenge && !options.profileOverride
      ? chooseTimingHint({
          view,
          action: safeAction,
          strength: variationReference ?? 0.5,
          isBluff:
            isAggressiveActionType(safeAction.type) && (variationReference ?? 1) < 0.42,
          archetypeId,
          rng,
        })
      : undefined;
  const timingText = timingHint ? timingHintLabel(timingHint) : null;
  if (timingText) reasoning = reasoning + '（计时伪装：' + timingText + '）';
  return {
    action: safeAction,
    timingHint,
    debug: {
      difficulty,
      profile: tags.length > 0 ? profile.style + ' · ' + tags.join(' · ') : profile.style,
      equity,
      potOdds,
      handCategory,
      iterations,
      reasoning,
      timing: timingText ?? undefined,
      archetype: challenge ? challengeArchetypeLabel(archetypeId) : undefined,
    },
  };
}
