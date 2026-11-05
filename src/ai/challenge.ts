/**
 * 挑战模式（宗师 AI / 「德州 AlphaGo」层）：
 *
 * - **元策略原型**：每个本地机器人座位由 seed 分配 5 种宗师原型之一
 *   （均衡 / 压力 / 陷阱 / 反制 / 混沌），保证「都是高手但和而不同」；
 * - **读下注细节**：从小注 / 大注 / 超池 / check-raise 等公开动作推断对手范围强弱；
 * - **读思考时间**：把对手每个动作的 thinkMs 与其自身基线比较（快 / 慢 / 正常），
 *   用于范围极化、抓诈、施压；没有样本时用弱先验；
 * - **自我计时伪装**：返回 fast / normal / slow 的计时提示，由 UI 驱动延迟，
 *   强牌可以秒打、诈唬可以长考，让人类无法从节奏中稳定读出牌力；
 * - **EV 尺度与极化施压**：结合 fold-equity 选合法尺度，河牌可超额下注；
 * - 所有输入仅来自 PlayerView（公开动作 + 自己的底牌），不读取隐藏信息。
 */
import type { ActionRecord, LegalActions, PublicPlayerStats } from '../game/types';
import type { PlayerView } from '../game/playerView';
import { derivedRng, shuffle } from '../game/cards';
import type { DifficultyProfile } from './difficulty';
import type { RangeWeight } from './equity';
import { preflopStrengthOf } from './rangeModel';
import {
  chooseEvBetFraction,
  estimateFoldProbability,
  type OpponentSummary,
} from './humanModel';

/** 宗师原型数量。 */
export const CHALLENGE_ARCHETYPE_COUNT = 5;

export interface ChallengeArchetype {
  key: string;
  label: string;
  description: string;
  /** 整体攻击性倍率（约 0.8..1.25）。 */
  aggression: number;
  /** 诈唬频率倍率（约 0.6..1.6）。 */
  bluff: number;
  /** 慢玩 / 陷阱倍率（约 0.4..1.8）。 */
  trap: number;
  /** 下注尺度偏好倍率（<1 偏小、>1 偏大）。 */
  sizing: number;
  /**
   * 计时伪装风格：
   * 0 = 均衡；1 = 快打型（强牌快、诈唬慢）；
   * 2 = 慢打型（强牌慢、诈唬快）；3 = 反向随机（同一手牌也可能忽快忽慢）。
   */
  timingStyle: number;
  /** 对公开统计 / 读人的依赖强度（0.8..1.25）。 */
  exploit: number;
}

export const CHALLENGE_ARCHETYPES: readonly ChallengeArchetype[] = [
  {
    key: 'solver',
    label: '均衡宗师',
    description: '价值与诈唬比例最平衡，尺度标准，难被针对',
    aggression: 1,
    bluff: 1,
    trap: 1,
    sizing: 1,
    timingStyle: 0,
    exploit: 1,
  },
  {
    key: 'pressure',
    label: '压力宗师',
    description: '高频施压、超额下注，专挑对手犹豫与小注的弱点',
    aggression: 1.22,
    bluff: 1.55,
    trap: 0.5,
    sizing: 1.3,
    timingStyle: 1,
    exploit: 1.1,
  },
  {
    key: 'trap',
    label: '陷阱宗师',
    description: '强牌慢玩、诱导诈唬，关键街突然加注收割',
    aggression: 0.88,
    bluff: 0.65,
    trap: 1.7,
    sizing: 0.95,
    timingStyle: 2,
    exploit: 1.15,
  },
  {
    key: 'counter',
    label: '反制宗师',
    description: '最大化利用对手统计与下注 / 计时漏洞，针对性最强',
    aggression: 1.05,
    bluff: 1.15,
    trap: 1,
    sizing: 1.1,
    timingStyle: 0,
    exploit: 1.25,
  },
  {
    key: 'chaos',
    label: '混沌宗师',
    description: '范围与节奏极度随机，读不出稳定模式，专治爱读人的人',
    aggression: 1.12,
    bluff: 1.35,
    trap: 0.8,
    sizing: 1.2,
    timingStyle: 3,
    exploit: 0.85,
  },
];

