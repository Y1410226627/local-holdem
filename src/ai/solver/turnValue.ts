/**
 * 转牌价值函数（B 路线）：用一个小 MLP 预测「从转牌这个节点往后还值多少」。
 *
 * 为什么需要它：翻牌蓝图（A 路线）的叶子是转牌，之前用「权益 × 底池 × 固定实现率」
 * 估终局，实测 −19 BB/100。DeepStack 的做法是用价值网络替代固定估值，
 * 这里做一个**同构但极小**的版本。
 *
 * 训练标签来自**精确的转河求解器**（`solveTurnRiver` 的 `rootValueFromNow`），
 * 不是自我对局估出来的——这是它能可信的前提。
 *
 * v0.24.0 的三处改动（上一版留出集 R² 只有 0.378，接进蓝图后 −8.9 BB/100）：
 *   ① 特征 12 → 24：加入成牌类别 one-hot、听牌细分、牌面同花度与连接度。
 *      旧版把「成牌强度」和「含听牌强度」两个标量当全部信息，网络分不清
 *      「一对 + 同花听牌」和「两对无听牌」——而这两种牌的转牌价值差一倍。
 *   ② 输入改成「底牌 + 牌面 + 底池 + 跟注额 + 筹码」的原始量，
 *      不再依赖 PlayerView。翻牌蓝图的叶子必须能用**合成局面**调用它，
 *      旧实现只能喂桶下标、听牌恒填 0，训练分布和推理分布完全不同。
 *   ③ 隐藏层 16 → 48。
 *
 * 输出归一化：EV / 底池，范围大致 −1..+2，跨筹码深度可复用。
 */
import type { Card } from '../../game/types';
import type { PlayerView } from '../../game/playerView';
import { analyzePostflop } from '../rangeModel';

export const TURN_VALUE_FEATURES = 24;
export const TURN_VALUE_HIDDEN = 48;

export interface TurnValueWeights {
  /** [hidden][features] */
  w1: number[][];
  /** [hidden] */
  b1: number[];
  /** [hidden] */
  w2: number[];
  b2: number;
}

/** 只依赖公开信息的局面描述；翻牌蓝图可以用合成局面调用。 */
export interface TurnValueInput {
  hole: readonly [Card, Card];
  /** 转牌圈是 4 张。 */
  board: readonly Card[];
  pot: number;
  callAmount: number;
  /** 自己剩余筹码。 */
  stack: number;
  canCheck: boolean;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * 特征向量（24 维，全部可由公开信息 + 自己底牌算出）。
 *
 * 设计原则：**每一维都要在训练集和推理时同分布**。
 * 桶下标、桶中点这类量不能进特征——它在合成局面里没有意义。
 */
export function turnValueFeaturesOf(input: TurnValueInput): number[] {
  const { hole, board } = input;
  const analysis = analyzePostflop(hole, board);
  const pot = Math.max(1, input.pot);
  const call = Math.max(0, input.callAmount);
  const spr = Math.min(10, input.stack / pot);
  const turnCard = board[board.length - 1];
  const boardHigh = board.length ? Math.max(...board.map((card) => card.rank)) : 0;

  const boardRanks = new Set(board.map((card) => card.rank));
  const boardPaired = board.length !== boardRanks.size ? 1 : 0;

  const suitCount = new Map<string, number>();
  for (const card of board) suitCount.set(card.suit, (suitCount.get(card.suit) ?? 0) + 1);
  const boardSuitMax = Math.max(0, ...suitCount.values());

  const ranks = board.map((card) => card.rank).sort((a, b) => a - b);
  const boardSpan = ranks.length ? ranks[ranks.length - 1] - ranks[0] : 0;

  const holeOnBoard = hole.some((card) => boardRanks.has(card.rank)) ? 1 : 0;
  const category = analysis.category;
  const draw = analysis.draw;

  return [
    clamp01(analysis.madeStrength),
    clamp01(analysis.strength),
    draw.flushDraw ? 1 : 0,
    draw.hasDraw ? 1 : 0,
    draw.openEnded ? 1 : 0,
    draw.backdoorFlush ? 1 : 0,
    clamp01(draw.overcards / 2),
    clamp01(draw.outs / 15),
    clamp01(pot / 200),
    clamp01(call / pot),
    spr / 10,
    turnCard ? turnCard.rank / 14 : 0,
    boardHigh / 14,
    input.canCheck ? 0 : 1,
    // 成牌类别 one-hot（高牌 / 一对 / 两对 / 三条 / 顺子 / 同花及以上）
    category === 0 ? 1 : 0,
    category === 1 ? 1 : 0,
    category === 2 ? 1 : 0,
    category === 3 ? 1 : 0,
    category === 4 ? 1 : 0,
    category >= 5 ? 1 : 0,
    boardSuitMax / 3,
    clamp01(boardSpan / 12),
    holeOnBoard,
    boardPaired,
  ];
}

/** PlayerView 版本的包装（训练与运行时用）。 */
export function turnValueFeatures(view: PlayerView): number[] {
  return turnValueFeaturesOf({
    hole: view.self.holeCards as [Card, Card],
    board: view.board,
    pot: view.pot,
    callAmount: view.legal?.callAmount ?? 0,
    stack: view.self.stack,
    canCheck: view.legal?.canCheck ?? true,
  });
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
