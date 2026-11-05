/**
 * B3 叶节点价值（continuation value）：
 * 先查离线表 `data/gto-continuation.json`（街 × 胜率桶 × SPR 桶，线性插值），
 * 表缺失时回退解析近似。接口保持不变，后续可用自博弈数据替换表内容。
 * 在深度受限搜索里，除了当前街 EV，还需要估计「走到下一街还能赢/再输多少」。
 * 完整做法是离线自博弈生成 continuation-value 表；本文件先提供解析近似公式，
 * 后续可替换为 `gto-continuation.json` 查表（接口不变）。
 *
 * 输入只包含公开信息（街、胜率、底池、有效筹码、对手数）。
 */

import continuationTable from './data/gto-continuation.json';

export interface ContinuationValueInput {
  street: 'preflop' | 'flop' | 'turn' | 'river';
  equity: number;
  pot: number;
  /** 有效筹码（我方与对手的较小值）。 */
  effectiveStack: number;
  opponentCount: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * 估算继续游戏的期望超额价值（筹码）：
 * - 胜率高于 50% → 正价值（未来还能价值下注），低于 50% → 负价值（未来继续跟注/弃牌成本）；
 * - SPR 越高、剩余街越多，未来可下注空间越大；
 * - 多人底池打折。
 */
export function continuationValue(input: ContinuationValueInput): number {
  const { equity, pot } = input;
  const street = input.street ?? 'turn';
  const effectiveStack = Number.isFinite(input.effectiveStack) ? input.effectiveStack : 100;
  const opponentCount = Number.isFinite(input.opponentCount) ? input.opponentCount : 1;
  const potSafe = Math.max(1, pot);
  const remainingStreets = street === 'river' ? 0.15 : street === 'turn' ? 0.55 : street === 'flop' ? 0.8 : 0.9;
  const spr = Math.max(0.1, effectiveStack / potSafe);
  const sprScale = Math.min(1.2, Math.max(0.15, spr / 4));
  const edge = clamp01(equity) - 0.5;
  const multiway = 1 / Math.max(1, opponentCount);
  // B3：优先查离线 continuation 表（线性插值），表缺失时回退解析近似。
  const table = continuationTable as {
    equityBuckets: number[];
    sprBuckets: number[];
    streets: Record<string, { values: number[][] }>;
  };
  const streetKey = ['preflop', 'flop', 'turn', 'river'].includes(street) ? street : 'turn';
  const streetTable = table.streets[streetKey];
  if (streetTable) {
    const equityIndex = nearestIndex(table.equityBuckets, clamp01(equity));
    const sprIndex = nearestIndex(table.sprBuckets, Math.max(0.25, Math.min(8, spr)));
    const base = streetTable.values[equityIndex]?.[sprIndex];
    if (typeof base === 'number' && Number.isFinite(base)) {
      return potSafe * base * multiway;
    }
  }
  return potSafe * remainingStreets * sprScale * edge * multiway * 0.6;
}

function nearestIndex(values: readonly number[], target: number): number {
  let best = 0;
  for (let index = 1; index < values.length; index++) {
    if (Math.abs(values[index] - target) < Math.abs(values[best] - target)) best = index;
  }
  return best;
}
