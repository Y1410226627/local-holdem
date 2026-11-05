import { describe, expect, it } from 'vitest';
import {
  act,
  createTable,
  resetChips,
  setTableDifficulty,
  startNextHand,
} from '../game/stateMachine';
import { buildPlayerView } from '../game/playerView';
import { getLegalActions } from '../game/gameEngine';
import { MAX_LLM_SEATS, type LlmSeatConfig, type TableConfig } from '../game/types';

function llmSeat(slot: number, overrides: Partial<LlmSeatConfig> = {}): LlmSeatConfig {
  return {
    slot,
    name: `测试大模型${slot}`,
    baseUrl: `http://127.0.0.1:${11434 + slot}/v1`,
    model: `test-model-${slot}`,
    temperature: 0.5,
    enabled: true,
    ...overrides,
  };
}

function configWithSeats(overrides: Partial<TableConfig> = {}): Partial<TableConfig> {
  return {
    playerCount: 4,
    llmSeats: [llmSeat(1), llmSeat(2)],
    ...overrides,
  };
}

describe('会话：本地大模型机器人入座', () => {
  it('4 人桌 + 2 个大模型：人类 + 大模型① + 大模型② + 本地 AI', () => {
    const table = createTable(configWithSeats());
    expect(table.players).toHaveLength(4);
    expect(table.players[0]).toMatchObject({ id: 0, name: '你', isHuman: true, kind: 'human' });
    expect(table.players[1]).toMatchObject({
      name: '测试大模型1',
      kind: 'llm',
      llmSlot: 1,
      isHuman: false,
    });
    expect(table.players[2]).toMatchObject({
      name: '测试大模型2',
      kind: 'llm',
      llmSlot: 2,
      isHuman: false,
    });
    expect(table.players[3].kind).toBe('local');
    expect(table.players.every((player) => player.stack === 1000)).toBe(true);
    expect(table.config.llmSeats).toHaveLength(2);
  });

  it('只启用一个大模型时，其余座位由本地 AI 补齐', () => {
    const table = createTable(
      configWithSeats({ llmSeats: [llmSeat(1), llmSeat(2, { enabled: false })] }),
    );
    expect(table.players.map((player) => player.kind)).toEqual(['human', 'llm', 'local', 'local']);
    expect(table.players[1].llmSlot).toBe(1);
  });

  it('2 人桌可以加入 1 个大模型（单挑）', () => {
    const table = createTable({ playerCount: 2, llmSeats: [llmSeat(1)] });
    expect(table.players.map((player) => player.kind)).toEqual(['human', 'llm']);
    const started = startNextHand(table);
    expect(started.phase).toBe('playing');
    expect(started.hand!.players.map((player) => player.kind)).toEqual(['human', 'llm']);
  });

  it('人数不足 / 槽位非法 / 配置缺失时拒绝开始', () => {
    expect(() => createTable({ playerCount: 2, llmSeats: [llmSeat(1), llmSeat(2)] })).toThrow(
      /放不下/,
    );
    expect(() => createTable(configWithSeats({ llmSeats: [llmSeat(1), llmSeat(1)] }))).toThrow(
      /座位号重复/,
    );
    expect(() =>
      createTable(configWithSeats({ llmSeats: [llmSeat(1, { baseUrl: '' })] })),
    ).toThrow(/Base URL/);
    expect(() =>
      createTable(configWithSeats({ llmSeats: [llmSeat(1, { model: '  ' })] })),
    ).toThrow(/模型名称/);
    const tooManySeats: Partial<TableConfig> = {
      playerCount: 6,
      llmSeats: Array.from({ length: MAX_LLM_SEATS + 1 }, (_item, index) =>
        llmSeat(index + 1, { enabled: false }),
      ),
    };
    expect(() => createTable(tooManySeats)).toThrow(/最多支持/);
    const badSlot: Partial<TableConfig> = {
      playerCount: 4,
      llmSeats: [llmSeat(9)],
    };
    expect(() => createTable(badSlot)).toThrow(/座位号必须/);
  });

  it('不限 2 个：6 人桌可同时入座 5 个大模型玩家', () => {
    const table = createTable({
      playerCount: 6,
      llmSeats: Array.from({ length: MAX_LLM_SEATS }, (_item, index) => llmSeat(index + 1)),
    });
    expect(table.players.map((player) => player.kind)).toEqual([
      'human',
      'llm',
      'llm',
      'llm',
      'llm',
      'llm',
    ]);
    expect(table.players.map((player) => player.llmSlot)).toEqual([
      undefined,
      1,
      2,
      3,
      4,
      5,
    ]);
    const started = startNextHand(table);
    expect(started.hand!.players.filter((player) => player.kind === 'llm')).toHaveLength(5);
  });

  it('人类与本地机器人的名字都可以自由编写', () => {
    const table = startNextHand(
      createTable({
        playerCount: 5,
        humanName: '赌神',
        localBotNames: ['阿甲', '阿乙', '阿丙'],
        llmSeats: [llmSeat(1, { name: '小模型·阿尔法' })],
      }),
    );
    expect(table.players.map((player) => player.name)).toEqual([
      '赌神',
      '小模型·阿尔法',
      '阿甲',
      '阿乙',
      '阿丙',
    ]);
    expect(table.hand!.players.map((player) => player.name)).toEqual([
      '赌神',
      '小模型·阿尔法',
      '阿甲',
      '阿乙',
      '阿丙',
    ]);
  });

  it('模型人物设定保存在桌配置中，供提示词使用', () => {
    const table = createTable({
      playerCount: 4,
      llmSeats: [llmSeat(1, { persona: '冷静紧凶的数学流' })],
    });
    expect(table.config.llmSeats[0].persona).toBe('冷静紧凶的数学流');
  });

  it('开始下一手时大模型座位信息（kind / llmSlot / 名称）保留到引擎', () => {
    const table = startNextHand(createTable(configWithSeats()));
    const hand = table.hand!;
    expect(hand.players.map((player) => player.kind)).toEqual(['human', 'llm', 'llm', 'local']);
    expect(hand.players[1].llmSlot).toBe(1);
    expect(hand.players[1].name).toBe('测试大模型1');
  });

  it('重置筹码保留大模型座位与配置', () => {
    let table = startNextHand(createTable(configWithSeats()));
    table = resetChips(table);
    expect(table.players.map((player) => player.kind)).toEqual(['human', 'llm', 'llm', 'local']);
    expect(table.players[1].llmSlot).toBe(1);
    expect(table.players[1].name).toBe('测试大模型1');
    expect(table.config.llmSeats).toHaveLength(2);
    expect(table.phase).toBe('idle');
  });

  it('修改难度同步到大模型机器人（提示词风格使用该难度）', () => {
    let table = startNextHand(createTable(configWithSeats({ difficulty: 'normal' })));
    table = setTableDifficulty(table, 'expert');
    expect(table.players[1].difficulty).toBe('expert');
    expect(table.hand!.players[1].difficulty).toBe('expert');
    expect(table.players[3].difficulty).toBe('expert');
  });

  it('PlayerView 暴露玩家种类，但不包含其他玩家底牌', () => {
    const table = startNextHand(createTable(configWithSeats()));
    const hand = table.hand!;
    const actorIndex = hand.actingIndex!;
    const view = buildPlayerView(hand, hand.players[actorIndex].id, table.config.seed);
    const llmView = view.players.find((player) => player.kind === 'llm');
    expect(llmView).toBeDefined();
    expect(llmView!.llmSlot).toBe(1);
    expect('holeCards' in llmView!).toBe(false);
    expect(view.self.holeCards.length).toBe(2);
  });

  it('手牌历史记录大模型玩家信息', () => {
    let table = startNextHand(createTable(configWithSeats()));
    let guard = 0;
    while (table.phase === 'playing') {
      guard += 1;
      if (guard > 300) throw new Error('会话推进死循环');
      const hand = table.hand!;
      const actor = hand.actingIndex!;
      const legal = getLegalActions(hand, actor);
      table = act(table, actor, legal.canCheck ? { type: 'check' } : { type: 'call' });
    }
    expect(table.history).toHaveLength(1);
    expect(table.history[0].players[1].kind).toBe('llm');
    expect(table.history[0].players[1].llmSlot).toBe(1);
  });

  it('默认配置不带大模型机器人', () => {
    const table = createTable();
    expect(table.players.every((player) => player.kind !== 'llm')).toBe(true);
    expect(table.config.llmSeats).toEqual([]);
  });
});
