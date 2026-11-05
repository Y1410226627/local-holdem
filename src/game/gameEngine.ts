/**
 * 牌局引擎：发牌、盲注、行动推进、街道推进、全下 run-out、摊牌、底池结算。
 *
 * 设计：
 * - 对外函数为纯函数（不修改入参），内部通过 structuredClone 得到可变副本。
 * - 行动顺序 / 合法性校验在 betting.ts，边池计算在 pot.ts。
 * - 完整中文日志写入 hand.log；摊牌前日志绝不包含对手底牌。
 */
import type {
  ActionType,
  PublicPlayerStats,
  Card,
  Difficulty,
  HandResult,
  HandState,
  PlayerAction,
  PlayerKind,
  PlayerState,
  PotAward,
  PotPayout,
  ShowdownEntry,
  Street,
} from './types';
import { buildShuffledDeck, cardsLabel } from './cards';
import { bestFive, describeHand } from './handEvaluator';
import { addLog } from './log';
import { IllegalActionError, applyPlayerAction, cloneHand, getLegalActions } from './betting';
import {
  awardPots,
  buildSidePots,
  calcUncalledRefund,
  type PotContribution,
  type PotContender,
  type UncalledRefund,
} from './pot';

export { IllegalActionError, getLegalActions } from './betting';

const STREET_ORDER: Street[] = ['preflop', 'flop', 'turn', 'river'];

export interface CreateHandPlayerInput {
  id: number;
  name: string;
  isHuman: boolean;
  stack: number;
  difficulty?: Difficulty;
  kind?: PlayerKind;
  llmSlot?: number;
  styleId?: number;
  stats?: PublicPlayerStats;
  mood?: number;
}

export interface CreateHandOptions {
  handNo: number;
  players: CreateHandPlayerInput[];
  buttonIndex: number;
  smallBlind: number;
  bigBlind: number;
  seed: string;
  /** 测试用：覆盖洗牌结果（按抽牌顺序，index 0 先被抽走）。 */
  deckOverride?: Card[];
}

function isInHand(player: PlayerState): boolean {
  return player.status === 'active' || player.status === 'allin';
}

function findNextSeat(
  players: readonly PlayerState[],
  fromIndex: number,
  predicate: (player: PlayerState) => boolean,
): number {
  const n = players.length;
  for (let offset = 1; offset <= n; offset++) {
    const index = (fromIndex + offset) % n;
    if (predicate(players[index])) return index;
  }
  return -1;
}

function findNextInHand(players: readonly PlayerState[], fromIndex: number): number {
  return findNextSeat(players, fromIndex, isInHand);
}

function findNextActive(players: readonly PlayerState[], fromIndex: number): number {
  return findNextSeat(players, fromIndex, (p) => p.status === 'active');
}

/** 从 fromIndex 顺时针寻找下一个需要行动的玩家（未行动或未跟平当前下注）。 */
function findNextToAct(hand: HandState, fromIndex: number): number | null {
  const n = hand.players.length;
  for (let offset = 1; offset <= n; offset++) {
    const index = (fromIndex + offset) % n;
    const player = hand.players[index];
    if (player.status !== 'active') continue;
    if (!player.hasActedThisStreet || player.committedThisStreet < hand.currentBet) {
      return index;
    }
  }
  return null;
}

function totalPot(hand: HandState): number {
  return hand.players.reduce((sum, player) => sum + player.totalCommitted, 0);
}

function buildContributions(hand: HandState): PotContribution[] {
  return hand.players
    .filter((player) => player.totalCommitted > 0)
    .map((player) => ({
      playerId: player.id,
      name: player.name,
      totalCommitted: player.totalCommitted,
      folded: player.status === 'folded',
    }));
}

function orderFromButtonLeft(hand: HandState): number[] {
  const n = hand.players.length;
  const order: number[] = [];
  for (let offset = 1; offset <= n; offset++) {
    order.push(hand.players[(hand.buttonIndex + offset) % n].id);
  }
  return order;
}

