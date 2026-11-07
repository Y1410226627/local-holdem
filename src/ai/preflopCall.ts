/**
 * 翻前「面对大幅加注」的数学判定。
 *
 * 背景（这是被真实对局打脸后加的）：
 * 旧实现里翻前跟注只看一个条件——`起手牌百分位 >= 入池线`。
 * 也就是说面对「加注到 40」和「全下 2520」用的是**同一个跟注范围**，
 * `ctx.potOdds` 在翻前一次都没被读过。
 *
 * 实测后果：6 人桌有人 126BB 全下，机器人拿 J9o（对随机牌 52.9% 胜率）
 * 觉得「百分位 0.787 > 入池线 0.61」就跟了 2430。底池赔率需要 48.2%，
 * 而 J9o 对「全下范围」只有 30% 左右——这是一个明确的负 EV 跟注。
 *
 * 现在的做法：**算我方手牌对「对手加注范围」的胜率，再和底池赔率比。**
 * 对手范围用「前 X% 手牌」近似，X 由「要投入多少筹码 + 对手 PFR + 加注次数」决定：
 * 加注越大 / 对手越紧 / 加注轮次越多 → 范围越窄。
 *
 * 只用公开信息（自己底牌、底池、跟注额、筹码、对手公开统计），不读对手底牌。
 */
import { createDeck, shuffle } from '../game/cards';
import type { Card } from '../game/types';
import equityRaw from './data/preflop-equity.json';
import { showdownSign } from './solver/abstraction';

interface EquityEntry {
  equity: number;
  combos: number;
  chen: number;
}

const ENTRIES = (equityRaw as unknown as { entries: Record<string, EquityEntry> }).entries;
const TOTAL_COMBOS = 1326;

/** 169 个分类按真实胜率从高到低排好（只算一次）。 */
const CLASSES_BY_EQUITY: ReadonlyArray<[string, EquityEntry]> = Object.entries(ENTRIES).sort(
  (a, b) => b[1].equity - a[1].equity,
);

const RANK_FROM_TEXT: Record<string, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
};

function rankOf(text: string): number {
  return RANK_FROM_TEXT[text] ?? 0;
}

function sameCard(a: Card, b: Card): boolean {
  return a.rank === b.rank && a.suit === b.suit;
}

/**
 * 「前 percentile 比例的最强手牌」对应的分类键。
 *
 * 例：percentile = 0.10 → 返回按真实胜率排名累计占 10% 组合数的那些分类（AA/KK/QQ/AK…）。
 */
export function topRangeKeys(percentile: number): string[] {
  const target = Math.max(0, Math.min(1, percentile)) * TOTAL_COMBOS;
  const out: string[] = [];
  let cumulative = 0;
  for (const [key, info] of CLASSES_BY_EQUITY) {
    if (cumulative >= target) break;
    out.push(key);
    cumulative += info.combos;
  }
  return out;
}

/** 把一个分类键（"AA" / "AKs" / "T9o"）展开成具体两张牌的组合，牌从 deck 里取（天然排除已占用的牌）。 */
function expandKey(key: string, deck: readonly Card[]): Array<[Card, Card]> {
  const high = rankOf(key[0]);
  const low = rankOf(key[1]);
  const suited = key.length === 3 && key[2] === 's';
  const highCards = deck.filter((card) => card.rank === high);
  const lowCards = deck.filter((card) => card.rank === low);
  const out: Array<[Card, Card]> = [];

  if (high === low) {
    for (let i = 0; i < highCards.length; i++) {
      for (let j = i + 1; j < highCards.length; j++) {
        out.push([highCards[i], highCards[j]]);
      }
    }
    return out;
  }

  for (const first of highCards) {
    for (const second of lowCards) {
      if ((first.suit === second.suit) !== suited) continue;
      out.push([first, second]);
    }
  }
  return out;
}

/**
 * 我方手牌对「前 percentile 比例范围」的胜率（蒙特卡洛）。
 *
 * 复杂度：samples × (一次部分洗牌 + 两次 7 张牌评估)。200 次样本约 1ms，
 * 翻前每次决策只算一次，可以接受。
 */
export function equityVsTopRange(
  hero: readonly [Card, Card],
  percentile: number,
  rng: () => number,
  samples = 200,
): number {
  const deck = createDeck().filter((card) => !sameCard(card, hero[0]) && !sameCard(card, hero[1]));
  const keys = topRangeKeys(percentile);
  const combos: Array<[Card, Card]> = [];
  for (const key of keys) combos.push(...expandKey(key, deck));
  if (combos.length === 0) return 0.5;

  let score = 0;
  for (let index = 0; index < samples; index++) {
    const villain = combos[Math.floor(rng() * combos.length)];
    if (!villain) continue;
    const rest = deck.filter(
      (card) => !sameCard(card, villain[0]) && !sameCard(card, villain[1]),
    );
    const runout = shuffle(rest, rng).slice(0, 5);
    const sign = showdownSign(hero, villain, runout);
    score += sign > 0 ? 1 : sign === 0 ? 0.5 : 0;
  }
  return score / samples;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export interface RaiserRangeInput {
  /** 我们要跟的筹码占「自己总筹码」的比例（0..1）。1 表示跟了就套牢/全下。 */
  commitFraction: number;
  /** 对手公开 PFR（0..1，无样本传 null）。 */
  avgPfr: number | null;
  /** 本街已经发生的加注次数（含这次）。 */
  raiseCount: number;
}

/**
 * 估计对手加注范围有多窄（返回「前百分之几」，越小越窄）。
 *
 * 三个信号，方向都是常识：
 * - **要跟多少**：跟注额占自己筹码比例越高，对手越可能是在用强牌要价值（全下最窄）；
 * - **对手 PFR**：翻前加注率越低，他的加注越可信；
 * - **加注轮次**：limpers 后的加注、3-bet、4-bet 逐级收窄。
 */
export function estimateRaiserRange(input: RaiserRangeInput): number {
  const commit = clamp01(input.commitFraction);
  // 小注（commit≈0）→ 约 0.55；全下（commit≈1）→ 约 0.10
  const base = 0.10 + 0.45 * (1 - commit);
  // PFR 30% 以上视为松，10% 以下视为紧
  const tightness = input.avgPfr === null ? 0.5 : clamp01((0.3 - input.avgPfr) / 0.3);
  const tighten = 1 - 0.5 * tightness;
  const raiseTighten = 1 - Math.min(0.35, Math.max(0, input.raiseCount - 1) * 0.15);
  return Math.max(0.04, Math.min(0.6, base * tighten * raiseTighten));
}
