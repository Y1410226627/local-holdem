/**
 * 集成测试：四档 AI + 引擎 + 会话状态机全链路。
 * AI 使用限制迭代次数以控制测试耗时；生产默认由难度配置决定。
 */
import { describe, expect, it } from 'vitest';
import { getLegalActions } from '../game/gameEngine';
import { buildPlayerView } from '../game/playerView';
import { act, createTable, startNextHand } from '../game/stateMachine';
import { decide, type AIDebugInfo } from '../ai/aiPlayer';
import type { PlayerView } from '../game/playerView';
import type { Difficulty, PlayerAction, TableState } from '../game/types';
import { DIFFICULTY_ORDER } from '../game/types';

interface DecisionRecord {
  viewerId: number;
  difficulty: Difficulty;
  action: PlayerAction;
  debug: AIDebugInfo;
}

async function playOneAiHand(
  table: TableState,
  maxIterations: number,
  onDecision?: (view: PlayerView, decision: DecisionRecord) => void,
): Promise<TableState> {
  let current = table;
  let guard = 0;
  while (current.phase === 'playing') {
    guard += 1;
    expect(guard).toBeLessThan(400);
    const hand = current.hand!;
    const actorIndex = hand.actingIndex;
    expect(actorIndex).not.toBeNull();
    const actor = hand.players[actorIndex!];
    let action: PlayerAction;
    if (actor.isHuman) {
      const legal = getLegalActions(hand, actorIndex!);
      action = legal.canCheck
        ? { type: 'check' }
        : legal.canCall
          ? { type: 'call' }
          : { type: 'fold' };
    } else {
      const view = buildPlayerView(hand, actor.id, current.config.seed);
      expect(view.legal).not.toBeNull();
      const decision = await decide(view, actor.difficulty ?? 'normal', { maxIterations });
      expect(decision.debug.reasoning.length).toBeGreaterThan(0);
      onDecision?.(view, {
        viewerId: view.viewerId,
        difficulty: actor.difficulty ?? 'normal',
        action: decision.action,
        debug: decision.debug,
      });
      action = decision.action;
    }
    current = act(current, actorIndex!, action);
  }
  return current;
}

function assertActionLegal(view: PlayerView, action: PlayerAction): void {
  const legal = view.legal!;
  expect(legal).not.toBeNull();
  switch (action.type) {
    case 'fold':
      expect(legal.canFold).toBe(true);
      break;
    case 'check':
      expect(legal.canCheck).toBe(true);
      break;
    case 'call':
      expect(legal.canCall).toBe(true);
      break;
    case 'allin':
      expect(legal.canAllIn).toBe(true);
      break;
    case 'bet':
      expect(legal.canBet).toBe(true);
      expect(action.amount).toBeGreaterThanOrEqual(legal.minRaiseTo);
      expect(action.amount).toBeLessThanOrEqual(legal.maxRaiseTo);
      break;
    case 'raise':
      expect(legal.canRaise).toBe(true);
      expect(action.amount).toBeGreaterThanOrEqual(legal.minRaiseTo);
      expect(action.amount).toBeLessThanOrEqual(legal.maxRaiseTo);
      break;
  }
}

describe('AI 与引擎全链路集成', () => {
  it('四档难度机器人都能合法推进并打完整手牌', async () => {
    for (const difficulty of DIFFICULTY_ORDER) {
      let table = startNextHand(
        createTable({ playerCount: 4, seed: `integration-${difficulty}`, difficulty }),
      );
      table = await playOneAiHand(table, 300);
      expect(['handOver', 'gameOver']).toContain(table.phase);
      expect(table.hand!.phase).toBe('complete');
      expect(table.hand!.result).not.toBeNull();
      expect(table.players.reduce((sum, player) => sum + player.stack, 0)).toBe(4000);
      if (table.phase === 'handOver') {
        const next = startNextHand(table);
        expect(next.phase).toBe('playing');
      }
    }
  });

  it('批量 AI 决策全部合法且动作金额正确', async () => {
    const decisions: DecisionRecord[] = [];
    let table = startNextHand(
      createTable({ playerCount: 3, seed: 'integration-legal', difficulty: 'hard' }),
    );
    for (let handNo = 0; handNo < 2; handNo++) {
      table = await playOneAiHand(table, 200, (view, decision) => {
        assertActionLegal(view, decision.action);
        decisions.push(decision);
      });
      if (table.phase !== 'handOver') break;
      table = startNextHand(table);
    }
    expect(table.history.length).toBeGreaterThanOrEqual(1);
    expect(decisions.length).toBeGreaterThan(2);
    for (const decision of decisions) {
      expect(decision.debug.difficulty).toBe('hard');
    }
  });
});
