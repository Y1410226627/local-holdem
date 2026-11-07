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
  /** 加注额相对底池的倍数（用于识别「超池全下」这类异常尺度）。 */
  raiseToPotRatio?: number;
  /** 我们要跟的筹码占「自己总筹码」的比例（0..1）。1 表示跟了就套牢/全下。 */
  commitFraction: number;
  /** 对手公开 PFR（0..1，无样本传 null）。 */
  avgPfr: number | null;
  /**
   * 「有加注机会时」的加注率（0..1）。优先于 avgPfr 使用。
   *
   * avgPfr 的分母包含他根本没轮到动作的手，所以一个「每轮到我加注我就加」的疯子
   * 也只有 75%，会被估成「前 75% 范围」。实测 BB 面对他的 100BB 全下时，
   * 估计权益比真实低 5 个百分点，150 手里有 28 次该跟没跟，白扔 2215 筹码（≈74 BB/100）。
   */
  pfrOpportunity?: number | null;
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
  const ratio = input.raiseToPotRatio ?? 0;
  // 优先用「有加注机会时的加注率」：它才是「他多常用加注这个动作」的无偏估计。
  const measured =
    input.pfrOpportunity !== null && input.pfrOpportunity !== undefined
      ? clamp01(input.pfrOpportunity)
      : input.avgPfr === null
        ? null
        : clamp01(input.avgPfr);

  // 「他加注了」这个事实有两种解释，取决于他平时多爱加注：
  //   ① 价值线：他用强牌要价值 → 范围由「押上多少筹码」决定（全下最窄）；
  //   ② 疯子线：他本来就什么都加 → 范围就是他的 PFR。
  // 旧实现只有 ①，于是把「每手都全下」的对手当成「前 7% 的强牌」，
  // 实测 BB 面对 100BB 全下时给 Q9o 估 32.0% 权益（对随机牌真实 55.1%），
  // 该跟的牌全弃了——这就是专家档对全下怪只有 +63.8 BB/100 而 v0.3.0 有 +313 的原因。
  //
  // 用 PFR 做「疯子线」的可信度：PFR 35% 以下完全按价值线，70% 以上完全按疯子线。
  const maniacWeight = measured === null ? 0 : clamp01((measured - 0.35) / 0.35);
  // 紧手（PFR < 30%）的加注更可信：他平时很少加，加了就是强牌。无样本时取中间值。
  const tightness = measured === null ? 0.5 : clamp01((0.3 - measured) / 0.3);
  const valueRange = (0.10 + 0.45 * (1 - commit)) * (1 - 0.5 * tightness);
  const maniacRange = measured === null ? valueRange : Math.max(0.05, measured);
  let range = valueRange * (1 - maniacWeight) + maniacRange * maniacWeight;

  // 3-bet / 4-bet 是开池范围的子集，逐级收窄。
  // 但这条只对「理性对手」成立：一个每次轮到他加注就加的人，3-bet 范围不会比开池窄，
  // 所以按 maniacWeight 把收窄关掉（否则会把他的全下范围从 100% 压到 85%）。
  const raiseTighten =
    1 - Math.min(0.35, Math.max(0, input.raiseCount - 1) * 0.15) * (1 - maniacWeight);
  range *= raiseTighten;

  // 超池大注在没有 PFR 样本时仍按「可能是疯子」放宽。
  // 有样本时这条已被 maniacWeight 覆盖，不再重复叠加（否则会对紧手也放宽）。
  if (measured === null && ratio >= 6) {
    range += Math.min(0.45, (ratio - 6) * 0.02);
  }

  return Math.max(0.04, Math.min(1, range));
}
