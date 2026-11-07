import { describe, expect, it } from 'vitest';
import {
  act,
  createTable,
  exportHistory,
  getHumanLegalActions,
  isHumanTurn,
  resetChips,
  setTableDifficulty,
  startNextHand,
  toPublicStats,
} from '../game/stateMachine';
import { getLegalActions } from '../game/gameEngine';
import type { TableState } from '../game/types';

function playTableToEnd(table: TableState): TableState {
  let current = table;
  let guard = 0;
  while (current.phase === 'playing') {
    guard += 1;
    if (guard > 500) throw new Error('会话推进死循环');
    const hand = current.hand!;
    const actor = hand.actingIndex;
    if (actor === null) throw new Error('无行动玩家但牌局未结束');
    const legal = getLegalActions(hand, actor);
    current = act(current, actor, legal.canCheck ? { type: 'check' } : { type: 'call' });
  }
  return current;
}

function foldTableToEnd(table: TableState): TableState {
  let current = table;
  let guard = 0;
  while (current.phase === 'playing') {
    guard += 1;
    if (guard > 200) throw new Error('会话推进死循环');
    const actor = current.hand!.actingIndex!;
    current = act(current, actor, { type: 'fold' });
  }
  return current;
}

describe('会话：创建与开始', () => {
  it('默认 4 人桌，盲注 10/20，起始筹码 1000', () => {
    const table = createTable();
    expect(table.players).toHaveLength(4);
    expect(table.players[0].name).toBe('你');
    expect(table.players[0].isHuman).toBe(true);
    expect(table.players.every((player) => player.stack === 1000)).toBe(true);
    expect(table.config.smallBlind).toBe(10);
    expect(table.config.bigBlind).toBe(20);
    expect(table.phase).toBe('idle');
  });

  it('第一手按钮位为 0 号玩家', () => {
    const table = startNextHand(createTable());
    expect(table.phase).toBe('playing');
    expect(table.handNo).toBe(1);
    expect(table.buttonIndex).toBe(0);
    expect(table.hand).not.toBeNull();
    expect(table.hand!.players[1].committedThisStreet).toBe(10);
    expect(table.hand!.players[2].committedThisStreet).toBe(20);
  });

  it('非法配置被拒绝', () => {
    expect(() => createTable({ playerCount: 1 })).toThrow(/人数/);
    expect(() => createTable({ playerCount: 7 })).toThrow(/人数/);
    expect(() => createTable({ smallBlind: 20, bigBlind: 10 })).toThrow(/小盲必须小于大盲/);
    expect(() => createTable({ startingStack: 10, bigBlind: 20 })).toThrow(/起始筹码/);
    expect(() => createTable({ seed: '' })).toThrow(/种子/);
  });

  it('2-6 人桌均可创建并开始', () => {
    for (let count = 2; count <= 6; count++) {
      const table = startNextHand(createTable({ playerCount: count }));
      expect(table.phase).toBe('playing');
      expect(table.players).toHaveLength(count);
      expect(table.hand).not.toBeNull();
      // 2 人桌是单挑：按钮即小盲
      if (count === 2) {
        expect(table.hand!.players[table.buttonIndex].committedThisStreet).toBe(10);
      }
    }
  });
});