function findPlayer(hand: HandState, playerId: number): PlayerState {
  const player = hand.players.find((p) => p.id === playerId);
  if (!player) throw new Error(`找不到玩家：${playerId}`);
  return player;
}

/** 应用“未被跟注下注退回”。 */
function applyRefund(hand: HandState, refund: UncalledRefund): PotPayout {
  const player = findPlayer(hand, refund.playerId);
  player.stack += refund.amount;
  player.totalCommitted -= refund.amount;
  hand.pot = totalPot(hand);
  addLog(hand, 'refund', `退回未跟注的 ${refund.amount} 筹码给 ${player.name}`, player.id);
  return { playerId: player.id, name: player.name, amount: refund.amount };
}

function postBlind(hand: HandState, index: number, amount: number, label: string): void {
  const player = hand.players[index];
  const paid = Math.min(amount, player.stack);
  player.stack -= paid;
  player.committedThisStreet += paid;
  player.totalCommitted += paid;
  if (player.stack === 0) player.status = 'allin';
  addLog(
    hand,
    'blind',
    `${player.name} 支付${label} ${paid}${player.status === 'allin' ? '（全下）' : ''}`,
    player.id,
  );
}

function burnCard(hand: HandState): void {
  const card = hand.deck.shift();
  if (!card) throw new Error('牌堆不足，无法烧牌');
  hand.burned.push(card);
}

function dealCards(hand: HandState, count: number): Card[] {
  const cards: Card[] = [];
  for (let i = 0; i < count; i++) {
    const card = hand.deck.shift();
    if (!card) throw new Error('牌堆不足，无法发牌');
    cards.push(card);
  }
  return cards;
}

function logBoard(hand: HandState, streetLabel: string, newCards: readonly Card[]): void {
  addLog(hand, 'board', `${streetLabel}：${cardsLabel(newCards)}　公共牌 ${cardsLabel(hand.board)}`);
}

/** 发下一张街的公共牌（含烧牌），并更新 hand.street。 */
function dealNextStreet(hand: HandState): void {
  const currentIndex = STREET_ORDER.indexOf(hand.street);
  const nextStreet = STREET_ORDER[currentIndex + 1];
  if (!nextStreet) throw new Error('已经是河牌，无法继续发牌');
  hand.street = nextStreet;

  if (nextStreet === 'flop') {
    burnCard(hand);
    const flop = dealCards(hand, 3);
    hand.board.push(...flop);
    logBoard(hand, '翻牌', flop);
  } else if (nextStreet === 'turn') {
    burnCard(hand);
    const turn = dealCards(hand, 1);
    hand.board.push(...turn);
    logBoard(hand, '转牌', turn);
  } else {
    burnCard(hand);
    const river = dealCards(hand, 1);
    hand.board.push(...river);
    logBoard(hand, '河牌', river);
  }
}

/** 所有剩余玩家全下 / 无需再行动时，一次性发完公共牌。 */
function dealRemainingBoard(hand: HandState): void {
  while (hand.board.length < 5) {
    if (hand.board.length === 0) {
      // 翻牌前直接 run-out
      dealNextStreet(hand); // flop
    } else {
      dealNextStreet(hand);
    }
  }
}

function resetStreetBetting(hand: HandState): void {
  for (const player of hand.players) {
    player.committedThisStreet = 0;
    player.hasActedThisStreet = false;
    player.lastActionBet = 0;
    player.canRaise = player.status === 'active';
  }
  hand.currentBet = 0;
  hand.lastFullRaiseSize = hand.bigBlind;
  hand.lastAggressorIndex = null;
}

function findFirstActiveAfterButton(hand: HandState): number | null {
  const n = hand.players.length;
  for (let offset = 1; offset <= n; offset++) {
    const index = (hand.buttonIndex + offset) % n;
    if (hand.players[index].status === 'active') return index;
  }
  return null;
}

