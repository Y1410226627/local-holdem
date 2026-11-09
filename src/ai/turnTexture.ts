import type { Card } from '../game/types';

/**
 * 转牌纹理：判断这张转牌是「空白牌」还是「吓人的牌」。
 *
 * 翻牌层解决的是「这个面该怎么打」，转牌层要解决的是「这张新牌改变了什么」。
 * 同一手牌，转牌掉一张 2 和掉一张 A，进攻方的持续下注频率要差一倍以上：
 * 空白牌不改变双方范围对比，可以继续小尺度施压；高张 / 完成同花 / 成对的牌
 * 会显著改变范围结构，应当降低下注频率。
 *
 * 纯函数，不产生行为；是否使用由调用方决定（当前仅挑战档）。
 */
export interface TurnTexture {
  /** 0 = 完全空白，1 = 极度吓人。 */
  scare: number;
  /** 是否为空白牌（不配对、不成花、不连张、非高张）。 */
  blank: boolean;
  /** 是否高于翻牌所有牌（overcard）。 */
  overcard: boolean;
  /** 是否让公共牌出现四张同花。 */
  flushComplete: boolean;
  /** 是否让公共牌成对。 */
  paired: boolean;
  /** 是否与翻牌形成顺子潜力（与任一张翻牌点数差 ≤ 2）。 */
  straightish: boolean;
}

/** 转牌层的空白值：牌面不足 4 张时返回，调用方据此跳过调整。 */
export const TURN_NEUTRAL: TurnTexture = {
  scare: 0.5,
  blank: false,
  overcard: false,
  flushComplete: false,
  paired: false,
  straightish: false,
};

/**
 * @param board 当前公共牌（含这张新牌）。转牌长度 4、河牌长度 5，取**最后一张**作为新牌，
 *              其余作为「之前几条街」用于比较。
 */
export function turnTexture(board: readonly Card[]): TurnTexture {
  if (board.length < 4) return TURN_NEUTRAL;

  const turn = board[board.length - 1];
  const seen = board;

  const suitCount = new Map<string, number>();
  for (const card of seen) suitCount.set(card.suit, (suitCount.get(card.suit) ?? 0) + 1);
  const flushComplete = Math.max(...suitCount.values()) >= 4;

  const ranks = seen.map((c) => c.rank);
  const paired = new Set(ranks).size < seen.length;

  const priorRanks = board.slice(0, board.length - 1).map((c) => c.rank);
  const overcard = turn.rank > Math.max(...priorRanks);
  const straightish = priorRanks.some((r) => Math.abs(turn.rank - r) <= 2);

  let scare = 0;
  if (flushComplete) scare += 0.5;
  else if ((suitCount.get(turn.suit) ?? 0) === 3) scare += 0.2; // 三张同花，听牌变多
  if (overcard) scare += 0.25;
  if (paired) scare += 0.15;
  if (straightish) scare += 0.15;
  if (turn.rank >= 13) scare += 0.1; // A / K 额外加一点

  return {
    scare: Math.max(0, Math.min(1, scare)),
    blank: !flushComplete && !paired && !overcard && !straightish && turn.rank < 11,
    overcard,
    flushComplete,
    paired,
    straightish,
  };
}

/** 转牌下注尺度修正：空白牌略缩小（继续小尺度施压），吓人的牌放大或收手。 */
export function turnSizeFactor(texture: TurnTexture): number {
  if (texture.blank) return 0.8;
  if (texture.scare >= 0.6) return 1.15;
  return 1;
}

/**
 * 转牌「二次开火」倾向：空白牌上继续施压的收益最高（对手范围没改善），
 * 完成同花 / 高张则应当明显收敛——这些牌面对跟注方有利。
 */
export function turnBarrelTendency(texture: TurnTexture): number {
  if (texture.flushComplete) return 0;
  if (texture.scare >= 0.6) return 0.1;
  if (texture.blank) return 0.4;
  return 0.2;
}
