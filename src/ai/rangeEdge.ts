/**
 * 范围优势层（翻牌 / 转牌的下注尺度修正）：把 `rangeAdvantage` 的 `edge` 变成**有界**尺度调整。
 *
 * 为什么单独成文件：`rangeAdvantage.ts` 是纯度量（不产生行为），这一层是**策略**。
 * 把策略常量（门槛 / 上限 / clamp 边界）集中在这里，方便消融与复核，也便于单测直接钉住数值。
 *
 * 三条刻意的设计约束（改之前先读项目实测记录）：
 *   1. **不与纹理层叠同一维度**：本层拿到的是「纹理层已经算完的 sizeFactor」，
 *      只在它上面做 ≤±12% 的修正，最后再统一 clamp 回 [SIZE_FACTOR_MIN, SIZE_FACTOR_MAX]。
 *      纹理层自身取值只有 0.7 / 0.85 / 1 / 1.1 / 1.2（转牌 0.8 / 1 / 1.15），
 *      与本层连乘后自然区间是 [0.616, 1.344]，clamp 边界留了余量但能挡住「以后有人再加一层」。
 *   2. **只在信号足够强时生效**：`|edge|` 中位数只有 0.06，p90 = 0.18；
 *      不设门槛等于给绝大多数决策注入噪声。门槛内**逐位返回原值**。
 *   3. **乘子上限 ±12%**：单层最多让尺度变化一成二，不足以单独改变一手牌的价值，
 *      但足以在「范围明显占优的干燥面」上把 1/2 池推到接近 2/3 池。
 */
import type { Card } from '../game/types';
import { cardId } from '../game/cards';
import { rangeAdvantage, type RangeAdvantageRange } from './rangeAdvantage';

/** 生效门槛：|edge| ≤ 它时整层不生效（必须逐位不变）。 */
export const RANGE_EDGE_THRESHOLD = 0.1;

/** 乘子上限：最多 ±12%。 */
export const RANGE_EDGE_MAX_SWING = 0.12;

/**
 * 最终 sizeFactor 的硬边界。
 * 依据：现有两层纹理的取值范围是 [0.7, 1.2]，乘上 ±12% 后为 [0.616, 1.344]；
 * 取 [0.55, 1.65] 既不改变现有任何取值，又能挡住「多层连乘」导致的尺度失控。
 */
export const SIZE_FACTOR_MIN = 0.55;
export const SIZE_FACTOR_MAX = 1.65;

function clampSizeFactor(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(SIZE_FACTOR_MIN, Math.min(SIZE_FACTOR_MAX, value));
}

/**
 * 把范围优势折进尺度系数。
 *
 * @param baseSizeFactor 纹理层已经算完的系数（1 = 不改变）。**不要**在调用方再乘一次。
 * @param edge           `rangeAdvantage().edge`，-1..1；NaN / 缺数据传 0。
 * @returns 最终 sizeFactor，必然落在 [SIZE_FACTOR_MIN, SIZE_FACTOR_MAX]；
 *          `|edge| ≤ RANGE_EDGE_THRESHOLD` 时等于 `baseSizeFactor`（逐位相同）。
 */
export function rangeEdgeSizeFactor(baseSizeFactor: number, edge: number): number {
  if (!Number.isFinite(edge) || Math.abs(edge) <= RANGE_EDGE_THRESHOLD) {
    return clampSizeFactor(baseSizeFactor);
  }
  const bounded = Math.max(-1, Math.min(1, edge));
  return clampSizeFactor(baseSizeFactor * (1 + RANGE_EDGE_MAX_SWING * bounded));
}

/**
 * 算出当前局面的 edge，并用 `blockedCards` 把**对手**范围里的冲突组合清零。
 *
 * 为什么只清对手一侧：`deadCards` 在 `rangeAdvantage` 里对双方同时生效，
 * 而 `blockedCards` 通常是自己已知的底牌——自己的范围本来就该包含自己这手牌，
 * 一起清掉会把「我实际拿的那一手」从自己的范围里删掉。
 */
export function rangeEdgeFromRanges(
  board: readonly Card[],
  heroRange: RangeAdvantageRange,
  villainRange: RangeAdvantageRange,
  blockedCards: readonly Card[] = [],
): number {
  if (!heroRange || !villainRange) return 0;
  const excluded = new Set(blockedCards.map(cardId));
  const villainFiltered =
    typeof villainRange === 'function'
      ? (first: Card, second: Card) =>
          excluded.has(cardId(first)) || excluded.has(cardId(second)) ? 0 : villainRange(first, second)
      : villainRange;
  const result = rangeAdvantage({ board, heroRange, villainRange: villainFiltered });
  return Number.isFinite(result.edge) ? result.edge : 0;
}
