/**
 * 蒙特卡洛胜率估算（纯本地、确定性）。
 *
 * 只使用 PlayerView 中允许的信息：
 * - 自己的底牌；
 * - 公共牌；
 * - 未弃牌对手的数量（active / allin）。
 *
 * 未知牌从 52 张中排除已知牌后无放回采样；每轮补全公共牌，并给每个对手
 * 发两张底牌，用 handEvaluator.evaluate() 比较 score。
 *
 * expert 可以传入 ranges（范围权重）做拒绝采样，实现“对手加注多 → 偏向
 * 强范围；跟注多 → 偏向中等范围”的简化范围收窄。
 */
import type { Card } from '../game/types';
import type { PlayerView } from '../game/playerView';
import { cardId, createDeck, mulberry32, removeCards } from '../game/cards';
import { evaluate } from '../game/handEvaluator';

/** 对某个对手底牌的接受权重：返回 0..1，越大越可能被采到。 */
export type RangeWeight = (first: Card, second: Card) => number;

export interface EquityOptions {
  /** 按“未弃牌对手”的顺序对齐的范围权重；null / undefined 表示均匀随机。 */
  ranges?: ReadonlyArray<RangeWeight | null | undefined>;
  /** 每个对手的范围拒绝采样最大尝试次数，默认 8。 */
  maxRangeAttempts?: number;
  /** 每多少次迭代让出主线程，默认 2000；<=0 表示不让出。 */
  yieldEvery?: number;
}

export interface EquityResult {
  /** 胜率 0..1（平局按半胜计算）。 */
  equity: number;
  /** 独占胜利的次数。 */
  wins: number;
  /** 平局次数。 */
  ties: number;
  /** 实际完成的模拟次数。 */
  iterations: number;
}

interface OpponentSeat {
  id: number;
  status: string;
}

function clampWeight(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function sleepZero(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * 估算当前视图的胜率。
 * @param view AI 唯一允许的输入。
 * @param iterations 模拟次数（会被取整；<=0 时返回 0.5）。
 * @param rng 确定性随机数生成器；不传则使用 view.seed。
 * @param options 范围收窄 / 让步间隔。
 */
export async function estimateEquity(
  view: PlayerView,
  iterations: number,
  rng?: () => number,
  options: EquityOptions = {},
): Promise<EquityResult> {
  const rounds = Math.floor(iterations);
  const random = rng ?? mulberry32(view.seed);
  if (!Number.isFinite(rounds) || rounds <= 0) {
    return { equity: 0.5, wins: 0, ties: 0, iterations: 0 };
  }

  const opponents: OpponentSeat[] = view.players
    .filter(
      (player) =>
        player.id !== view.viewerId &&
        (player.status === 'active' || player.status === 'allin'),
    )
    .map((player) => ({ id: player.id, status: player.status }));

  if (opponents.length === 0) {
    // 没有对手时相当于已经赢下底池。
    return { equity: 1, wins: 0, ties: 0, iterations: 0 };
  }

  const hole = view.self.holeCards;
  if (hole.length !== 2) {
    return { equity: 0.5, wins: 0, ties: 0, iterations: 0 };
  }
  const board = view.board.slice(0, 5);
  const neededFill = 5 - board.length;
  const minCards = neededFill + opponents.length * 2;
  const pool = removeCards(createDeck(), [...hole, ...board]);
  if (pool.length < minCards) {
    return { equity: 0.5, wins: 0, ties: 0, iterations: 0 };
  }

  const ranges = options.ranges;
  const maxRangeAttempts = Math.max(1, Math.floor(options.maxRangeAttempts ?? 8));
  const yieldEvery = Math.floor(options.yieldEvery ?? 2000);
  const doYield = Number.isFinite(yieldEvery) && yieldEvery > 0;

  let poolLen = pool.length;
  const drawCard = (): Card => {
    const index = (random() * poolLen) | 0;
    const card = pool[index];
    pool[index] = pool[poolLen - 1];
    pool[poolLen - 1] = card;
    poolLen -= 1;
    return card;
  };

  const drawHole = (range: RangeWeight | null | undefined): [Card, Card] => {
    if (!range) return [drawCard(), drawCard()];
    for (let attempt = 0; attempt < maxRangeAttempts; attempt++) {
      const first = drawCard();
      const second = drawCard();
      if (random() < clampWeight(range(first, second))) return [first, second];
      // 拒绝：把两张牌放回采样池（LIFO 恢复，牌集合不变）。
      poolLen += 2;
    }
    return [drawCard(), drawCard()];
  };

  const heroCards: Card[] = new Array<Card>(7);
  const opponentCards: Card[] = new Array<Card>(7);
  const fill: Card[] = new Array<Card>(neededFill);

  let wins = 0;
  let ties = 0;

  for (let round = 0; round < rounds; round++) {
    poolLen = pool.length;
    for (let index = 0; index < neededFill; index++) fill[index] = drawCard();

    heroCards[0] = hole[0];
    heroCards[1] = hole[1];
    for (let index = 0; index < board.length; index++) heroCards[2 + index] = board[index];
    for (let index = 0; index < neededFill; index++) {
      heroCards[2 + board.length + index] = fill[index];
    }
    const heroScore = evaluate(heroCards).score;

    let lost = false;
    let tied = false;
    for (let index = 0; index < opponents.length; index++) {
      const [first, second] = drawHole(ranges?.[index]);
      opponentCards[0] = first;
      opponentCards[1] = second;
      for (let cardIndex = 0; cardIndex < board.length; cardIndex++) {
        opponentCards[2 + cardIndex] = board[cardIndex];
      }
      for (let cardIndex = 0; cardIndex < neededFill; cardIndex++) {
        opponentCards[2 + board.length + cardIndex] = fill[cardIndex];
      }
      const opponentScore = evaluate(opponentCards).score;
      if (opponentScore > heroScore) {
        lost = true;
        break;
      }
      if (opponentScore === heroScore) tied = true;
    }

    if (lost) {
      // 输掉的一轮不计入 wins / ties
    } else if (tied) {
      ties += 1;
    } else {
      wins += 1;
    }

    if (doYield && (round + 1) % yieldEvery === 0 && round + 1 < rounds) {
      await sleepZero();
    }
  }

  return {
    equity: (wins + ties / 2) / rounds,
    wins,
    ties,
    iterations: rounds,
  };
}

/**
 * 用固定种子估算胜率（测试 / 调试辅助）。
 * 与 estimateEquity(view, n) 等价，但显式使用 view.seed 派生 PRNG。
 */
export async function estimateEquitySeeded(
  view: PlayerView,
  iterations: number,
  options: EquityOptions = {},
): Promise<EquityResult> {
  return estimateEquity(view, iterations, mulberry32(view.seed), options);
}

/** 已知牌数量（自己底牌 + 公共牌）。 */
export function knownCardCount(view: PlayerView): number {
  return view.self.holeCards.length + view.board.length;
}

/** 未知牌数量（测试辅助）。 */
export function unknownCardCount(view: PlayerView): number {
  return 52 - knownCardCount(view);
}

/** 两张手牌是否与已知牌冲突（测试辅助）。 */
export function conflictsWithKnown(view: PlayerView, first: Card, second: Card): boolean {
  const known = new Set([...view.self.holeCards, ...view.board].map(cardId));
  return known.has(cardId(first)) || known.has(cardId(second));
}