describe('会话：多手牌与按钮轮转', () => {
  it('完整玩一手后进入 handOver，筹码同步且历史记录完整', () => {
    let table = playTableToEnd(startNextHand(createTable()));
    expect(table.phase).toBe('handOver');
    expect(table.history).toHaveLength(1);
    expect(table.players.reduce((sum, player) => sum + player.stack, 0)).toBe(4000);
    expect(table.message.length).toBeGreaterThan(0);
    expect(table.history[0].board).toHaveLength(5);
    expect(table.history[0].log.length).toBeGreaterThan(0);
    expect(table.history[0].players).toHaveLength(4);
    expect(table.logs.length).toBeGreaterThan(0);
  });

  it('按钮每手顺时针轮转：0 → 1 → 2 → 3 → 0', () => {
    let table = startNextHand(createTable());
    const buttons: number[] = [];
    for (let hand = 0; hand < 5; hand++) {
      buttons.push(table.buttonIndex);
      table = foldTableToEnd(table);
      expect(table.phase).toBe('handOver');
      table = startNextHand(table);
    }
    expect(buttons).toEqual([0, 1, 2, 3, 0]);
    expect(table.history).toHaveLength(5);
  });

  it('按钮轮转跳过已淘汰玩家', () => {
    const base = createTable({ playerCount: 3 });
    base.players[1].stack = 0; // 玩家 1 已无筹码
    let table = startNextHand(base);
    expect(table.buttonIndex).toBe(0);
    expect(table.hand!.players[1].status).toBe('out');
    // 单挑：按钮兼小盲
    expect(table.hand!.players[0].committedThisStreet).toBe(10);
    table = foldTableToEnd(table);
    table = startNextHand(table);
    expect(table.buttonIndex).toBe(2); // 跳过玩家 1
    expect(table.hand!.players[1].status).toBe('out');
  });

  it('6 人桌可完整打一手', () => {
    let table = playTableToEnd(startNextHand(createTable({ playerCount: 6 })));
    expect(table.phase).toBe('handOver');
    expect(table.history).toHaveLength(1);
    expect(table.players.reduce((sum, player) => sum + player.stack, 0)).toBe(6000);
  });

  it('正在进行的牌局不能直接开始下一手', () => {
    const table = startNextHand(createTable());
    expect(() => startNextHand(table)).toThrow(/尚未结束/);
  });

  it('人类玩家：未轮到时无合法动作，轮到时正确返回', () => {
    let table = startNextHand(createTable());
    expect(isHumanTurn(table)).toBe(false);
    expect(getHumanLegalActions(table)).toBeNull();
    // 第一手按钮 0，UTG 为玩家 3，先行动
    expect(table.hand!.actingIndex).toBe(3);
    table = act(table, 3, { type: 'call' });
    expect(table.hand!.actingIndex).toBe(0);
    const legal = getHumanLegalActions(table);
    expect(legal).not.toBeNull();
    expect(legal!.canCall).toBe(true);
    expect(legal!.callAmount).toBe(20);
    expect(isHumanTurn(table)).toBe(true);
  });

  it('用错玩家下标行动会抛错', () => {
    const table = startNextHand(createTable());
    expect(() => act(table, 0, { type: 'call' })).toThrow(/行动/);
  });

  it('动作后日志增量写入会话日志', () => {
    let table = startNextHand(createTable());
    const before = table.logs.length;
    table = act(table, 3, { type: 'call' });
    expect(table.logs.length).toBeGreaterThan(before);
    expect(table.logs.map((entry) => entry.text).join('\n')).toContain('老陈 跟注 20');
  });
});

