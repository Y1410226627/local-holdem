/**
 * 起手牌范围模型与翻牌后牌力评估。
 *
 * - 169 个起手牌分类：用 Chen 公式打分后，按真实组合数（对子 6、同花 4、
 *   非同花 12）加权重排，得到 0..1 的百分位强度。强度越大牌越好，且随机
 *   起手牌的强度分布接近均匀，便于用阈值直接控制入池率。
 * - 位置：由 view.buttonIndex 与玩家座位推导 early / middle / late / blinds。
 * - 翻牌后：evaluate() 的牌型 + 听牌 + 公共牌纹理 → 0..1 的粗略强度。
 */
import type { Card, Rank } from '../game/types';
import type { PlayerView } from '../game/playerView';
import type { Difficulty } from '../game/types';
import { RANK_LABELS, SUIT_INDEX } from '../game/cards';
import {
  CATEGORY_NAMES,
  evaluate,
  type EvaluatedHand,
  type HandCategory,
} from '../game/handEvaluator';
import { DIFFICULTY_PROFILES, type DifficultyProfile } from './difficulty';

export type Position = 'early' | 'middle' | 'late' | 'blinds';

export const POSITION_LABELS: Record<Position, string> = {
  early: '早位',
  middle: '中位',
  late: '晚位',
  blinds: '盲注位',
};

/** 翻牌前位置阈值。 */
export interface PreflopThresholds {
  /** 低于该强度弃牌（入池门槛）。 */
  play: number;
  /** 达到该强度主动加注。 */
  raise: number;
  /** 面对加注时达到该强度再加注。 */
  threeBet: number;
}

export interface HandClassInfo {
  key: string;
  high: number;
  low: number;
  suited: boolean;
  weight: number;
  chen: number;
  strength: number;
}

const TOTAL_COMBOS = 1326;

function rankText(rank: number): string {
  return RANK_LABELS[rank as Rank] ?? String(rank);
}

/** Chen 公式中的高牌价值。 */
function chenHighValue(rank: number): number {
  if (rank === 14) return 10;
  if (rank === 13) return 8;
  if (rank === 12) return 7;
  if (rank === 11) return 6;
  return rank / 2;
}

/**
 * Chen 公式原始分（整数，约 -1..20）。
 * 对子：高牌分 × 2（至少 5）；同花 +2；间隔扣分；小连张 +1。
 */
export function chenScore(first: Card, second: Card): number {
  const high = Math.max(first.rank, second.rank);
  const low = Math.min(first.rank, second.rank);
  const suited = first.suit === second.suit;
  return chenFor(high, low, suited);
}

function chenFor(high: number, low: number, suited: boolean): number {
  if (high === low) return Math.max(5, chenHighValue(high) * 2);
  let score = chenHighValue(high);
  if (suited) score += 2;
  const gap = high - low - 1;
  if (gap === 0) {
    // 连张无扣分
  } else if (gap === 1) {
    score -= 1;
  } else if (gap === 2) {
    score -= 2;
  } else if (gap === 3) {
    score -= 4;
  } else {
    score -= 5;
  }
  if (gap <= 1 && high < 12) score += 1; // 小连张奖励
  return Math.ceil(score);
}

let handClassTable: Map<string, HandClassInfo> | null = null;

function getHandClassTable(): Map<string, HandClassInfo> {
  if (handClassTable) return handClassTable;
  const list: Omit<HandClassInfo, 'strength'>[] = [];
  for (let high = 14; high >= 2; high--) {
    list.push({
      key: `${rankText(high)}${rankText(high)}`,
      high,
      low: high,
      suited: false,
      weight: 6,
      chen: chenFor(high, high, false),
    });
    for (let low = high - 1; low >= 2; low--) {
      list.push({
        key: `${rankText(high)}${rankText(low)}s`,
        high,
        low,
        suited: true,
        weight: 4,
        chen: chenFor(high, low, true),
      });
      list.push({
        key: `${rankText(high)}${rankText(low)}o`,
        high,
        low,
        suited: false,
        weight: 12,
        chen: chenFor(high, low, false),
      });
    }
  }
  list.sort(
    (a, b) =>
      a.chen - b.chen ||
      a.high - b.high ||
      a.low - b.low ||
      Number(a.suited) - Number(b.suited),
  );
  const table = new Map<string, HandClassInfo>();
  let cumulative = 0;
  for (const info of list) {
    cumulative += info.weight;
    // 用区间中点作为该分类的百分位，随机起手牌强度近似均匀分布。
    const strength = (cumulative - info.weight / 2) / TOTAL_COMBOS;
    table.set(info.key, { ...info, strength });
  }
  handClassTable = table;
  return table;
}

