/**
 * 挑战模式（宗师 AI）测试：
 * - 宗师原型分配（确定性 / 多样性）；
 * - 计时读人 / 下注细节读人 / 范围极化；
 * - 计时伪装（fast / slow）与 EV 尺度选择；
 * - 挑战决策在四街都合法、可复现、读取统计与计时、且不参与训练；
 * - 引擎计时写入（动作 thinkMs → 跨手统计 → 下一手视图）。
 */
import { describe, expect, it } from 'vitest';
import type { ActionRecord, PlayerAction, PublicPlayerStats, TableState } from '../game/types';
import { buildPlayerView, type PlayerView } from '../game/playerView';
import { act, createTable, startNextHand } from '../game/stateMachine';
import { getLegalActions, playAction } from '../game/gameEngine';
import { decide } from '../ai/aiPlayer';
import {
  CHALLENGE_ARCHETYPE_COUNT,
  CHALLENGE_ARCHETYPES,
  applyChallengeVariant,
  assignChallengeArchetypes,
  buildChallengeRanges,
  challengeArchetypeLabel,
  challengeFoldEquity,
  chooseChallengeSize,
  chooseTimingHint,
  rangesForView,
  readBettingTells,
  readTimingTells,
} from '../ai/challenge';
import { BASE_DIFFICULTY_PROFILES, CHALLENGE_PROFILE } from '../ai/difficulty';
import { preflopStrengthOf } from '../ai/rangeModel';
import { C, CC, makeHand, playToStreet } from './helpers';
import type { LegalActions } from '../game/types';

function fakeStats(overrides: Partial<PublicPlayerStats> = {}): PublicPlayerStats {
  return {
    hands: 10,
    vpipRate: 0.4,
    pfrRate: 0.15,
    aggression: 1,
    foldToBetRate: 0.45,
    netChips: 0,
    ...overrides,
  };
}

function fakeView(overrides: Record<string, unknown>): PlayerView {
  const base = {
    viewerId: 0,
    handNo: 1,
    street: 'river',
    board: [],
    pot: 100,
    currentBet: 0,
    lastFullRaiseSize: 20,
    smallBlind: 10,
    bigBlind: 20,
    buttonIndex: 0,
    players: [],
    self: { id: 0, name: '你', isHuman: true, holeCards: [], canRaise: true },
    legal: null,
    actions: [],
    log: [],
    actingIndex: null,
    seed: 123,
  };
  return { ...base, ...overrides } as unknown as PlayerView;
}

function fakeRecord(overrides: Partial<ActionRecord>): ActionRecord {
  return {
    handNo: 1,
    street: 'river',
    actorId: 1,
    actorName: 'bot',
    action: { type: 'bet', amount: 100 },
    paid: 100,
    toAmount: 100,
    potAfter: 200,
    stackAfter: 900,
    board: [],
    ...overrides,
  };
}

describe('宗师原型分配', () => {
  it('同 seed 完全可复现，不同 seed 组合变化', () => {
    const ids = [1, 2, 3, 4, 5];
    const a = assignChallengeArchetypes('seed-a', ids);
    const b = assignChallengeArchetypes('seed-a', ids);
    const c = assignChallengeArchetypes('seed-b', ids);
    expect([...a.entries()]).toEqual([...b.entries()]);
    expect([...a.values()].join(',')).not.toBe([...c.values()].join(','));
  });

  it('每个 id 都在合法范围，且 5 个座位拿到 5 种不同原型', () => {
    const ids = [1, 2, 3, 4, 5];
    const assigned = assignChallengeArchetypes('seed-variety', ids);
    const values = [...assigned.values()];
    expect(values).toHaveLength(5);
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(CHALLENGE_ARCHETYPE_COUNT);
    }
    expect(new Set(values).size).toBe(5);
    for (const value of values) {
      expect(challengeArchetypeLabel(value).length).toBeGreaterThan(0);
    }
  });

  it('宗师原型定义完整且风格互不相同', () => {
    expect(CHALLENGE_ARCHETYPES).toHaveLength(CHALLENGE_ARCHETYPE_COUNT);
    const labels = new Set(CHALLENGE_ARCHETYPES.map((item) => item.label));
    expect(labels.size).toBe(CHALLENGE_ARCHETYPE_COUNT);
  });
});

