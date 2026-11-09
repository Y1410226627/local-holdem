/**
 * 范围优势：判断「谁的范围更契合这个牌面」。
 *
 * 为什么需要它：`flopTexture` / `turnTexture` 两层都只看**牌面**（湿润度、吓人牌），
 * 不看**范围**。同样是干燥面，可能是我方范围更契合（该用大尺度榨价值），
 * 也可能是对手范围更契合（该用小尺度范围下注甚至少下注）。纹理代理分不出这两种情况。
 *
 * 做法：把双方的范围权重摊在公共牌上，逐组合算一个「牌面契合分」，再比较加权均值。
 *   - edge           = (heroMean − villainMean) / (heroMean + villainMean)，范围 −1..1；
 *   - nutShare       = 我方范围里「三条及以上」的权重占比；
 *   - villainHitShare = 对手范围里「至少一对」的权重占比。
 *
 * 纯函数：不读时钟、不读随机、不写任何全局状态；同样的输入必然得到同样的输出。
 * 本模块**不产生行为**，是否使用由调用方决定。
 *
 * 诚实限制（重要，不要当成「范围对范围胜率」用）：
 *   1. `boardScore` 是**牌力分档的代理**，不是对对手范围的权益。它只看
 *      「我这手牌在这个面上有多强」，不看对手可能拿什么。所以 edge 是
 *      「双方范围平均牌力的差」，不是「我方范围对该面的权益优势」。
 *   2. 分档是绝对的，不随牌面重新标定：公共牌自己成顺 / 成花时，双方都会被判成
 *      同一档（这正是实际情况，但顺带抹掉了「谁的花更大」这类信息）。
 *   3. 听牌只给「没成牌」的桶加几分，永远低于「一对」的成牌线，所以
 *      `villainHitShare` 只统计**成牌**，不含听牌。
 *   4. 范围权重必须由调用方传入；拿不到任何一侧就退化为中性（edge = 0），不猜。
 */
import type { Card } from '../game/types';
import { SUIT_INDEX, cardId, createDeck } from '../game/cards';

/** 单挑组合的权重（未归一化即可，函数内部按各侧总量归一）。 */
export interface WeightedCombo {
  first: Card;
  second: Card;
  weight: number;
}

/**
 * 范围输入：显式组合数组，或者与 `equity.RangeWeight` 同签名的权重函数。
 * `null` / `undefined` / 空数组都表示「拿不到这个范围」→ 中性。
 */
export type RangeAdvantageRange =
  | readonly WeightedCombo[]
  | ((first: Card, second: Card) => number)
  | null
  | undefined;

export interface RangeAdvantageInput {
  /** 公共牌，3~5 张；不足 3 张直接返回中性（翻牌前没有「范围优势」可言）。 */
  board: readonly Card[];
  heroRange?: RangeAdvantageRange;
  villainRange?: RangeAdvantageRange;
  /**
   * 枚举组合时要排除的牌（自己的底牌、已知死牌）。
   * 只对**函数形式**的范围生效——数组形式已经由调用方决定包含哪些组合。
   */
  deadCards?: readonly Card[];
}

export interface RangeAdvantage {
  /** -1..1：>0 表示我方范围在这个面上更强，<0 表示对手更强。 */
  edge: number;
  /** 我方范围内的坚果占比（0..1）：三条及以上的权重占比，用于判断能否大尺度施压。 */
  nutShare: number;
  /** 对手范围里被这个面「打中」的比例（0..1）：至少一对的权重占比。 */
  villainHitShare: number;
}

/** 中性结果：范围不可得 / 牌面不足时的返回值。 */
export const NEUTRAL_RANGE_ADVANTAGE: RangeAdvantage = {
  edge: 0,
  nutShare: 0,
  villainHitShare: 0,
};

/** 成牌线：一对及以上的最低分。低于它的都是「没打中这个面」。 */
const HIT_LINE = 0.42;
/** 坚果线：三条的分值。三条 / 顺子 / 同花 / 葫芦 / 四条都算坚果。 */
const NUT_LINE = 0.84;

/** 五张顺子窗口的 rank 位掩码（与 rangeModel 同构，此处为热路径单独内联）。 */
const STRAIGHT_WINDOWS: readonly number[] = (() => {
  const windows: number[] = [];
  for (let high = 14; high >= 5; high--) {
    let mask = 0;
    if (high === 5) {
      for (const rank of [14, 2, 3, 4, 5]) mask |= 1 << rank;
    } else {
      for (let rank = high; rank > high - 5; rank--) mask |= 1 << rank;
    }
    windows.push(mask);
  }
  return windows;
})();

/** 完整 52 张牌（常量数据，不随调用变化）。 */
const FULL_DECK: readonly Card[] = createDeck();
/** 与 FULL_DECK 一一对应的牌 id，避免内层循环里反复做花色查表。 */
const FULL_DECK_IDS: readonly number[] = FULL_DECK.map(cardId);

