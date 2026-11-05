/**
 * 每手牌结束后，为参与本手的大模型机器人写入「对局记忆」。
 *
 * 记忆只包含该模型自己的底牌、最终公共牌、自己的动作与本手净收益，
 * 不包含对手底牌（摊牌结果只用于生成赢家摘要）。
 */
import type { HandHistory, HandHistoryPlayer } from '../game/types';
import {
  appendHandMemory,
  buildHandMemory,
  describeActionForMemory,
  type LlmHandOutcome,
} from '../ai/llmMemory';
import { STREET_LABELS } from './format';

function payoutOf(hand: HandHistory, playerId: number): number {
  let total = 0;
  for (const pot of hand.result.pots) {
    for (const payout of pot.payouts) {
      if (payout.playerId === playerId && payout.amount > 0) total += payout.amount;
    }
  }
  return total;
}

/** 是否与他人共享过至少一个底池（多人分池）。 */
function sharedPot(hand: HandHistory, playerId: number): boolean {
  return hand.result.pots.some(
    (pot) =>
      pot.payouts.some((payout) => payout.playerId === playerId && payout.amount > 0) &&
      new Set(pot.payouts.filter((payout) => payout.amount > 0).map((payout) => payout.playerId))
        .size > 1,
  );
}

function winnerText(hand: HandHistory): string {
  return hand.result.winners
    .map((winner) => `${winner.name} +${winner.amount}`)
    .join('、');
}

function foldStreetLabel(hand: HandHistory, playerId: number): string | null {
  const folded = hand.actions.find(
    (record) => record.actorId === playerId && record.action.type === 'fold',
  );
  return folded ? STREET_LABELS[folded.street] : null;
}

function noteFor(hand: HandHistory, player: HandHistoryPlayer, payout: number, split: boolean): string {
  const winners = winnerText(hand);
  if (payout > 0) {
    if (split) {
      return winners ? `本手分池：${winners}` : '本手平分底池';
    }
    return winners ? `本手赢家：${winners}` : '本手获胜';
  }
  if (player.status === 'folded') {
    const street = foldStreetLabel(hand, player.id);
    return street ? `${street}弃牌` : '本手弃牌';
  }
  return winners ? `本手未获胜；赢家：${winners}` : '本手未获胜';
}

function memoryForPlayer(
  hand: HandHistory,
  player: HandHistoryPlayer,
): { outcome: LlmHandOutcome; actions: string[]; net: number; note: string } | null {
  if (!player.llmSlot) return null;
  if (player.status === 'out') return null;

  const actions = hand.actions
    .filter((record) => record.actorId === player.id)
    .map((record) => describeActionForMemory(record.action, STREET_LABELS[record.street]));

  const payout = payoutOf(hand, player.id);
  const outcome: LlmHandOutcome =
    payout > 0 ? (sharedPot(hand, player.id) ? 'split' : 'win') : 'lose';
  const net = player.endingStack - player.startingStack;

  return {
    outcome,
    actions,
    net,
    note: noteFor(hand, player, payout, outcome === 'split'),
  };
}

/**
 * 为一手牌中的每个大模型玩家写入一条记忆。
 * @returns 实际写入的条数（0 表示本手没有大模型参与）。
 */
export function recordLlmHandMemories(hand: HandHistory): number {
  let written = 0;
  for (const player of hand.players) {
    if (player.kind !== 'llm' || !player.llmSlot) continue;
    const memory = memoryForPlayer(hand, player);
    if (!memory) continue;
    appendHandMemory(
      buildHandMemory({
        slot: player.llmSlot,
        handNo: hand.handNo,
        holeCards: player.holeCards,
        board: hand.board,
        actions: memory.actions,
        result: memory.outcome,
        net: memory.net,
        note: memory.note,
      }),
    );
    written += 1;
  }
  return written;
}