describe('applyChallengeVariant：原型偏移有界', () => {
  it('压力型更爱诈唬 / 尺度更大，陷阱型更爱慢玩', () => {
    const pressure = applyChallengeVariant(CHALLENGE_PROFILE, 1); // 压力宗师
    const trap = applyChallengeVariant(CHALLENGE_PROFILE, 2); // 陷阱宗师
    const solver = applyChallengeVariant(CHALLENGE_PROFILE, 0); // 均衡宗师
    expect(pressure.postflop.bluffRate).toBeGreaterThan(solver.postflop.bluffRate);
    expect(trap.preflop.trapRate).toBeGreaterThan(solver.preflop.trapRate);
    expect(trap.postflop.bluffRate).toBeLessThan(pressure.postflop.bluffRate);
  });

  it('偏移不越界且不修改原 profile', () => {
    const before = JSON.stringify(CHALLENGE_PROFILE);
    for (let id = 0; id < CHALLENGE_ARCHETYPE_COUNT; id++) {
      const variant = applyChallengeVariant(CHALLENGE_PROFILE, id);
      expect(variant.postflop.bluffRate).toBeGreaterThan(0);
      expect(variant.postflop.bluffRate).toBeLessThanOrEqual(0.5);
      expect(variant.preflop.trapRate).toBeLessThanOrEqual(0.4);
      expect(variant.postflop.valueThreshold).toBeGreaterThanOrEqual(0.45);
    }
    expect(JSON.stringify(CHALLENGE_PROFILE)).toBe(before);
  });
});

describe('计时读人 readTimingTells', () => {
  it('相对基线长考 → slow；秒打 → fast；无样本用弱先验', () => {
    const slowView = fakeView({
      players: [
        {
          id: 1,
          name: '长考者',
          status: 'active',
          stats: fakeStats({ avgThinkMs: 2000, aggressiveAvgThinkMs: 2000 }),
        },
      ],
      actions: [fakeRecord({ actorId: 1, thinkMs: 5000 })],
    });
    const slow = readTimingTells(slowView);
    expect(slow[0].tell).toBe('slow');
    expect(slow[0].context).toBe('aggressive');

    const fastView = fakeView({
      players: [
        {
          id: 1,
          name: '秒打者',
          status: 'active',
          stats: fakeStats({ avgThinkMs: 2000, aggressiveAvgThinkMs: 2000 }),
        },
      ],
      actions: [fakeRecord({ actorId: 1, thinkMs: 400 })],
    });
    expect(readTimingTells(fastView)[0].tell).toBe('fast');
  });

  it('没有跨手基线时使用弱先验，且忽略无 thinkMs 的动作', () => {
    const view = fakeView({
      players: [{ id: 1, name: '新人', status: 'active' }],
      actions: [
        fakeRecord({ actorId: 1, thinkMs: undefined }),
        fakeRecord({ actorId: 1, thinkMs: 6000 }),
      ],
    });
    const tells = readTimingTells(view);
    expect(tells).toHaveLength(1);
    expect(tells[0].confidence).toBeLessThan(0.7);
    expect(tells[0].baselineMs).toBeNull();
    expect(tells[0].tell).toBe('slow');
  });

  it('已弃牌 / 自己的动作不计入', () => {
    const view = fakeView({
      players: [
        { id: 0, name: '你', status: 'active' },
        { id: 1, name: '已弃牌', status: 'folded' },
      ],
      actions: [
        fakeRecord({ actorId: 0, thinkMs: 9000 }),
        fakeRecord({ actorId: 1, thinkMs: 9000 }),
      ],
    });
    expect(readTimingTells(view)).toHaveLength(0);
  });
});

describe('下注细节读人 readBettingTells', () => {
  it('识别小注 / 大注 / check-raise', () => {
    const view = fakeView({
      players: [{ id: 1, name: '对手', status: 'active' }],
      actions: [
        fakeRecord({ actorId: 1, street: 'flop', action: { type: 'check' }, paid: 0, potAfter: 100 }),
        fakeRecord({
          actorId: 1,
          street: 'flop',
          action: { type: 'bet', amount: 30 },
          paid: 30,
          potAfter: 130,
        }),
        fakeRecord({
          actorId: 1,
          street: 'turn',
          action: { type: 'raise', amount: 200 },
          paid: 200,
          potAfter: 400,
        }),
      ],
    });
    const tells = readBettingTells(view);
    expect(tells).toHaveLength(1);
    expect(tells[0].aggressiveActions).toBe(2);
    expect(tells[0].checkRaised).toBe(true);
    expect(tells[0].smallBetRate).toBeGreaterThan(0);
    expect(tells[0].note).toContain('check-raise');
  });
});

