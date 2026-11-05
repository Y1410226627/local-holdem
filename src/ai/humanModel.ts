/**
 * 「真人化决策」层：跨手对手统计、情绪（手感 / 上头）、按难度区分的真人式失误、
 * 以及基于 fold-equity 的下注尺度 EV 选择。
 *
 * 四个难度档使用不同强度：
 * - 入门：几乎不读对手；情绪波动大、失误多（爱跟小注、追听牌）；
 * - 普通：轻度利用明显漏洞；偶尔追牌 / 怕大注；
 * - 困难：会用对手统计调整诈唬和价值下注；偶尔英雄跟注；
 * - 专家：更强的利用与 EV 尺度选择；情绪影响最小，失误最少。
 *
 * 所有函数都是纯函数、无隐藏信息读取；随机性由调用方传入的 rng 决定。
 */
import type { LegalActions, PublicPlayerStats } from '../game/types';
import type { Difficulty } from '../game/types';
import type { PlayerView } from '../game/playerView';
import type { DifficultyProfile } from './difficulty';

export interface OpponentSummary {
  /** 有统计样本的对手数。 */
  count: number;
  /** 平均 VPIP / PFR / 攻击性 / 面对下注弃牌率（无样本为 null）。 */
  avgVpip: number | null;
  avgPfr: number | null;
  avgAggression: number | null;
  avgFoldToBet: number | null;
  /** 0..1 置信度（按平均手数）。 */
  confidence: number;
  /** 平均情绪（若公开；目前情绪只自己可见，这里预留）。 */
}

const EXPLOIT_STRENGTH: Record<Difficulty, number> = {
  beginner: 0,
  normal: 0.3,
  hard: 0.65,
  expert: 1,
};

const MOOD_SUSCEPTIBILITY: Record<Difficulty, number> = {
  beginner: 0.35,
  normal: 0.22,
  hard: 0.12,
  expert: 0.06,
};