function finishFoldWin(hand: HandState): void {
  const alive = hand.players.filter(isInHand);
  if (alive.length !== 1) {
    throw new Error(`弃牌获胜结算异常：剩余未弃牌玩家数 ${alive.length}`);
  }
  const winner = alive[0];

  const refunds: PotPayout[] = [];
  const refund = calcUncalledRefund(buildContributions(hand));
  if (refund) refunds.push(applyRefund(hand, refund));

  const potAmount = totalPot(hand);
  if (potAmount > 0) winner.stack += potAmount;
  hand.pot = 0;

  const pots: PotAward[] = [];
  const winners: PotPayout[] = [];
  if (potAmount > 0) {
    const payout: PotPayout = { playerId: winner.id, name: winner.name, amount: potAmount };
    pots.push({
      index: 0,
      label: '主池',
      amount: potAmount,
      winnerIds: [winner.id],
      payouts: [payout],
      oddChips: 0,
    });
    winners.push(payout);
    addLog(
      hand,
      'showdown',
      `${winner.name} 赢得主池 ${potAmount}（其他玩家全部弃牌）`,
      winner.id,
    );
  }

  hand.result = {
    pots,
    refunds,
    winners,
    showdown: null,
    foldedWin: true,
  };
  hand.phase = 'complete';
  hand.actingIndex = null;
}

/** 摊牌：退回未跟注下注 → 构建边池 → 比较牌型 → 分配筹码。 */
function showdown(hand: HandState): void {
  if (hand.board.length !== 5) {
    throw new Error(`摊牌时公共牌应为 5 张，实际 ${hand.board.length} 张`);
  }
  if (hand.street !== 'river') hand.street = 'river';
  hand.actingIndex = null;

  const refunds: PotPayout[] = [];
  const refund = calcUncalledRefund(buildContributions(hand));
  if (refund) refunds.push(applyRefund(hand, refund));

  const contributions = buildContributions(hand);
  const sidePots = buildSidePots(contributions);

  const alive = hand.players.filter(isInHand);
  const evaluations = new Map<
    number,
    { score: number; category: number; categoryName: string; description: string; bestCards: Card[] }
  >();
  for (const player of alive) {
    const allCards = [...player.holeCards, ...hand.board];
    const { hand: evaluated, cards: bestCards } = bestFive(allCards);
    evaluations.set(player.id, {
      score: evaluated.score,
      category: evaluated.category,
      categoryName: evaluated.categoryName,
      description: describeHand(evaluated),
      bestCards,
    });
  }

  const contenders = new Map<number, PotContender>();
  for (const player of alive) {
    const evaluation = evaluations.get(player.id);
    if (!evaluation) throw new Error(`玩家 ${player.name} 缺少牌型求值`);
    contenders.set(player.id, {
      playerId: player.id,
      name: player.name,
      score: evaluation.score,
    });
  }

  const awards = awardPots(sidePots, contenders, orderFromButtonLeft(hand));

  // 日志：亮牌
  for (const player of alive) {
    const evaluation = evaluations.get(player.id)!;
    addLog(
      hand,
      'showdown',
      `${player.name} 亮牌 ${cardsLabel(player.holeCards)}，组成 ${evaluation.description}`,
      player.id,
    );
  }

  // 派发筹码
  const winAmounts = new Map<number, number>();
  for (const pot of awards) {
    for (const payout of pot.payouts) {
      const player = findPlayer(hand, payout.playerId);
      player.stack += payout.amount;
      winAmounts.set(payout.playerId, (winAmounts.get(payout.playerId) ?? 0) + payout.amount);
    }
    const detail = pot.payouts
      .map((payout) => `${payout.name} +${payout.amount}`)
      .join('、');
    const oddNote =
      pot.oddChips > 0
        ? `（奇数筹码 ${pot.oddChips} 给 ${findPlayer(hand, pot.oddChipTo!).name}）`
        : '';
    addLog(
      hand,
      'pot',
      `${pot.label} ${pot.amount}：${detail}${oddNote}`,
      pot.winnerIds.length === 1 ? pot.winnerIds[0] : undefined,
    );
  }

  const winners: PotPayout[] = [];
  for (const player of alive) {
    const amount = winAmounts.get(player.id) ?? 0;
    if (amount > 0) {
      winners.push({ playerId: player.id, name: player.name, amount });
    }
  }

  const showdownEntries: ShowdownEntry[] = alive.map((player) => {
    const evaluation = evaluations.get(player.id)!;
    return {
      playerId: player.id,
      name: player.name,
      holeCards: player.holeCards.slice(),
      bestFive: evaluation.bestCards,
      category: evaluation.category,
      categoryName: evaluation.categoryName,
      description: evaluation.description,
      isWinner: (winAmounts.get(player.id) ?? 0) > 0,
    };
  });

  const result: HandResult = {
    pots: awards,
    refunds,
    winners,
    showdown: showdownEntries,
    foldedWin: false,
  };
  hand.result = result;
  hand.phase = 'complete';
  hand.actingIndex = null;
  hand.pot = 0;
}