interface BoardContext {
  /** rank → 该 rank 在公共牌里的张数。 */
  rankCount: Int8Array;
  /** 花色下标 → 公共牌里该花色的张数。 */
  suitCount: Int8Array;
  /** 公共牌最大 rank。 */
  top: number;
  /** 公共牌次大 rank。 */
  second: number;
  /** 公共牌里出现 ≥2 次的 rank 个数。 */
  boardPairCount: number;
  /** 公共牌自己就成花（此时所有人同档）。 */
  boardFlush: boolean;
  /**
   * 每个顺子窗口里「公共牌缺的 rank」位掩码，只保留缺失 ≤3 张的窗口。
   * 缺 0 张 → 顺子；缺 1 张 → 听牌；缺 2~3 张 → 本手牌不可能补成（底牌只有 2 张）。
   */
  windows: number[];
}

function buildBoardContext(board: readonly Card[]): BoardContext {
  const rankCount = new Int8Array(15);
  const suitCount = new Int8Array(4);
  let rankMask = 0;
  for (const card of board) {
    rankCount[card.rank]++;
    suitCount[SUIT_INDEX[card.suit]]++;
    rankMask |= 1 << card.rank;
  }
  let top = 0;
  let second = 0;
  let boardPairCount = 0;
  for (let rank = 14; rank >= 2; rank--) {
    if (rankCount[rank] >= 2) boardPairCount++;
    if (rankCount[rank] === 0) continue;
    if (top === 0) top = rank;
    else if (second === 0) second = rank;
  }
  let boardFlush = false;
  for (let suit = 0; suit < 4; suit++) if (suitCount[suit] >= 5) boardFlush = true;
  const windows: number[] = [];
  for (const window of STRAIGHT_WINDOWS) {
    const absent = window & ~rankMask;
    if (popcount(absent) <= 3) windows.push(absent);
  }
  return { rankCount, suitCount, top, second, boardPairCount, boardFlush, windows };
}

function popcount(value: number): number {
  let count = 0;
  let rest = value;
  while (rest) {
    rest &= rest - 1;
    count++;
  }
  return count;
}

/**
 * 单手牌对这个牌面的契合分（0..1，分档固定）。
 * 分档：四条 .99 / 葫芦 .97 / 同花 .94 / 顺子 .90 / 三条 .84 / 两对 .70 /
 * 一对 .38~.66（顶对 > 中对 > 底对，超对单列）/ 高牌 .16~.33（含听牌加成）。
 * 只有「一对及以上」会被计成 hit；只有「三条及以上」会被计成 nut。
 */
function boardScore(a: Card, b: Card, board: readonly Card[], ctx: BoardContext): number {
  const high = a.rank >= b.rank ? a : b;
  const low = a.rank >= b.rank ? b : a;
  const r1 = high.rank;
  const r2 = low.rank;
  const pocket = r1 === r2;
  const boardHit1 = ctx.rankCount[r1];
  const boardHit2 = pocket ? 0 : ctx.rankCount[r2];
  const total1 = boardHit1 + (pocket ? 2 : 1);
  const total2 = pocket ? 0 : boardHit2 + 1;

  // 含公共牌自带的对子，但不重复计数（公共牌已有该 rank 的对子时不再加一次）。
  let pairs = ctx.boardPairCount;
  if (total1 >= 2 && boardHit1 < 2) pairs++;
  if (!pocket && total2 >= 2 && boardHit2 < 2) pairs++;

  if (total1 >= 4 || total2 >= 4) return 0.99; // 四条
  const trips = total1 >= 3 || total2 >= 3;
  if (trips && pairs >= 2) return 0.97; // 葫芦（三条 + 另一个对子）

  const s1 = SUIT_INDEX[high.suit];
  const s2 = SUIT_INDEX[low.suit];
  // 口袋对不可能是同花（组合里没有两张一模一样的牌），所以 suited 直接等价于「两张不同 rank 同花」。
  const suitedHole = s1 === s2;
  const seatSuit1 = ctx.suitCount[s1] + 1 + (suitedHole ? 1 : 0);
  const seatSuit2 = suitedHole ? seatSuit1 : ctx.suitCount[s2] + 1;
  const flush = ctx.boardFlush || seatSuit1 >= 5 || seatSuit2 >= 5;

  if (flush) return 0.94;

  // 顺子 / 听牌：只看「公共牌缺哪几张」。底牌最多补 2 张，所以只需扫缺失 ≤3 的窗口。
  const holeInv = ~((1 << r1) | (1 << r2));
  let straight = false;
  let fourWindows = 0;
  for (const absent of ctx.windows) {
    const need = absent & holeInv;
    if (need === 0) {
      straight = true;
      break;
    }
    if ((need & (need - 1)) === 0) fourWindows++; // 只缺 1 张 = 听牌
  }

  if (straight) return 0.9;
  if (trips) return 0.84;
  if (pairs >= 2) return 0.7;

  if (pairs === 1) {
    if (total1 >= 2) {
      if (boardHit1 === 0) return r1 > ctx.top ? 0.63 : 0.46; // 超对 / 低于牌面的口袋对
      if (r1 === ctx.top) return 0.62; // 顶对
      if (r1 === ctx.second) return 0.54; // 第二对
      return 0.46;
    }
    if (!pocket && total2 >= 2) {
      if (r2 === ctx.top) return 0.6;
      if (r2 === ctx.second) return 0.53;
      return 0.45;
    }
    return 0.38; // 只有公共牌自己成对：双方一样，不算「打中」
  }

  // 高牌：只有过牌 + 听牌加成，永远低于 HIT_LINE。
  let score = 0.16;
  if (r1 > ctx.top) score += 0.045;
  if (!pocket && r2 > ctx.top) score += 0.03;
  if (board.length < 5) {
    if (seatSuit1 === 4 || seatSuit2 === 4) score += 0.08; // 同花听牌
    if (fourWindows >= 2) score += 0.06; // 两头顺（或双卡顺）
    else if (fourWindows === 1) score += 0.03; // 卡顺
  }
  return Math.min(0.33, score);
}