const MISTAKE_RATE: Record<Difficulty, number> = {
  beginner: 0.15,
  normal: 0.07,
  hard: 0.025,
  expert: 0.005,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 汇总桌上其他玩家的公开统计（只取非自己、有样本的玩家）。 */
export function summarizeOpponents(view: PlayerView): OpponentSummary {
  const opponents = view.players.filter((player) => player.id !== view.viewerId);
  const withStats = opponents
    .map((player) => player.stats)
    .filter((stats): stats is PublicPlayerStats => Boolean(stats) && (stats?.hands ?? 0) > 0);
  if (withStats.length === 0) {
    return {
      count: 0,
      avgVpip: null,
      avgPfr: null,
      avgAggression: null,
      avgFoldToBet: null,
      confidence: 0,
    };
  }
  const avg = (pick: (stats: PublicPlayerStats) => number): number =>
    withStats.reduce((sum, stats) => sum + pick(stats), 0) / withStats.length;
  const folds = withStats
    .map((stats) => stats.foldToBetRate)
    .filter((rate): rate is number => rate !== null);
  const avgHands = avg((stats) => stats.hands);
  return {
    count: withStats.length,
    avgVpip: avg((stats) => stats.vpipRate),
    avgPfr: avg((stats) => stats.pfrRate),
    avgAggression: avg((stats) => stats.aggression),
    avgFoldToBet: folds.length > 0 ? folds.reduce((sum, rate) => sum + rate, 0) / folds.length : null,
    confidence: clamp(avgHands / 8, 0, 1),
  };
}

/** 情绪 → profile 调整：正情绪更自信（略松略凶），负情绪上头（更爱跟/诈唬、失误升高）。 */
export function applyMoodToProfile(
  profile: DifficultyProfile,
  mood: number,
  difficulty: Difficulty,
): DifficultyProfile {
  const scaled = clamp(mood, -2, 2) * MOOD_SUSCEPTIBILITY[difficulty];
  if (Math.abs(scaled) < 0.02) return profile;
  const pre = { ...profile.preflop };
  const post = { ...profile.postflop };
  pre.bluffRaiseRate = round3(clamp(profile.preflop.bluffRaiseRate * (1 + scaled * 0.8), 0, 0.4));
  pre.mixRaiseRate = round3(clamp(profile.preflop.mixRaiseRate * (1 + scaled * 0.6), 0, 0.6));
  pre.errorRate = round3(clamp(profile.preflop.errorRate * (1 + Math.abs(scaled) * 1.2), 0, 0.15));
  post.bluffRate = round3(clamp(profile.postflop.bluffRate * (1 + scaled * 0.7), 0, 0.45));
  post.semiBluffRate = round3(clamp(profile.postflop.semiBluffRate * (1 + scaled * 0.5), 0, 0.6));
  // 上头时更爱跟注（callMargin 降低），自信时更敢价值下注（valueThreshold 略降）。
  post.callMargin = round3(clamp(profile.postflop.callMargin - scaled * 0.03, -0.05, 0.2));
  post.valueThreshold = round3(clamp(profile.postflop.valueThreshold - scaled * 0.02, 0.5, 0.95));
  post.errorRate = round3(clamp(profile.postflop.errorRate * (1 + Math.abs(scaled) * 1.2), 0, 0.15));
  return { ...profile, preflop: pre, postflop: post };
}

/** 按难度强度利用对手统计：松对手少诈唬多价值，紧对手多诈唬，弃牌多的对手多诈唬。 */
export function applyExploitation(
  profile: DifficultyProfile,
  summary: OpponentSummary,
  difficulty: Difficulty,
): DifficultyProfile {
  const strength = EXPLOIT_STRENGTH[difficulty] * summary.confidence;
  if (strength <= 0) return profile;
  const pre = { ...profile.preflop };
  const post = { ...profile.postflop };
  let bluffMultiplier = 1;
  let valueOffset = 0;
  let callMarginOffset = 0;

  if (summary.avgVpip !== null) {
    if (summary.avgVpip > 0.55) {
      // 对手太松：少诈唬、价值下注更薄。
      bluffMultiplier *= 1 - 0.45 * strength;
      valueOffset += 0.04 * strength;
    } else if (summary.avgVpip < 0.3) {
      // 对手太紧：多偷一些，价值下注更标准。
      bluffMultiplier *= 1 + 0.55 * strength;
      valueOffset -= 0.02 * strength;
    }
  }
  if (summary.avgFoldToBet !== null) {
    if (summary.avgFoldToBet > 0.55) {
      bluffMultiplier *= 1 + 0.6 * strength;
    } else if (summary.avgFoldToBet < 0.32) {
      bluffMultiplier *= 1 - 0.55 * strength;
      valueOffset += 0.03 * strength;
    }
  }
  if (summary.avgAggression !== null && summary.avgAggression > 1.6) {
    // 对手爱加注：自己少做纯诈唬、少慢玩。
    bluffMultiplier *= 1 - 0.25 * strength;
    callMarginOffset -= 0.01 * strength;
  }

  pre.bluffRaiseRate = round3(clamp(profile.preflop.bluffRaiseRate * bluffMultiplier, 0.001, 0.4));
  pre.mixRaiseRate = round3(clamp(profile.preflop.mixRaiseRate * (1 + (bluffMultiplier - 1) * 0.4), 0, 0.6));
  post.bluffRate = round3(clamp(profile.postflop.bluffRate * bluffMultiplier, 0.001, 0.45));
  post.valueThreshold = round3(clamp(profile.postflop.valueThreshold + valueOffset, 0.5, 0.95));
  post.callMargin = round3(clamp(profile.postflop.callMargin + callMarginOffset, -0.05, 0.2));
  return { ...profile, preflop: pre, postflop: post };
}

/** 当前难度 + 情绪下的「真人式失误」概率。 */
export function humanMistakeRate(difficulty: Difficulty, mood: number): number {
  const base = MISTAKE_RATE[difficulty];
  const tilt = clamp(-mood, -2, 2);
  return clamp(base * (1 + Math.max(0, tilt) * 0.35), 0, 0.4);
}

/** 情绪中文标签（调试/台词用）。 */
export function moodLabel(mood: number): string | null {
  if (mood >= 1.2) return '手气正顺';
  if (mood >= 0.5) return '略自信';
  if (mood <= -1.2) return '上头了';
  if (mood <= -0.5) return '有点急躁';
  return null;
}

/**
 * 估算单个对手面对下注的弃牌概率（0..1 的启发式）：
 * - 下注越大越可能弃牌；
 * - 有「面对下注弃牌率」样本时向它靠拢；
 * - 对手越少，单挑时弃牌率通常更高。
 */
export function estimateFoldProbability(
  betFraction: number,
  foldToBetRate: number | null,
  opponentCount: number,
): number {
  const size = clamp(betFraction, 0.1, 2);
  let probability = 0.3 + size * 0.16;
  if (foldToBetRate !== null) probability = probability * 0.45 + foldToBetRate * 0.55;
  if (opponentCount <= 1) probability += 0.06;
  else probability -= Math.min(0.16, (opponentCount - 1) * 0.04);
  return clamp(probability, 0.05, 0.85);
}

/** 近似 EV：所有对手都弃牌 → 赢底池；有人跟注 → 用胜率估算。”
 */
export function evOfBet(
  pot: number,
  equity: number,
  betChips: number,
  foldProbability: number,
  opponentCount: number,
): number {
  const foldAll = Math.pow(clamp(foldProbability, 0, 0.95), Math.max(1, opponentCount));
  const calledEquity = clamp(equity, 0, 1);
  const calledEv = calledEquity * (pot + 2 * betChips) - betChips;
  return foldAll * pot + (1 - foldAll) * calledEv;
}

export interface EvSizeChoice {
  fraction: number;
  ev: number;
  foldProbability: number;
}

/** 在给定的下注尺度里挑 EV 最大的一个（仅用于翻牌后）。 */
export function chooseEvBetFraction(params: {
  fractions: readonly number[];
  pot: number;
  equity: number;
  currentBet: number;
  legal: LegalActions;
  foldToBetRate: number | null;
  opponentCount: number;
}): EvSizeChoice | null {
  const { fractions, pot, equity, currentBet, legal, foldToBetRate, opponentCount } = params;
  if (fractions.length === 0) return null;
  let best: EvSizeChoice | null = null;
  for (const fraction of fractions) {
    const target = legal.currentBet + (pot + legal.callAmount) * fraction;
    const betChips = Math.max(1, target - currentBet);
    const foldProbability = estimateFoldProbability(fraction, foldToBetRate, opponentCount);
    const ev = evOfBet(pot, equity, betChips, foldProbability, opponentCount);
    if (!best || ev > best.ev) best = { fraction, ev, foldProbability };
  }
  return best;
}