describe('范围建模 buildChallengeRanges', () => {
  it('长考后的加注 → 范围更极化（强牌权重更高、中间牌更低）', () => {
    const baseView = fakeView({
      players: [
        {
          id: 1,
          name: '慢打者',
          status: 'active',
          stats: fakeStats({ avgThinkMs: 2000, aggressiveAvgThinkMs: 2000 }),
        },
      ],
      actions: [fakeRecord({ actorId: 1, thinkMs: undefined })],
    });
    const slowView = fakeView({
      players: [
        {
          id: 1,
          name: '慢打者',
          status: 'active',
          stats: fakeStats({ avgThinkMs: 2000, aggressiveAvgThinkMs: 2000 }),
        },
      ],
      actions: [fakeRecord({ actorId: 1, thinkMs: 6000 })],
    });
    const baseline = buildChallengeRanges(baseView).get(1);
    const slow = buildChallengeRanges(slowView).get(1);
    expect(baseline && slow).toBeTruthy();
    const aces = preflopStrengthOf(C('As'), C('Ah')) > 0.9;
    expect(aces).toBe(true);
    const strongSlow = slow!(C('As'), C('Ah'));
    const strongBase = baseline!(C('As'), C('Ah'));
    expect(strongSlow).toBeGreaterThanOrEqual(strongBase - 1e-9);
    const ranges = rangesForView(slowView, buildChallengeRanges(slowView));
    expect(ranges).toHaveLength(1);
    expect(typeof ranges[0]).toBe('function');
    // 中间牌在长考后的加注范围里权重下降（更两极）；动态找一手强度中等的牌。
    const deck = ['2c', '3h', '4d', '5s', '6c', '7h', '8d', '9s', 'Tc', 'Jh', 'Qd', 'Ks', 'Ac'].map((text) => C(text));
    let midPair: [ReturnType<typeof C>, ReturnType<typeof C>] | null = null;
    for (const first of deck) {
      for (const second of deck) {
        if (first === second) continue;
        const strength = preflopStrengthOf(first, second);
        if (strength >= 0.4 && strength <= 0.6) {
          midPair = [first, second];
          break;
        }
      }
      if (midPair) break;
    }
    expect(midPair).not.toBeNull();
    const [midFirst, midSecond] = midPair!;
    expect(slow!(midFirst, midSecond)).toBeLessThan(baseline!(midFirst, midSecond));
  });
});

describe('计时伪装 chooseTimingHint', () => {
  it('预翻牌尽量快；反向随机型会出现 fast / normal / slow 三种', () => {
    const view = fakeView({ board: [] });
    const fast = chooseTimingHint({
      view,
      action: { type: 'call' },
      strength: 0.5,
      isBluff: false,
      archetypeId: 0,
      rng: () => 0.1,
    });
    expect(fast).toBe('fast');

    const flopView = fakeView({ board: [C('Ah'), C('Kd'), C('7c')] });
    const hints = new Set<string>();
    for (const roll of [0.1, 0.6, 0.95]) {
      hints.add(
        chooseTimingHint({
          view: flopView,
          action: { type: 'bet', amount: 100 },
          strength: 0.4,
          isBluff: true,
          archetypeId: 4,
          rng: () => roll,
        }),
      );
    }
    expect([...hints].sort()).toEqual(['fast', 'normal', 'slow']);
  });

  it('陷阱型（慢打）与快打型的计时模式不同', () => {
    const view = fakeView({ board: [C('Ah'), C('Kd'), C('7c')] });
    const strongHand = (archetypeId: number) =>
      chooseTimingHint({
        view,
        action: { type: 'bet', amount: 100 },
        strength: 0.9,
        isBluff: false,
        archetypeId,
        rng: () => 0.1,
      });
    expect(strongHand(2)).toBe('slow'); // 慢打型对强牌长考
    expect(strongHand(1)).toBe('fast'); // 快打型对强牌快打
  });
});

describe('EV 尺度与弃牌率', () => {
  const legal = {
    playerId: 1,
    currentBet: 0,
    callAmount: 0,
    canFold: true,
    canCheck: true,
    canCall: false,
    canBet: true,
    canRaise: false,
    canAllIn: false,
    minRaiseTo: 20,
    maxRaiseTo: 2000,
    aggressiveType: 'bet',
    raiseRights: true,
    isAllInCall: false,
  } as LegalActions;

  it('河牌强牌会考虑更大的极性尺度', () => {
    const normal = chooseChallengeSize({
      fractions: [0.5, 1],
      pot: 100,
      equity: 0.6,
      currentBet: 0,
      callAmount: 0,
      legal,
      foldToBetRate: 0.45,
      opponentCount: 1,
      street: 'turn',
      archetypeId: 0,
    });
    const river = chooseChallengeSize({
      fractions: [0.5, 1],
      pot: 100,
      equity: 0.85,
      currentBet: 0,
      callAmount: 0,
      legal,
      foldToBetRate: 0.45,
      opponentCount: 1,
      street: 'river',
      archetypeId: 0,
    });
    expect(river.fraction).toBeGreaterThanOrEqual(normal.fraction);
    expect(river.fraction).toBeGreaterThan(0);
  });

  it('对手弃牌率越高 fold-equity 越高', () => {
    const tight = fakeStats({ foldToBetRate: 0.7 });
    const station = fakeStats({ foldToBetRate: 0.2 });
    const summary = (stats: PublicPlayerStats) => ({
      count: 1,
      avgVpip: stats.vpipRate,
      avgPfr: stats.pfrRate,
      avgAggression: stats.aggression,
      avgFoldToBet: stats.foldToBetRate,
      confidence: 1,
    });
    expect(challengeFoldEquity(summary(tight), 1, 0.8)).toBeGreaterThan(
      challengeFoldEquity(summary(station), 1, 0.8),
    );
  });
});