/**
 * 状态推进：处理“只剩一名玩家 / 无需继续下注 / 街道结束 / 摊牌”等场景。
 * 调用前应已根据上一位行动者计算好 hand.actingIndex。
 */
function settleState(hand: HandState): void {
  if (hand.phase === 'complete') return;

  const alive = hand.players.filter(isInHand);
  if (alive.length <= 1) {
    finishFoldWin(hand);
    return;
  }
  if (hand.actingIndex !== null) return;

  const activeCount = hand.players.filter((p) => p.status === 'active').length;
  if (activeCount <= 1) {
    dealRemainingBoard(hand);
    showdown(hand);
    return;
  }
  if (hand.street === 'river') {
    showdown(hand);
    return;
  }

  dealNextStreet(hand);
  resetStreetBetting(hand);
  const first = findFirstActiveAfterButton(hand);
  hand.actingIndex = first;
  if (first === null) {
    // 理论不可达（activeCount >= 2 时必有人可行动）；保险处理。
    dealRemainingBoard(hand);
    showdown(hand);
  }
}

/**
 * 创建一手牌：洗牌、发底牌、下盲注、设置首个行动者。
 * 若盲注即导致所有玩家全下，会直接发完公共牌并摊牌（返回 phase='complete' 的状态）。
 */