describe('会话：难度、重置、历史导出', () => {
  it('修改难度会同时更新所有机器人', () => {
    const table = createTable({ difficulty: 'normal' });
    const next = setTableDifficulty(table, 'expert');
    expect(next.config.difficulty).toBe('expert');
    for (const player of next.players) {
      if (!player.isHuman) expect(player.difficulty).toBe('expert');
    }
    expect(next.players[0].difficulty).toBe('normal'); // 人类不参与难度
  });

  it('牌局进行中修改难度：当前手牌内的机器人也立即使用新难度', () => {
    let table = startNextHand(createTable({ difficulty: 'beginner' }));
    expect(table.hand!.players[3].difficulty).toBe('beginner');
    table = setTableDifficulty(table, 'hard');
    expect(table.hand!.players[3].difficulty).toBe('hard');
    expect(table.players[3].difficulty).toBe('hard');
  });

  it('重置筹码：筹码恢复、手数归零、状态回到 idle', () => {
    let table = playTableToEnd(startNextHand(createTable()));
    const before = table.players.find((player) => player.stack !== 1000);
    expect(before === undefined || before.stack !== 1000).toBe(true);
    table = resetChips(table);
    expect(table.phase).toBe('idle');
    expect(table.handNo).toBe(0);
    expect(table.hand).toBeNull();
    expect(table.players.every((player) => player.stack === 1000)).toBe(true);
    const started = startNextHand(table);
    expect(started.phase).toBe('playing');
    expect(started.buttonIndex).toBe(0);
  });

  it('导出历史为可解析的 JSON', () => {
    let table = playTableToEnd(startNextHand(createTable()));
    table = startNextHand(table);
    table = playTableToEnd(table);
    const json = exportHistory(table);
    const data = JSON.parse(json) as { handCount: number; hands: unknown[]; config: { seed: string } };
    expect(data.handCount).toBe(2);
    expect(data.hands).toHaveLength(2);
    expect(typeof data.config.seed).toBe('string');
  });

  it('人类输光筹码后进入 gameOver', () => {
    const table = createTable();
    table.players[0].stack = 0;
    const next = startNextHand(table);
    expect(next.phase).toBe('gameOver');
    expect(next.message).toContain('输光');
  });

  it('只剩一人有筹码时进入 gameOver', () => {
    const table = createTable({ playerCount: 2 });
    table.players[1].stack = 0;
    const next = startNextHand(table);
    expect(next.phase).toBe('gameOver');
    expect(next.message).toContain('不足两人');
  });

  it('相同种子 + 相同动作序列 → 相同历史', () => {
    const run = (): TableState => {
      let table = startNextHand(createTable({ seed: 'session-repro' }));
      table = playTableToEnd(table);
      table = startNextHand(table);
      return playTableToEnd(table);
    };
    const a = run();
    const b = run();
    expect(a.history.map((hand) => hand.board.map((card) => card.rank + card.suit))).toEqual(
      b.history.map((hand) => hand.board.map((card) => card.rank + card.suit)),
    );
    expect(a.players.map((player) => player.stack)).toEqual(
      b.players.map((player) => player.stack),
    );
  });
});

describe('加注机会率（pfrOpportunityRate）：分母只算「真正行动过」的手', () => {
  it('每手轮到自己就加注的玩家：pfrRate < 1，但 pfrOpportunityRate = 1', () => {
    let table = createTable({ playerCount: 2, startingStack: 1000, smallBlind: 10, bigBlind: 20, seed: 'pfr-opp' });
    // 座位 0 永远弃牌 / 过牌，座位 1 一有机会就加注
    for (let h = 0; h < 12; h++) {
      table.players = table.players.map((p) => ({ ...p, stack: 1000 }));
      table.phase = 'handOver';
      table = startNextHand(table);
      let guard = 0;
      while (table.phase === 'playing' && guard++ < 200) {
        const hand = table.hand!;
        const actor = hand.actingIndex!;
        const legal = getLegalActions(hand, actor);
        const action =
          actor === 1
            ? legal.canRaise
              ? { type: 'raise' as const, amount: legal.minRaiseTo }
              : legal.canCall
                ? { type: 'call' as const }
                : { type: 'check' as const }
            : legal.canCheck
              ? { type: 'check' as const }
              : { type: 'fold' as const };
        table = act(table, actor, action);
      }
    }
    const stats = table.players[1].statsRaw!;
    expect(stats.hands).toBe(12);
    // 他并非每手都轮到动作（座位 0 先弃牌时他直接收盲），所以 pfrRate 会低于 1
    expect(stats.pfr).toBeLessThan(stats.hands);
    // 但只要轮到他，他就加注 → 机会率必须是 100%
    expect(stats.pfrOpps).toBe(stats.pfr);
    const pub = toPublicStats(table.players[1].statsRaw)!;
    expect(pub.pfrOpportunityRate).toBeCloseTo(1, 5);
    expect(pub.pfrRate).toBeLessThan(1);
  });
});