describe('挑战决策（与引擎集成）', () => {
  function decideOnCurrentActor(
    hand: ReturnType<typeof makeHand>,
    archetypeId: number,
  ): { hand: ReturnType<typeof makeHand>; view: PlayerView } | null {
    const index = hand.actingIndex;
    if (index === null) return null;
    const actor = hand.players[index];
    if (actor.isHuman) return null;
    const view = buildPlayerView(hand, actor.id, 'challenge-test');
    view.self.challengeArchetypeId = archetypeId;
    return { hand, view };
  }

  it('挑战档位参数比专家更强（MC 次数 / 诈唬 / 尺度更多）', () => {
    expect(CHALLENGE_PROFILE.postflop.mcIterations).toBeGreaterThan(
      BASE_DIFFICULTY_PROFILES.expert.postflop.mcIterations,
    );
    expect(CHALLENGE_PROFILE.postflop.bluffRate).toBeGreaterThan(
      BASE_DIFFICULTY_PROFILES.expert.postflop.bluffRate,
    );
    expect(CHALLENGE_PROFILE.style).toContain('挑战');
  });

  it('四街都能输出合法动作，debug 带宗师原型与计时伪装', async () => {
    let hand = makeHand({
      seed: 'challenge-streets',
      holeCards: [CC('As Kd'), CC('Qh Jh'), CC('9s 9c'), CC('7c 2d')],
      board: CC('2h 5s 9d Tc 3c'),
    });
    const targets = ['preflop', 'flop', 'turn', 'river'] as const;
    for (const target of targets) {
      if (hand.street !== target) {
        hand = playToStreet(hand, target);
      }
      const setup = decideOnCurrentActor(hand, 1);
      if (!setup) continue;
      const decision = await decide(setup.view, 'normal', {
        challenge: true,
        maxIterations: 250,
      });
      const legal = setup.view.legal!;
      switch (decision.action.type) {
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
        default:
          expect(decision.action.amount).toBeGreaterThanOrEqual(legal.minRaiseTo);
          expect(decision.action.amount).toBeLessThanOrEqual(legal.maxRaiseTo);
          break;
      }
      expect(decision.debug.profile).toContain('宗师');
      expect(decision.debug.archetype).toBeTruthy();
      expect(['fast', 'normal', 'slow']).toContain(decision.timingHint);
      expect(decision.debug.reasoning).toContain('挑战（');
    }
  });

  it('同视图 + 同 seed 决策完全可复现', async () => {
    const hand = playToStreet(
      makeHand({
        seed: 'challenge-deterministic',
        holeCards: [CC('As Kd'), CC('Qh Jh'), CC('9s 9c'), CC('7c 2d')],
        board: CC('2h 5s 9d Tc 3c'),
      }),
      'flop',
    );
    const setup = decideOnCurrentActor(hand, 2);
    expect(setup).not.toBeNull();
    const first = await decide(setup!.view, 'normal', { challenge: true, maxIterations: 300 });
    const second = await decide(setup!.view, 'normal', { challenge: true, maxIterations: 300 });
    expect(second.action).toEqual(first.action);
    expect(second.debug.equity).toBe(first.debug.equity);
    expect(second.timingHint).toBe(first.timingHint);
  });

  it('训练 / 对照评估（profileOverride）不会进入挑战模式', async () => {
    const hand = playToStreet(
      makeHand({
        seed: 'challenge-training-off',
        holeCards: [CC('As Kd'), CC('Qh Jh'), CC('9s 9c'), CC('7c 2d')],
        board: CC('2h 5s 9d Tc 3c'),
      }),
      'flop',
    );
    const setup = decideOnCurrentActor(hand, 2);
    expect(setup).not.toBeNull();
    const decision = await decide(setup!.view, 'expert', {
      challenge: true,
      profileOverride: BASE_DIFFICULTY_PROFILES.expert,
      maxIterations: 120,
    });
    expect(decision.debug.profile).not.toContain('挑战');
    expect(decision.debug.archetype).toBeUndefined();
  });

  it('有对手长考数据时，决策理由会引用「读计时」', async () => {
    const table = startNextHand(
      createTable({ playerCount: 3, seed: 'challenge-read-timing', difficulty: 'normal' }),
    );
    const hand = table.hand!;
    // 人类跟注 → 机器人 1 长考跟注 → 机器人 2 长考过牌，进入翻牌。
    const first = playAction(hand, hand.actingIndex!, { type: 'call' }, { thinkMs: 2500 });
    const second = playAction(
      first,
      first.actingIndex!,
      { type: 'call' },
      { thinkMs: 6000 },
    );
    const flop = playAction(second, second.actingIndex!, { type: 'check' }, { thinkMs: 4000 });
    expect(flop.street).toBe('flop');
    expect(flop.actingIndex).not.toBeNull();
    const actor = flop.players[flop.actingIndex!];
    const view = buildPlayerView(flop, actor.id, table.config.seed);
    view.self.challengeArchetypeId = 3;
    for (const player of view.players) {
      if (player.id === view.viewerId || player.isHuman) continue;
      player.stats = fakeStats({ avgThinkMs: 2000, aggressiveAvgThinkMs: 2000 });
    }
    const decision = await decide(view, 'normal', { challenge: true, maxIterations: 200 });
    expect(decision.debug.reasoning).toContain('读计时');
    expect(decision.debug.reasoning).toContain('长考');
  });
});

