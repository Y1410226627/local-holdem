/**
 * 模糊测试：随机生成合法动作，模拟大量牌局。
 *
 * 验证目标：
 * - 任意合法动作都不会让引擎崩溃；
 * - getLegalActions 暴露的每一种动作都能被引擎接受；
 * - 筹码守恒、底池一致、玩家筹码非负；
 * - 每手牌最终都能结束并进入 handOver / gameOver。
 */
import { describe, expect, it } from 'vitest';
import { getLegalActions, playAction } from '../game/gameEngine';
import { act, createTable, startNextHand } from '../game/stateMachine';
import { hashString, mulberry32 } from '../game/cards';
import type { PlayerAction, TableState } from '../game/types';

function randomInt(rng: () => number, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

function pickRandomAction(hand: NonNullable<TableState['hand']>, rng: () => number): PlayerAction {
  const index = hand.actingIndex!;
  const legal = getLegalActions(hand, index);
  const candidates: PlayerAction[] = [{ type: 'fold' }];
  if (legal.canCheck) candidates.push({ type: 'check' });
  if (legal.canCall) candidates.push({ type: 'call' });
  if (legal.canBet || legal.canRaise) {
    const type = legal.aggressiveType!;
    const amounts = new Set<number>([legal.minRaiseTo, legal.maxRaiseTo]);
    if (legal.maxRaiseTo > legal.minRaiseTo) {
      amounts.add(legal.minRaiseTo + randomInt(rng, legal.maxRaiseTo - legal.minRaiseTo + 1));
    }
    for (const amount of amounts) candidates.push({ type, amount });
  }
  if (legal.canAllIn) candidates.push({ type: 'allin' });
  return candidates[randomInt(rng, candidates.length)];
}

function assertHandInvariants(table: TableState, initialChips: number): void {
  const hand = table.hand;
  if (!hand) return;
  expect(hand.pot).toBe(
    hand.players.reduce((sum, player) => sum + player.totalCommitted, 0),
  );
  const stacks = hand.players.reduce((sum, player) => sum + player.stack, 0);
  expect(stacks + hand.pot).toBe(initialChips);
  for (const player of hand.players) {
    expect(player.stack).toBeGreaterThanOrEqual(0);
    expect(player.committedThisStreet).toBeGreaterThanOrEqual(0);
    expect(player.totalCommitted).toBeGreaterThanOrEqual(0);
  }
  const maxCommitted = Math.max(...hand.players.map((player) => player.committedThisStreet));
  expect(hand.currentBet).toBe(maxCommitted);
  const anyCommittedMismatch = hand.players.some(
    (player) => player.status === 'active' && player.committedThisStreet > hand.currentBet,
  );
  expect(anyCommittedMismatch).toBe(false);
}

describe('模糊测试：随机合法动作', () => {
  it('随机动作模拟 40 桌 × 多手牌，不崩溃且守恒', () => {
    for (let trial = 0; trial < 40; trial++) {
      const rng = mulberry32(hashString(`fuzz-${trial}`));
      const playerCount = 2 + (trial % 5);
      const startingStack = 1000;
      const initialChips = playerCount * startingStack;
      let table = startNextHand(
        createTable({
          playerCount,
          startingStack,
          seed: `fuzz-seed-${trial}`,
          difficulty: 'normal',
        }),
      );
      expect(table.phase).toBe('playing');
      let handsPlayed = 0;

      while (handsPlayed < 4 && table.phase !== 'gameOver') {
        let guard = 0;
        while (table.phase === 'playing') {
          guard += 1;
          expect(guard).toBeLessThan(500);
          assertHandInvariants(table, initialChips);
          const hand = table.hand!;
          const actor = hand.actingIndex;
          expect(actor).not.toBeNull();
          const action = pickRandomAction(hand, rng);
          table = act(table, actor!, action);
        }
        expect(['handOver', 'gameOver']).toContain(table.phase);
        if (table.hand) {
          expect(table.hand.phase).toBe('complete');
          expect(table.hand.result).not.toBeNull();
        }
        const totalStacks = table.players.reduce((sum, player) => sum + player.stack, 0);
        expect(totalStacks).toBe(initialChips);
        handsPlayed += 1;
        if (table.phase === 'handOver') {
          table = startNextHand(table);
        }
      }
      expect(table.history.length).toBe(handsPlayed);
    }
  });

  it('getLegalActions 暴露的每种动作都能被引擎接受', () => {
    for (let trial = 0; trial < 120; trial++) {
      const rng = mulberry32(hashString(`legal-${trial}`));
      let table = startNextHand(
        createTable({
          playerCount: 2 + (trial % 5),
          seed: `legal-seed-${trial}`,
          difficulty: 'normal',
        }),
      );
      // 随机走几步，制造各种下注/全下局面
      const steps = randomInt(rng, 12);
      for (let step = 0; step < steps && table.phase === 'playing'; step++) {
        const hand = table.hand!;
        const actor = hand.actingIndex!;
        table = act(table, actor, pickRandomAction(hand, rng));
      }
      if (table.phase !== 'playing' || !table.hand) continue;
      const hand = table.hand;
      const actor = hand.actingIndex!;
      const legal = getLegalActions(hand, actor);

      const candidates: PlayerAction[] = [{ type: 'fold' }];
      if (legal.canCheck) candidates.push({ type: 'check' });
      if (legal.canCall) candidates.push({ type: 'call' });
      if (legal.canBet) {
        candidates.push({ type: 'bet', amount: legal.minRaiseTo });
        candidates.push({ type: 'bet', amount: legal.maxRaiseTo });
      }
      if (legal.canRaise) {
        candidates.push({ type: 'raise', amount: legal.minRaiseTo });
        candidates.push({ type: 'raise', amount: legal.maxRaiseTo });
      }
      if (legal.canAllIn) candidates.push({ type: 'allin' });

      for (const action of candidates) {
        expect(
          () => playAction(hand, actor, action),
          `动作 ${JSON.stringify(action)} 被拒绝（trial ${trial}）`,
        ).not.toThrow();
      }
    }
  });
});