/** 起手牌分类键："AA" / "AKs" / "72o"。 */
export function handKey(cards: readonly Card[]): string {
  if (cards.length !== 2) throw new Error('起手牌必须恰好两张');
  const high = Math.max(cards[0].rank, cards[1].rank);
  const low = Math.min(cards[0].rank, cards[1].rank);
  if (high === low) return `${rankText(high)}${rankText(low)}`;
  const suited = cards[0].suit === cards[1].suit;
  return `${rankText(high)}${rankText(low)}${suited ? 's' : 'o'}`;
}

/** 两张牌直接计算起手牌强度（避免为范围采样分配数组）。 */
export function preflopStrengthOf(first: Card, second: Card): number {
  const high = Math.max(first.rank, second.rank);
  const low = Math.min(first.rank, second.rank);
  const key =
    high === low
      ? `${rankText(high)}${rankText(low)}`
      : `${rankText(high)}${rankText(low)}${first.suit === second.suit ? 's' : 'o'}`;
  return getHandClassTable().get(key)?.strength ?? 0.5;
}

/** 0..1 起手牌强度（加权百分位；AA≈1，72o≈0）。 */
export function preflopStrength(cards: readonly Card[]): number {
  if (cards.length !== 2) return 0;
  return preflopStrengthOf(cards[0], cards[1]);
}

/** 返回全部 169 个分类（按强度升序），供测试 / 调试。 */
export function preflopClasses(): readonly HandClassInfo[] {
  return Array.from(getHandClassTable().values()).sort((a, b) => a.strength - b.strength);
}

export function isValidPreflopKey(key: string): boolean {
  return getHandClassTable().has(key);
}

/**
 * 由座位与按钮位推导位置。
 * - 单挑：按钮 = 晚位，另一位 = 盲注位；
 * - 3 人以上：小盲 / 大盲 = blinds，按钮 / 关煞位 = late，大盲左手第一位 = early，其余 middle。
 */
export function positionOf(view: PlayerView): Position {
  const n = view.players.length;
  if (n <= 0) return 'middle';
  const seat = view.players.findIndex((player) => player.id === view.viewerId);
  if (seat < 0) return 'middle';
  if (view.players[seat].status === 'out') return 'middle';

  // 只考虑仍在牌局中的座位（active / folded / allin），跳过已淘汰的空座。
  const seats: number[] = [];
  for (let index = 0; index < n; index++) {
    if (view.players[index].status !== 'out') seats.push(index);
  }
  if (seats.length === 0) return 'middle';

  const normalizedButton = ((view.buttonIndex % n) + n) % n;
  let buttonPosition = seats.indexOf(normalizedButton);
  if (buttonPosition < 0) {
    // 按钮位不在牌局中时，顺时针找第一个有效座位。
    buttonPosition = 0;
    for (let offset = 0; offset < n; offset++) {
      const candidate = (normalizedButton + offset) % n;
      const found = seats.indexOf(candidate);
      if (found >= 0) {
        buttonPosition = found;
        break;
      }
    }
  }
  const seatPosition = seats.indexOf(seat);
  if (seatPosition < 0) return 'middle';
  const count = seats.length;

  if (count <= 2) return seatPosition === buttonPosition ? 'late' : 'blinds';

  const relative = (seatPosition - buttonPosition + count) % count;
  if (relative === 1 || relative === 2) return 'blinds';
  if (relative === 0) return 'late';
  if (relative === 3) return 'early'; // 大盲左手第一位（UTG）
  if (relative === count - 1) return 'late'; // 关煞位（cutoff）
  return 'middle';
}

interface PositionAdjustment {
  play: number;
  raise: number;
  threeBet: number;
}

const NO_ADJUSTMENT: PositionAdjustment = { play: 0, raise: 0, threeBet: 0 };