export function createHand(options: CreateHandOptions): HandState {
  const { handNo, players: playerInputs, smallBlind, bigBlind, seed, deckOverride } = options;
  if (playerInputs.length < 2) throw new Error('至少需要两名玩家');
  if (!Number.isInteger(smallBlind) || smallBlind <= 0) throw new Error('小盲必须为正整数');
  if (!Number.isInteger(bigBlind) || bigBlind <= 0) throw new Error('大盲必须为正整数');
  if (smallBlind > bigBlind) throw new Error('小盲不能大于大盲');
  if (playerInputs.filter((p) => p.stack > 0).length < 2) {
    throw new Error('至少需要两名有筹码的玩家才能开始一手牌');
  }

  const players: PlayerState[] = playerInputs.map((input) => ({
    id: input.id,
    name: input.name,
    isHuman: input.isHuman,
    difficulty: input.difficulty,
    kind: input.kind,
    llmSlot: input.llmSlot,
    styleId: input.styleId,
    stats: input.stats,
    mood: input.mood,
    stack: input.stack,
    holeCards: [],
    committedThisStreet: 0,
    totalCommitted: 0,
    status: input.stack > 0 ? 'active' : 'out',
    hasActedThisStreet: false,
    canRaise: false,
    lastActionBet: 0,
  }));

  // 有效按钮位（若传入按钮位玩家已淘汰，顺时针找下一个有筹码的玩家）。
  let buttonIndex = options.buttonIndex;
  if (!players[buttonIndex] || players[buttonIndex].status !== 'active') {
    const found = findNextSeat(players, buttonIndex, (p) => p.status === 'active');
    if (found < 0) throw new Error('找不到有效按钮位');
    buttonIndex = found;
  }

  const inHandCount = players.filter((p) => p.status === 'active').length;
  const isHeadsUp = inHandCount === 2; // 仅剩两名玩家：按钮即小盲

  const smallBlindIndex = isHeadsUp ? buttonIndex : findNextInHand(players, buttonIndex);
  const bigBlindIndex = findNextInHand(players, smallBlindIndex);
  if (smallBlindIndex < 0 || bigBlindIndex < 0 || smallBlindIndex === bigBlindIndex) {
    throw new Error('无法确定盲注位置');
  }

  const deck = deckOverride ? deckOverride.slice() : buildShuffledDeck(seed, handNo);
  const requiredCards = inHandCount * 2 + 8; // 底牌 + 3 张烧牌 + 5 张公共牌
  if (deck.length < requiredCards) {
    throw new Error(`牌堆不足：需要至少 ${requiredCards} 张，实际 ${deck.length} 张`);
  }

  const hand: HandState = {
    handNo,
    street: 'preflop',
    phase: 'playing',
    players,
    buttonIndex,
    smallBlind,
    bigBlind,
    board: [],
    deck,
    burned: [],
    pot: 0,
    currentBet: 0,
    lastFullRaiseSize: bigBlind,
    actingIndex: null,
    lastAggressorIndex: null,
    actionCount: 0,
    actions: [],
    log: [],
    result: null,
  };

  addLog(
    hand,
    'system',
    `第 ${handNo} 手开始 · 按钮：${players[buttonIndex].name} · 盲注 ${smallBlind}/${bigBlind}`,
  );

  // 发底牌：从按钮左边（小盲）开始顺时针，两轮各一张。
  for (let round = 0; round < 2; round++) {
    let index = smallBlindIndex;
    for (let i = 0; i < inHandCount; i++) {
      const card = hand.deck.shift();
      if (!card) throw new Error('牌堆不足，无法发底牌');
      hand.players[index].holeCards.push(card);
      index = findNextInHand(hand.players, index);
    }
  }
  addLog(hand, 'deal', '为所有玩家各发两张底牌（底牌保密）');

  // 下盲注
  postBlind(hand, smallBlindIndex, smallBlind, '小盲');
  postBlind(hand, bigBlindIndex, bigBlind, '大盲');
  hand.currentBet = Math.max(...hand.players.map((p) => p.committedThisStreet));
  hand.lastFullRaiseSize = bigBlind;
  hand.pot = totalPot(hand);
  for (const player of hand.players) {
    player.canRaise = player.status === 'active';
  }

  // 翻牌前首个行动者：大盲左边第一位可行动的玩家；单挑时按钮/小盲先行动。
  hand.actingIndex = findNextToAct(hand, bigBlindIndex);
  settleState(hand);
  return hand;
}

/**
 * 执行一个动作并推进牌局（纯函数）。
 * @throws IllegalActionError 当动作非法、未轮到此玩家或牌局已结束时。
 */
export function playAction(
  hand: HandState,
  playerIndex: number,
  action: PlayerAction,
): HandState {
  if (hand.phase !== 'playing') {
    throw new IllegalActionError('本手牌已经结束');
  }
  const next = applyPlayerAction(hand, playerIndex, action);
  next.actingIndex = findNextToAct(next, playerIndex);
  settleState(next);
  return next;
}

/** 当前行动玩家索引（无人行动时返回 null）。 */
export function getActingIndex(hand: HandState): number | null {
  return hand.actingIndex;
}

/** 是否可以继续行动。 */
export function canAct(hand: HandState): boolean {
  return hand.phase === 'playing' && hand.actingIndex !== null;
}

/** 复制一份手牌状态（供测试 / 会话层使用）。 */
export function cloneHandState(hand: HandState): HandState {
  return cloneHand(hand);
}

export type { ActionType, PotContribution };
