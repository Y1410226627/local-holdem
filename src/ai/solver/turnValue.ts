/**
 * 转牌价值函数（B 路线）：用一个小 MLP 预测「从转牌这个节点往后还值多少」。
 *
 * 为什么需要它：翻牌蓝图（A 路线）的叶子是转牌，之前用「权益 × 底池 × 固定实现率」
 * 估终局，实测 −19 BB/100。DeepStack 的做法是用价值网络替代固定估值，
 * 这里做一个**同构但极小**的版本：12 维特征 → 16 单元隐藏层 → 1 个标量。
 *
 * 训练标签来自**精确的转河求解器**（`solveTurnRiver` 的 `rootValueFromNow`），
 * 不是自我对局估出来的——这是它能可信的前提。
 *
 * 输出归一化：EV / 底池，范围大致 −1..+2，跨筹码深度可复用。
 */
import type { Card } from '../../game/types';
import type { PlayerView } from '../../game/playerView';
import { analyzePostflop } from '../rangeModel';

export const TURN_VALUE_FEATURES = 12;
export const TURN_VALUE_HIDDEN = 16;

export interface TurnValueWeights {
  /** [hidden][features] */
  w1: number[][];
  /** [hidden] */
  b1: number[];
  /** [hidden] */
  w2: number[];
  b2: number;
}

/**
 * 特征向量（全部可由公开信息 + 自己底牌算出）。
 *
 * 刻意只用 12 维：特征越多越容易过拟合，而样本只能靠求解器一个个生成（每个约 150ms）。
 */
export function turnValueFeatures(view: PlayerView): number[] {
  const hole = view.self.holeCards as [Card, Card];
  const board = view.board;
  const analysis = analyzePostflop(hole, board);
  const pot = Math.max(1, view.pot);
  const call = Math.max(0, view.legal?.callAmount ?? 0);
  const spr = Math.min(10, view.self.stack / pot);
  const turnCard = board[board.length - 1];
  const boardHigh = Math.max(...board.map((card: Card) => card.rank));

  const boardRanks = new Set(board.map((card: Card) => card.rank));
  const pairedBoard = board.length !== boardRanks.size ? 1 : 0;
  const overcard = Math.max(hole[0].rank, hole[1].rank) > boardHigh ? 1 : 0;

  return [
    analysis.madeStrength,
    analysis.strength,
    analysis.draw.flushDraw ? 1 : 0,
    analysis.draw.hasDraw ? 1 : 0,
    pairedBoard,
    overcard,
    pot / 200, // 底池相对 100BB 的规模
    call / pot, // 底池赔率
    spr / 10,
    turnCard ? turnCard.rank / 14 : 0,
    boardHigh / 14,
    view.legal?.canCheck ? 0 : 1, // 是否面对下注
  ];
}

function relu(value: number): number {
  return value > 0 ? value : 0;
}

/** 前向传播：返回 EV / 底池。 */
export function turnValueForward(features: readonly number[], weights: TurnValueWeights): number {
  let out = weights.b2;
  for (let h = 0; h < weights.w1.length; h++) {
    let sum = weights.b1[h] ?? 0;
    const row = weights.w1[h];
    for (let f = 0; f < features.length; f++) sum += row[f] * features[f];
    out += weights.w2[h] * relu(sum);
  }
  return out;
}

/** 零初始化（训练前的占位）。 */
export function zeroWeights(): TurnValueWeights {
  return {
    w1: Array.from({ length: TURN_VALUE_HIDDEN }, () => new Array(TURN_VALUE_FEATURES).fill(0)),
    b1: new Array(TURN_VALUE_HIDDEN).fill(0),
    w2: new Array(TURN_VALUE_HIDDEN).fill(0),
    b2: 0,
  };
}

/**
 * 把网络预测换算成筹码。
 *
 * 输出是 EV / 底池，所以乘回底池就是「从当前节点往后还值多少筹码」——
 * 这正是翻牌蓝图叶子需要的量纲。
 */
export function turnValueChips(
  view: PlayerView,
  weights: TurnValueWeights | null,
): number | null {
  if (!weights) return null;
  const pot = Math.max(1, view.pot);
  return turnValueForward(turnValueFeatures(view), weights) * pot;
}