/** 位置调整：早位更紧，晚位更松，盲注位略紧。数值为加到阈值上的偏移。 */
export const POSITION_ADJUSTMENTS: Record<Position, PositionAdjustment> = {
  early: { play: 0.12, raise: 0.08, threeBet: 0.04 },
  middle: { play: 0.03, raise: 0.02, threeBet: 0.01 },
  late: { play: -0.08, raise: -0.06, threeBet: -0.02 },
  blinds: { play: 0.04, raise: 0.03, threeBet: 0.01 },
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * 难度 + 位置对应的翻牌前阈值。
 * 阈值越低范围越宽；late 的 play / raise / threeBet 均低于 early。
 */
export function preflopThresholds(
  difficulty: Difficulty,
  position: Position,
): PreflopThresholds {
  return preflopThresholdsForProfile(DIFFICULTY_PROFILES[difficulty], position);
}

/**
 * 指定难度档位（可含训练覆盖参数）对应的翻牌前阈值。
 * 训练 / 自博弈时通过 profileOverride 传入候选档位，保证训练参数真实生效。
 */
export function preflopThresholdsForProfile(
  profile: DifficultyProfile,
  position: Position,
): PreflopThresholds {
  const base = profile.preflop;
  const adjustment = base.positionAware ? POSITION_ADJUSTMENTS[position] : NO_ADJUSTMENT;
  const play = clamp01(base.play + adjustment.play);
  const raise = clamp01(Math.max(play, base.raise + adjustment.raise));
  const threeBet = clamp01(Math.max(raise, base.threeBet + adjustment.threeBet));
  return { play, raise, threeBet };
}

/* ------------------------------------------------------------------ */
/* 翻牌后分析                                                          */
/* ------------------------------------------------------------------ */

const CATEGORY_BASE: Record<HandCategory, number> = {
  0: 0.08,
  1: 0.34,
  2: 0.56,
  3: 0.7,
  4: 0.82,
  5: 0.88,
  6: 0.94,
  7: 0.97,
  8: 1,
};

/** 所有 5 张顺子窗口的 rank 位掩码。 */
const STRAIGHT_WINDOWS: readonly number[] = (() => {
  const windows: number[] = [];
  for (let high = 14; high >= 5; high--) {
    let mask = 0;
    if (high === 5) {
      // A-2-3-4-5
      for (const rank of [14, 2, 3, 4, 5]) mask |= 1 << rank;
    } else {
      for (let rank = high; rank > high - 5; rank--) mask |= 1 << rank;
    }
    windows.push(mask);
  }
  return windows;
})();

function popcount(mask: number): number {
  let count = 0;
  let value = mask;
  while (value) {
    value &= value - 1;
    count++;
  }
  return count;
}

export interface DrawInfo {
  flushDraw: boolean;
  backdoorFlush: boolean;
  straightDraw: boolean;
  openEnded: boolean;
  overcards: number;
  outs: number;
  hasDraw: boolean;
}

export interface PostflopAnalysis {
  evaluation: EvaluatedHand;
  /** 含听牌的粗略强度 0..1。 */
  strength: number;
  /** 仅成牌强度 0..1。 */
  madeStrength: number;
  category: HandCategory;
  categoryName: string;
  draw: DrawInfo;
}

function suitIndex(card: Card): number {
  return SUIT_INDEX[card.suit];
}

function buildDrawInfo(
  hole: readonly Card[],
  board: readonly Card[],
  evaluation: EvaluatedHand,
): DrawInfo {
  const empty: DrawInfo = {
    flushDraw: false,
    backdoorFlush: false,
    straightDraw: false,
    openEnded: false,
    overcards: 0,
    outs: 0,
    hasDraw: false,
  };
  if (board.length >= 5) return empty;

  const suitCounts = [0, 0, 0, 0];
  const holeSuits = [false, false, false, false];
  for (const card of board) suitCounts[suitIndex(card)]++;
  for (const card of hole) {
    const index = suitIndex(card);
    suitCounts[index]++;
    holeSuits[index] = true;
  }

  let flushDraw = false;
  let backdoorFlush = false;
  if (evaluation.category < 5) {
    for (let suit = 0; suit < 4; suit++) {
      if (suitCounts[suit] === 4 && holeSuits[suit]) flushDraw = true;
      if (board.length === 3 && suitCounts[suit] === 3 && holeSuits[suit]) {
        backdoorFlush = true;
      }
    }
  }

  let rankMask = 0;
  for (const card of board) rankMask |= 1 << card.rank;
  for (const card of hole) rankMask |= 1 << card.rank;

  let fourWindows = 0;
  if (evaluation.category < 4) {
    for (const window of STRAIGHT_WINDOWS) {
      if (popcount(window & rankMask) === 4) fourWindows++;
    }
  }
  const straightDraw = fourWindows > 0;
  const openEnded = fourWindows >= 2;

  const boardTop = board.reduce((max, card) => Math.max(max, card.rank), 0);
  const overcards = hole.filter((card) => card.rank > boardTop).length;

  let outs = 0;
  if (flushDraw) outs += 9;
  if (openEnded) outs += 8;
  else if (straightDraw) outs += 4;
  if (overcards > 0 && evaluation.category === 0) outs += overcards * 3;
  outs = Math.min(outs, 15);

  return {
    flushDraw,
    backdoorFlush,
    straightDraw,
    openEnded,
    overcards,
    outs,
    hasDraw: flushDraw || straightDraw,
  };
}

/** 公共牌纹理对成牌强度的扣分。 */
function boardTexturePenalty(
  hole: readonly Card[],
  board: readonly Card[],
  evaluation: EvaluatedHand,
): number {
  let penalty = 0;
  const suitCounts = [0, 0, 0, 0];
  const boardRankCount = new Int8Array(15);
  let boardMask = 0;
  for (const card of board) {
    suitCounts[suitIndex(card)]++;
    boardRankCount[card.rank]++;
    boardMask |= 1 << card.rank;
  }
  const maxSuit = Math.max(...suitCounts);
  if (maxSuit >= 3 && evaluation.category < 5) penalty -= 0.05;
  if (evaluation.category < 4) {
    for (const window of STRAIGHT_WINDOWS) {
      if (popcount(window & boardMask) >= 4) {
        penalty -= 0.05;
        break;
      }
    }
  }
  if (board.length >= 5) {
    for (let rank = 2; rank <= 14; rank++) {
      if (boardRankCount[rank] >= 2 && evaluation.category < 2) {
        penalty -= 0.03;
        break;
      }
    }
  }
  // 公共牌非常高时，单对/高牌的相对价值下降。
  const boardTop = board.reduce((max, card) => Math.max(max, card.rank), 0);
  if (boardTop >= 13 && evaluation.category <= 1) penalty -= 0.02;
  void hole;
  return penalty;
}

/**
 * 翻牌后牌力分析。
 * @throws 公共牌不是 3-5 张时抛错。
 */
export function analyzePostflop(
  hole: readonly Card[],
  board: readonly Card[],
): PostflopAnalysis {
  if (board.length < 3 || board.length > 5) {
    throw new Error(`翻牌后分析需要 3-5 张公共牌，实际收到 ${board.length} 张`);
  }
  const evaluation = evaluate([...hole, ...board]);
  const category = evaluation.category;
  let made = CATEGORY_BASE[category];

  const boardRankCount = new Int8Array(15);
  const holeRankCount = new Int8Array(15);
  for (const card of board) boardRankCount[card.rank]++;
  for (const card of hole) holeRankCount[card.rank]++;
  const boardRanks = [...new Set(board.map((card) => card.rank))].sort((a, b) => b - a);
  const boardTop = boardRanks[0] ?? 0;
  const boardSecond = boardRanks[1] ?? 0;
  const pocketPair = hole[0].rank === hole[1].rank;

  if (category === 0) {
    if (holeRankCount[evaluation.kickers[0]] > 0) made += 0.03;
    made += Math.min(2, hole.filter((card) => card.rank > boardTop).length) * 0.018;
  } else if (category === 1) {
    const pairRank = evaluation.kickers[0];
    if (holeRankCount[pairRank] > 0 && boardRankCount[pairRank] > 0) {
      if (pairRank === boardTop) made += 0.14;
      else if (pairRank === boardSecond) made += 0.08;
      else made += 0.03;
    } else if (pocketPair && holeRankCount[pairRank] === 2) {
      made += pairRank > boardTop ? 0.18 : -0.04;
    } else if (boardRankCount[pairRank] >= 2) {
      made -= 0.03;
    }
    if ((evaluation.kickers[1] ?? 0) >= 12) made += 0.03;
    else if ((evaluation.kickers[1] ?? 0) >= 10) made += 0.015;
  } else if (category === 2) {
    const pairs = evaluation.kickers.slice(0, 2);
    const holePairs = pairs.filter((rank) => holeRankCount[rank] > 0).length;
    if (holePairs === 2) made += 0.05;
    else if (holePairs === 1) made += 0.02;
    else made -= 0.02;
  } else if (category === 3) {
    if (holeRankCount[evaluation.kickers[0]] > 0) made += 0.06;
    else made -= 0.02;
  }

  made += boardTexturePenalty(hole, board, evaluation);
  made = Math.max(0.02, Math.min(1, made));

  const draw = buildDrawInfo(hole, board, evaluation);
  let bonus = 0;
  if (category < 4) {
    if (draw.flushDraw) bonus += 0.12;
    if (draw.openEnded) bonus += 0.1;
    else if (draw.straightDraw) bonus += 0.05;
    bonus += Math.min(2, draw.overcards) * 0.015;
    if (draw.backdoorFlush) bonus += 0.01;
  }
  const strength = Math.max(0.02, Math.min(1, made + bonus));

  return {
    evaluation,
    strength,
    madeStrength: made,
    category,
    categoryName: CATEGORY_NAMES[category] ?? evaluation.categoryName,
    draw,
  };
}

/** 0..1 翻牌后综合强度（含听牌）。 */
export function postflopStrength(hole: readonly Card[], board: readonly Card[]): number {
  return analyzePostflop(hole, board).strength;
}

/** 0..1 仅成牌强度（beginner 使用）。 */
export function madeHandStrength(hole: readonly Card[], board: readonly Card[]): number {
  return analyzePostflop(hole, board).madeStrength;
}
