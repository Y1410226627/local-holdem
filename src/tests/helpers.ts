import type { Card, HandState, PlayerAction, Rank, Street, Suit } from '../game/types';
import { buildShuffledDeck, cardId, createDeck } from '../game/cards';
import { createHand, playAction } from '../game/gameEngine';
import { getLegalActions } from '../game/betting';

const RANK_MAP: Record<string, Rank> = {
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  '10': 10,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

const SUIT_MAP: Record<string, Suit> = { s: 's', h: 'h', d: 'd', c: 'c' };

/** 解析单张牌：'As'、'Td'、'10c'。 */
export function C(text: string): Card {
  const match = /^(10|[2-9TJQKA])([shdc])$/i.exec(text.trim());
  if (!match) throw new Error(`无法解析牌：${text}`);
  return { rank: RANK_MAP[match[1].toUpperCase()], suit: SUIT_MAP[match[2].toLowerCase()] };
}

/** 解析多张牌：'As Kd 5c'。 */
export function CC(text: string): Card[] {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(C);
}

export interface MakeHandOptions {
  stacks?: number[];
  buttonIndex?: number;
  smallBlind?: number;
  bigBlind?: number;
  /** 按玩家下标指定底牌；未指定的玩家保留原随机底牌。 */
  holeCards?: (readonly Card[] | undefined)[];
  /** 指定公共牌（5 张）及其前的烧牌。会重建剩余牌堆。 */
  board?: readonly Card[];
  burnCards?: readonly Card[];
  seed?: string;
  handNo?: number;
}

/**
 * 构造一手用于测试的牌局。
 * 默认 4 人桌、每人 1000、按钮位 0、盲注 10/20。
 */
export function makeHand(options: MakeHandOptions = {}): HandState {
  const stacks = options.stacks ?? [1000, 1000, 1000, 1000];
  const hand = createHand({
    handNo: options.handNo ?? 1,
    players: stacks.map((stack, index) => ({
      id: index,
      name: index === 0 ? '你' : `机器人${index}`,
      isHuman: index === 0,
      stack,
      difficulty: 'normal' as const,
    })),
    buttonIndex: options.buttonIndex ?? 0,
    smallBlind: options.smallBlind ?? 10,
    bigBlind: options.bigBlind ?? 20,
    seed: options.seed ?? 'test-seed',
  });

  if (options.holeCards) {
    hand.players.forEach((player, index) => {
      const cards = options.holeCards?.[index];
      if (cards) player.holeCards = cards.map((card) => ({ ...card }));
    });
  }
  if (options.board) {
    rigBoard(hand, options.board, options.burnCards ?? []);
  }
  return hand;
}

/** 在发公共牌之前指定 5 张公共牌与 3 张烧牌，并重建剩余牌堆。 */
export function rigBoard(
  hand: HandState,
  board: readonly Card[],
  burnCards: readonly Card[] = [],
): void {
  if (hand.board.length !== 0 || hand.street !== 'preflop') {
    throw new Error('只能在翻牌前设置公共牌');
  }
  if (board.length !== 5) throw new Error('board 需要恰好 5 张');
  const used = new Set<number>();
  const all = [...hand.players.flatMap((player) => player.holeCards), ...board, ...burnCards];
  for (const card of all) {
    const id = cardId(card);
    if (used.has(id)) throw new Error(`测试牌重复：${card.rank}${card.suit}`);
    used.add(id);
  }
  const filler = createDeck().filter((card) => !used.has(cardId(card)));
  const burns = [0, 1, 2].map((index) => burnCards[index] ?? filler.shift()!);
  hand.deck = [
    burns[0],
    board[0],
    board[1],
    board[2],
    burns[1],
    board[3],
    burns[2],
    board[4],
    ...filler,
  ];
}

/** 依次自动执行 check / call，推进到目标街道。 */
export function playToStreet(hand: HandState, target: Street): HandState {
  let current = hand;
  let guard = 0;
  while (current.phase === 'playing' && current.street !== target) {
    guard += 1;
    if (guard > 200) throw new Error('推进街道失败：疑似死循环');
    const index = current.actingIndex;
    if (index === null) throw new Error('无人行动但牌局尚未结束');
    const legal = getLegalActions(current, index);
    current = playAction(current, index, legal.canCheck ? { type: 'check' } : { type: 'call' });
  }
  return current;
}

/** 全场自动 check / call 直到摊牌结束。 */
export function playToShowdown(hand: HandState): HandState {
  let current = hand;
  let guard = 0;
  while (current.phase === 'playing') {
    guard += 1;
    if (guard > 500) throw new Error('推进到摊牌失败：疑似死循环');
    const index = current.actingIndex;
    if (index === null) throw new Error('无人行动但牌局尚未结束');
    const legal = getLegalActions(current, index);
    current = playAction(current, index, legal.canCheck ? { type: 'check' } : { type: 'call' });
  }
  return current;
}

/** 按顺序执行动作序列：[玩家下标, 动作]。 */
export function playSequence(hand: HandState, sequence: [number, PlayerAction][]): HandState {
  let current = hand;
  for (const [index, action] of sequence) {
    if (current.phase !== 'playing') throw new Error('牌局已结束，无法继续执行动作');
    if (current.actingIndex !== index) {
      throw new Error(`动作顺序错误：期望玩家 ${current.actingIndex} 行动，收到玩家 ${index}`);
    }
    current = playAction(current, index, action);
  }
  return current;
}

/** 筹码守恒断言辅助：所有玩家筹码 + 当前底池。 */
export function chipsTotal(hand: HandState): number {
  return hand.players.reduce((sum, player) => sum + player.stack, 0) + hand.pot;
}

/** 生成固定牌堆（测试发牌顺序 / 可复现性）。 */
export function fixedDeck(seed = 'fixed', handNo = 1): Card[] {
  return buildShuffledDeck(seed, handNo);
}