export function challengeArchetype(id: number | undefined): ChallengeArchetype {
  if (id === undefined || !Number.isInteger(id)) return CHALLENGE_ARCHETYPES[0];
  return CHALLENGE_ARCHETYPES[((id % CHALLENGE_ARCHETYPE_COUNT) + CHALLENGE_ARCHETYPE_COUNT) % CHALLENGE_ARCHETYPE_COUNT];
}

export function challengeArchetypeLabel(id: number | undefined): string {
  return challengeArchetype(id).label;
}

/**
 * 给每个机器人座位分配宗师原型：由 seed 洗牌，保证同桌尽量不重复；
 * 换种子（新局）会重新组合，但同种子可复现。
 */
export function assignChallengeArchetypes(
  seed: string,
  playerIds: readonly number[],
): Map<number, number> {
  const order = shuffle(
    Array.from({ length: CHALLENGE_ARCHETYPE_COUNT }, (_item, index) => index),
    derivedRng(seed, 'table-challenge-archetypes'),
  );
  const result = new Map<number, number>();
  playerIds.forEach((playerId, index) => {
    result.set(playerId, order[index % order.length] ?? 0);
  });
  return result;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 在挑战档 profile 上叠加宗师原型偏移（有界，不改变难度档结构）。 */
export function applyChallengeVariant(
  profile: DifficultyProfile,
  archetypeId: number | undefined,
): DifficultyProfile {
  const archetype = challengeArchetype(archetypeId);
  const pre = { ...profile.preflop };
  const post = { ...profile.postflop };
  pre.bluffRaiseRate = round3(
    clamp(profile.preflop.bluffRaiseRate * archetype.bluff, 0.005, 0.45),
  );
  pre.mixRaiseRate = round3(clamp(profile.preflop.mixRaiseRate * archetype.aggression, 0, 0.6));
  pre.trapRate = round3(clamp(profile.preflop.trapRate * archetype.trap, 0, 0.4));
  post.bluffRate = round3(clamp(profile.postflop.bluffRate * archetype.bluff, 0.005, 0.5));
  post.semiBluffRate = round3(
    clamp(profile.postflop.semiBluffRate * (0.85 + archetype.bluff * 0.2), 0, 0.65),
  );
  post.valueThreshold = round3(
    clamp(profile.postflop.valueThreshold - (archetype.sizing - 1) * 0.03, 0.5, 0.95),
  );
  post.callMargin = round3(
    clamp(profile.postflop.callMargin - (archetype.exploit - 1) * 0.02, -0.05, 0.2),
  );
  return { ...profile, preflop: pre, postflop: post };
}

/* ------------------------------------------------------------------ */
/* 计时读人                                                            */
/* ------------------------------------------------------------------ */

export type TimingHint = 'fast' | 'normal' | 'slow';
export type TimingTell = 'fast' | 'slow' | 'normal';

export interface OpponentTimingTell {
  playerId: number;
  playerName: string;
  tell: TimingTell;
  /** 最近一次动作的思考时间（毫秒）。 */
  sampleMs: number;
  /** 该对手自身的思考时间基线（毫秒；无跨手样本为 null）。 */
  baselineMs: number | null;
  /** 最近动作类型（主动 / 被动）。 */
  context: 'aggressive' | 'passive';
  /** 0..1 置信度（样本越多越可信）。 */
  confidence: number;
  /** 中文解读（调试面板用）。 */
  note: string;
}

const DEFAULT_BASELINE_MS = 2400;

function actionIsAggressive(type: ActionRecord['action']['type']): boolean {
  return type === 'bet' || type === 'raise' || type === 'allin';
}

function timingBaselineFor(
  stats: PublicPlayerStats | undefined,
  context: 'aggressive' | 'passive',
): number | null {
  if (!stats) return null;
  if (context === 'aggressive' && typeof stats.aggressiveAvgThinkMs === 'number') {
    return stats.aggressiveAvgThinkMs;
  }
  if (context === 'passive' && typeof stats.passiveAvgThinkMs === 'number') {
    return stats.passiveAvgThinkMs;
  }
  if (typeof stats.avgThinkMs === 'number') return stats.avgThinkMs;
  return null;
}

/** 读对手的思考时间：相对其自身基线做「快 / 慢 / 正常」分类。 */
export function readTimingTells(view: PlayerView): OpponentTimingTell[] {
  const tells: OpponentTimingTell[] = [];
  for (const player of view.players) {
    if (player.id === view.viewerId) continue;
    if (player.status !== 'active' && player.status !== 'allin') continue;
    const records = view.actions.filter(
      (record) =>
        record.actorId === player.id &&
        typeof record.thinkMs === 'number' &&
        Number.isFinite(record.thinkMs) &&
        (record.thinkMs as number) > 0,
    );
    if (records.length === 0) continue;
    const last = records[records.length - 1];
    const sampleMs = Math.round(last.thinkMs as number);
    const context = actionIsAggressive(last.action.type) ? 'aggressive' : 'passive';
    const statsBaseline = timingBaselineFor(player.stats, context);
    const baselineMs = statsBaseline;
    const compareBase =
      statsBaseline ?? (typeof player.stats?.avgThinkMs === 'number' ? player.stats.avgThinkMs : DEFAULT_BASELINE_MS);
    const ratio = sampleMs / Math.max(300, compareBase);
    let tell: TimingTell = 'normal';
    if (ratio >= 1.45) tell = 'slow';
    else if (ratio <= 0.62) tell = 'fast';
    const confidence = clamp(
      (statsBaseline === null ? 0.35 : 0.55) + Math.min(0.4, records.length * 0.12),
      0,
      1,
    );
    const note =
      tell === 'slow'
        ? `长考 ${sampleMs}ms（约基线的 ${ratio.toFixed(1)} 倍）`
        : tell === 'fast'
          ? `秒打 ${sampleMs}ms（约基线的 ${ratio.toFixed(1)} 倍）`
          : `节奏正常 ${sampleMs}ms`;
    tells.push({
      playerId: player.id,
      playerName: player.name,
      tell,
      sampleMs,
      baselineMs,
      context,
      confidence,
      note,
    });
  }
  return tells;
}

/* ------------------------------------------------------------------ */
/* 下注细节读人                                                        */
/* ------------------------------------------------------------------ */

export interface OpponentBettingTell {
  playerId: number;
  playerName: string;
  /** 本手已观察到的主动动作数。 */
  aggressiveActions: number;
  /** 小注（< 0.4 池）比例。 */
  smallBetRate: number;
  /** 大注（>= 0.9 池）/ 超池比例。 */
  bigBetRate: number;
  /** 是否出现过 check-raise。 */
  checkRaised: boolean;
  /** 中文解读。 */
  note: string;
}

/** 读对手本手的下注尺度 / 节奏细节（只使用公开动作记录）。 */
export function readBettingTells(view: PlayerView): OpponentBettingTell[] {
  const tells: OpponentBettingTell[] = [];
  for (const player of view.players) {
    if (player.id === view.viewerId) continue;
    if (player.status !== 'active' && player.status !== 'allin') continue;
    const records = view.actions.filter((record) => record.actorId === player.id);
    if (records.length === 0) continue;
    const aggressive = records.filter((record) => actionIsAggressive(record.action.type));
    let smallBets = 0;
    let bigBets = 0;
    let checkRaised = false;
    let checkedThisStreet = false;
    let lastStreet = '';
    for (const record of records) {
      if (record.street !== lastStreet) {
        lastStreet = record.street;
        checkedThisStreet = false;
      }
      if (record.action.type === 'check') {
        checkedThisStreet = true;
      } else if (actionIsAggressive(record.action.type)) {
        if (checkedThisStreet) checkRaised = true;
        const potBefore = Math.max(1, record.potAfter - record.paid);
        const fraction = record.paid / potBefore;
        if (fraction <= 0.4) smallBets += 1;
        if (fraction >= 0.9) bigBets += 1;
      }
    }
    if (aggressive.length === 0) continue;
    const smallBetRate = smallBets / aggressive.length;
    const bigBetRate = bigBets / aggressive.length;
    let note = `主动动作 ${aggressive.length} 次`;
    if (checkRaised) note += '，有 check-raise';
    if (smallBetRate >= 0.5) note += '，偏小注（可能是薄价值 / 封锁 / 试探）';
    if (bigBetRate >= 0.5) note += '，偏大注 / 超池（两极分化或施压）';
    tells.push({
      playerId: player.id,
      playerName: player.name,
      aggressiveActions: aggressive.length,
      smallBetRate,
      bigBetRate,
      checkRaised,
      note,
    });
  }
  return tells;
}

/* ------------------------------------------------------------------ */
/* 范围建模（统计 + 下注 + 计时）                                       */
/* ------------------------------------------------------------------ */

function polarizeRange(base: RangeWeight, mode: 'slow' | 'fast' | 'normal'): RangeWeight {
  if (mode === 'normal') return base;
  return (first, second) => {
    const strength = preflopStrengthOf(first, second);
    const weight = base(first, second);
    if (mode === 'slow') {
      // 长考后的主动下注：更像两极（强牌 / 纯诈唬），中间牌权重下降。
      const polar = strength >= 0.72 || strength <= 0.3 ? 1.2 : 0.35;
      return Math.min(1, weight * polar);
    }
    // 秒打：更偏向自信的价值（强牌）与少量纯诈唬，中间牌下注权重下降。
    const fast = strength >= 0.6 ? 1.25 : strength <= 0.22 ? 1.05 : 0.55;
    return Math.min(1, weight * fast);
  };
}

/**
 * 挑战模式的范围权重：在行动历史 / 公开统计基础上，叠加下注尺度与计时读人。
 * 返回 playerId → RangeWeight；未覆盖的对手使用均匀随机。
 */
export function buildChallengeRanges(
  view: PlayerView,
  timingTells: readonly OpponentTimingTell[] = readTimingTells(view),
  bettingTells: readonly OpponentBettingTell[] = readBettingTells(view),
): Map<number, RangeWeight> {
  const timingByPlayer = new Map(timingTells.map((tell) => [tell.playerId, tell]));
  const bettingByPlayer = new Map(bettingTells.map((tell) => [tell.playerId, tell]));
  const ranges = new Map<number, RangeWeight>();

  for (const player of view.players) {
    if (player.id === view.viewerId) continue;
    if (player.status !== 'active' && player.status !== 'allin') continue;

    let raises = 0;
    let calls = 0;
    for (const record of view.actions) {
      if (record.actorId !== player.id) continue;
      if (actionIsAggressive(record.action.type)) raises += 1;
      else if (record.action.type === 'call') calls += 1;
    }
    const stats = player.stats;
    const hands = stats?.hands ?? 0;

    let base: RangeWeight;
    if (raises > 0) {
      let exponent = 1.12 + Math.min(3, raises) * 0.17;
      if (hands > 0 && stats) {
        exponent -= (stats.vpipRate - 0.4) * 0.5;
        exponent -= (stats.pfrRate - 0.15) * 0.7;
        exponent += (1 - Math.min(1, hands / 8)) * 0.12; // 样本少时更保守
      }
      exponent = clamp(exponent, 0.65, 3.4);
      base = (first, second) => {
        const strength = preflopStrengthOf(first, second);
        return Math.min(1, 0.03 + Math.pow(strength, exponent) * 1.15);
      };
    } else if (calls > 0) {
      let center = 0.5 + Math.min(0.15, calls * 0.02);
      if (hands > 0 && stats) {
        center = clamp(center + (stats.vpipRate - 0.4) * 0.25, 0.35, 0.7);
      }
      base = (first, second) => {
        const strength = preflopStrengthOf(first, second);
        const distance = Math.abs(strength - center);
        return Math.max(0.08, 1 - distance * 2.4);
      };
    } else {
      base = (first, second) => {
        const strength = preflopStrengthOf(first, second);
        return Math.max(0.1, Math.min(1, 0.35 + strength * 0.8));
      };
    }

    let range = base;
    const timing = timingByPlayer.get(player.id);
    if (timing && timing.confidence >= 0.4) {
      range = polarizeRange(range, timing.tell);
    }
    const betting = bettingByPlayer.get(player.id);
    if (betting) {
      // 小注多：偏中等 / 封锁牌；大注多：更两极。
      const smallWeight = betting.smallBetRate >= 0.5 ? 1 : 0;
      const bigWeight = betting.bigBetRate >= 0.5 ? 1 : 0;
      const baseRange = range;
      range = (first, second) => {
        const strength = preflopStrengthOf(first, second);
        let multiplier = 1;
        if (smallWeight === 1) {
          multiplier *= Math.abs(strength - 0.5) <= 0.22 ? 1.2 : 0.8;
        }
        if (bigWeight === 1) {
          multiplier *= strength >= 0.75 || strength <= 0.28 ? 1.2 : 0.7;
        }
        return Math.min(1, baseRange(first, second) * multiplier);
      };
    }
    ranges.set(player.id, range);
  }
  return ranges;
}

/** 把 playerId → RangeWeight 映射对齐到 estimateEquity 的对手顺序数组。 */
export function rangesForView(
  view: PlayerView,
  ranges: ReadonlyMap<number, RangeWeight>,
): Array<RangeWeight | null> {
  return view.players
    .filter(
      (player) =>
        player.id !== view.viewerId &&
        (player.status === 'active' || player.status === 'allin'),
    )
    .map((player) => ranges.get(player.id) ?? null);
}

/* ------------------------------------------------------------------ */
/* 计时伪装                                                            */
/* ------------------------------------------------------------------ */

export interface TimingPlanInput {
  view: PlayerView;
  action: ActionRecord['action'];
  /** 0..1 胜率（翻牌前可为起手牌强度）。 */
  strength: number;
  /** 是否诈唬（弱牌主动进攻）。 */
  isBluff: boolean;
  archetypeId?: number;
  rng: () => number;
}

/**
 * 决定本轮「看起来的思考时间」：强牌可以快、诈唬可以慢，也可以完全反过来。
 * 返回的提示由 UI 层转成实际延迟；不影响动作本身。
 */
export function chooseTimingHint(input: TimingPlanInput): TimingHint {
  const { view, action, strength, isBluff, archetypeId, rng } = input;
  const archetype = challengeArchetype(archetypeId);
  const roll = rng();
  const aggressive = action.type === 'bet' || action.type === 'raise' || action.type === 'allin';
  // 翻牌前尽量快，减少无意义的长时间等待。
  if (view.board.length < 3) return roll < 0.65 ? 'fast' : 'normal';

  const strong = strength >= 0.72;
  switch (archetype.timingStyle) {
    case 1: // 快打型：强牌 / 价值下注快，诈唬偶尔长考
      if (strong || (!isBluff && aggressive)) return roll < 0.7 ? 'fast' : 'normal';
      if (isBluff) return roll < 0.55 ? 'slow' : 'normal';
      return roll < 0.4 ? 'fast' : 'normal';
    case 2: // 慢打型：强牌故意慢，诈唬秒打
      if (strong) return roll < 0.65 ? 'slow' : 'normal';
      if (isBluff) return roll < 0.5 ? 'fast' : 'normal';
      return roll < 0.3 ? 'slow' : 'normal';
    case 3: // 反向随机：每一秒都可能是演戏
      return roll < 0.45 ? 'fast' : roll < 0.9 ? 'normal' : 'slow';
    default: {
      // 均衡：价值快一点，诈唬偶尔慢，其余随机。
      if (strong && aggressive) return roll < 0.45 ? 'fast' : 'normal';
      if (isBluff) return roll < 0.3 ? 'slow' : roll < 0.55 ? 'fast' : 'normal';
      return roll < 0.3 ? 'fast' : roll < 0.75 ? 'normal' : 'slow';
    }
  }
}

export function timingHintLabel(hint: TimingHint | undefined): string | null {
  if (hint === 'fast') return '秒打';
  if (hint === 'slow') return '长考';
  if (hint === 'normal') return '正常节奏';
  return null;
}

/* ------------------------------------------------------------------ */
/* 下注尺度（EV + 极化施压）                                            */
/* ------------------------------------------------------------------ */

export interface ChallengeSizeChoice {
  fraction: number;
  ev: number;
  note: string;
}

/**
 * 在候选尺度里挑近似 EV 最大的；河牌极化时允许超额下注（1.35x 最大池）。
 * 宗师原型会改变候选尺度（压力型偏大、陷阱型偏小）。
 */
export function chooseChallengeSize(params: {
  fractions: readonly number[];
  pot: number;
  equity: number;
  currentBet: number;
  callAmount: number;
  legal: LegalActions;
  foldToBetRate: number | null;
  opponentCount: number;
  street: string;
  archetypeId?: number;
  isBluff?: boolean;
}): ChallengeSizeChoice {
  const {
    fractions,
    pot,
    equity,
    currentBet,
    legal,
    foldToBetRate,
    opponentCount,
    street,
    archetypeId,
    isBluff = false,
  } = params;
  const archetype = challengeArchetype(archetypeId);
  const candidates = new Set<number>();
  for (const fraction of fractions) {
    candidates.add(clamp(fraction * archetype.sizing, 0.15, 2));
  }
  const maxFraction = Math.max(...fractions, 1);
  const polarized = street === 'river' && (equity >= 0.78 || isBluff);
  if (polarized && legal.maxRaiseTo > legal.currentBet) {
    candidates.add(clamp(maxFraction * 1.35, 0.2, 2.2));
  }
  const list = [...candidates];
  const choice = chooseEvBetFraction({
    fractions: list,
    pot: Math.max(1, pot),
    equity,
    currentBet,
    legal,
    foldToBetRate,
    opponentCount,
  });
  if (!choice) {
    return { fraction: list[0] ?? 0.66, ev: 0, note: '无可用尺度' };
  }
  const sizeNote =
    choice.fraction >= 1.2
      ? '超额下注施压'
      : choice.fraction >= 0.9
        ? '接近满池施压'
        : choice.fraction >= 0.55
          ? '标准价值尺度'
          : '小注控制 / 试探';
  return { fraction: choice.fraction, ev: choice.ev, note: sizeNote };
}

/** 估算「对手会弃牌」的概率（供挑战模式在决策里做施压判断）。 */
export function challengeFoldEquity(
  summary: OpponentSummary,
  opponentCount: number,
  betFraction: number,
  betTimingTell?: TimingTell,
): number {
  let fold = estimateFoldProbability(betFraction, summary.avgFoldToBet, opponentCount);
  if (betTimingTell === 'slow') fold += 0.05 * (summary.confidence || 0.5);
  if (betTimingTell === 'fast') fold += 0.02;
  return clamp(fold, 0.05, 0.9);
}

/** 找出对某对手最值得利用的「计时弱点」：长考后的小动作 / 秒打的大动作。 */
export function findTimingWeakness(
  tells: readonly OpponentTimingTell[],
): OpponentTimingTell | null {
  const sorted = tells
    .slice()
    .sort((a, b) => b.confidence - a.confidence);
  return sorted.find((tell) => tell.tell !== 'normal' && tell.confidence >= 0.5) ?? sorted[0] ?? null;
}