describe('引擎计时写入与跨手统计', () => {
  it('动作 thinkMs 写入公开动作记录，并出现在下一手的统计里', () => {
    const table = startNextHand(
      createTable({
        playerCount: 2,
        seed: 'challenge-timing-plumbing',
        difficulty: 'normal',
        challengeMode: true,
      }),
    );
    expect(table.config.challengeMode).toBe(true);
    let current: TableState = table;
    let guard = 0;
    while (current.phase === 'playing') {
      guard += 1;
      expect(guard).toBeLessThan(100);
      const hand = current.hand!;
      const index = hand.actingIndex!;
      const legal = getLegalActions(hand, index);
      const action: PlayerAction = legal.canCheck
        ? { type: 'check' }
        : legal.canCall
          ? { type: 'call' }
          : { type: 'fold' };
      current = act(current, index, action, { thinkMs: 1000 + index * 100 });
    }
    expect(['handOver', 'gameOver']).toContain(current.phase);
    const hand = current.hand!;
    expect(hand.actions.length).toBeGreaterThan(0);
    for (const record of hand.actions) {
      expect(record.thinkMs).toBeGreaterThan(0);
      expect(record.thinkMs).toBeLessThanOrEqual(30000);
    }
    const human = current.players.find((player) => player.isHuman)!;
    expect(human.statsRaw!.thinkSamples).toBeGreaterThan(0);
    expect(human.statsRaw!.thinkMsTotal).toBeGreaterThan(0);

    if (current.phase === 'handOver') {
      const next = startNextHand(current);
      const nextHand = next.hand!;
      const view = buildPlayerView(nextHand, nextHand.players[0].id, next.config.seed);
      expect(view.self.stats?.avgThinkMs).toBeGreaterThan(0);
      expect(view.self.stats?.avgThinkMs).toBeLessThanOrEqual(30000);
    }
  });

  it('挑战模式会为每个机器人分配宗师原型，且同桌不同', () => {
    const table = createTable({
      playerCount: 6,
      seed: 'challenge-archetypes-table',
      difficulty: 'normal',
      challengeMode: true,
    });
    const ids = table.players
      .filter((player) => !player.isHuman)
      .map((player) => player.challengeArchetypeId);
    expect(ids).toHaveLength(5);
    for (const id of ids) {
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThan(CHALLENGE_ARCHETYPE_COUNT);
    }
    expect(new Set(ids).size).toBe(5);
  });

  it('关闭挑战模式后决策不进入宗师分支', async () => {
    const table = createTable({
      playerCount: 3,
      seed: 'challenge-off',
      difficulty: 'normal',
    });
    expect(table.config.challengeMode).toBeUndefined();
    const hand = startNextHand(table).hand!;
    const view = buildPlayerView(hand, hand.players[hand.actingIndex!].id, table.config.seed);
    const decision = await decide(view, 'normal', { maxIterations: 100 });
    expect(decision.debug.profile).not.toContain('挑战');
  });
});
