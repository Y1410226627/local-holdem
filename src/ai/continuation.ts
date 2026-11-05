/**
 * B3 叶节点价值（continuation value）近似：
 * 在深度受限搜索里，除了当前街 EV，还需要估计「走到下一街还能赢/再输多少」。
 * 完整做法是离线自博弈生成 continuation-value 表；本文件先提供解析近似公式，
 * 后续可替换为 `gto-continuation.json` 查表（接口不变）。
 *
 * 输入只包含公开信息（街、胜率、底池、有效筹码、对手数）。
 */

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
  return potSafe * remainingStreets * sprScale * edge * multiway * 0.6;
}