interface RangeSummary {
  /** 权重总和。 */
  total: number;
  /** Σ weight × score。 */
  scoreSum: number;
  /** 坚果权重（score ≥ NUT_LINE）。 */
  nutWeight: number;
  /** 打中权重（score ≥ HIT_LINE）。 */
  hitWeight: number;
}

const EMPTY_SUMMARY: RangeSummary = { total: 0, scoreSum: 0, nutWeight: 0, hitWeight: 0 };

function accumulate(summary: RangeSummary, weight: number, score: number): void {
  summary.total += weight;
  summary.scoreSum += weight * score;
  if (score >= NUT_LINE) summary.nutWeight += weight;
  if (score >= HIT_LINE) summary.hitWeight += weight;
}

/**
 * 汇总一侧范围。
 * @returns null 表示这一侧没有可用数据（缺失 / 全零权重）。
 */
function summarize(
  range: RangeAdvantageRange,
  board: readonly Card[],
  ctx: BoardContext,
  blocked: Uint8Array,
): RangeSummary | null {
  if (!range) return null;
  const summary: RangeSummary = { total: 0, scoreSum: 0, nutWeight: 0, hitWeight: 0 };

  if (typeof range === 'function') {
    for (let i = 0; i < FULL_DECK.length; i++) {
      const first = FULL_DECK[i];
      if (blocked[FULL_DECK_IDS[i]] === 1) continue;
      for (let j = i + 1; j < FULL_DECK.length; j++) {
        const second = FULL_DECK[j];
        if (blocked[FULL_DECK_IDS[j]] === 1) continue;
        const weight = range(first, second);
        if (!(weight > 0) || !Number.isFinite(weight)) continue;
        accumulate(summary, weight, boardScore(first, second, board, ctx));
      }
    }
  } else {
    for (const combo of range) {
      const weight = combo.weight;
      if (!(weight > 0) || !Number.isFinite(weight)) continue;
      accumulate(summary, weight, boardScore(combo.first, combo.second, board, ctx));
    }
  }
  return summary.total > 0 ? summary : null;
}

/**
 * 范围优势。
 *
 * 复杂度：函数形式最多枚举 C(52−3,2)=1176 个组合 / 侧，数组形式按条目数；
 * 单次调用在实测中约 0.2~0.5ms（10,000 次 < 10 秒的用例守住了这个量级）。
 *
 * 任一侧范围缺失 → `edge = 0`（中性），并把能算的那一侧的占比照常返回。
 */
export function rangeAdvantage(input: RangeAdvantageInput): RangeAdvantage {
  const board = input.board;
  if (board.length < 3 || board.length > 5) return { ...NEUTRAL_RANGE_ADVANTAGE };

  const blocked = new Uint8Array(52);
  for (const card of board) blocked[cardId(card)] = 1;
  if (input.deadCards) for (const card of input.deadCards) blocked[cardId(card)] = 1;

  const ctx = buildBoardContext(board);
  const hero = summarize(input.heroRange, board, ctx, blocked) ?? EMPTY_SUMMARY;
  const villain = summarize(input.villainRange, board, ctx, blocked) ?? EMPTY_SUMMARY;

  const heroMean = hero.total > 0 ? hero.scoreSum / hero.total : 0;
  const villainMean = villain.total > 0 ? villain.scoreSum / villain.total : 0;
  let edge = 0;
  if (hero.total > 0 && villain.total > 0) {
    const denom = heroMean + villainMean;
    // 分母加极小量只为避免 0/0；分子分母同时取反，交换双方后 edge 精确取负。
    edge = denom > 1e-9 ? (heroMean - villainMean) / (denom + 1e-6) : 0;
    if (edge > 1) edge = 1;
    else if (edge < -1) edge = -1;
  }

  return {
    edge,
    nutShare: hero.total > 0 ? hero.nutWeight / hero.total : 0,
    villainHitShare: villain.total > 0 ? villain.hitWeight / villain.total : 0,
  };
}
