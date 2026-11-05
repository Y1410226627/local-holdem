/**
 * 真人化决策层测试：
 * - 跨手公开统计（VPIP / PFR / 攻击性 / 面对下注弃牌率）与情绪；
 * - 难度分级的情绪影响、对手利用、真人式失误；
 * - fold-equity 近似 EV 下注尺度选择；
 * - 会话状态机中统计与情绪确实跨手累计，且 AI 决策始终合法。
 */
import { describe, expect, it } from 'vitest';
import {
  applyExploitation,
  applyMoodToProfile,
  chooseEvBetFraction,
  estimateFoldProbability,
  evOfBet,
  humanMistakeRate,
  moodLabel,
  summarizeOpponents,
  type OpponentSummary,
} from '../ai/humanModel';
import { DIFFICULTY_PROFILES } from '../ai/difficulty';
import { decide, maybeHumanMistake } from '../ai/aiPlayer';
import { buildLlmPrompt } from '../ai/llmBot';
import { BASE_DIFFICULTY_PROFILES } from '../ai/difficulty';
import { createEmptyStatsRaw, toPublicStats } from '../game/stateMachine';
import { getLegalActions } from '../game/gameEngine';
import { buildPlayerView } from '../game/playerView';
import { act, createTable, startNextHand } from '../game/stateMachine';
import type {
  Difficulty,
  LlmSeatConfig,
  PlayerAction,
  PublicPlayerStats,
  TableState,
} from '../game/types';
import { DIFFICULTY_ORDER } from '../game/types';
import type { PlayerView } from '../game/playerView';

function fakeView(players: { id: number; stats?: PublicPlayerStats }[]): PlayerView {
  return {
    viewerId: 0,
    players: players.map((player) => ({ ...player, name: `p${player.id}` })),
  } as unknown as PlayerView;
}

function statsOf(overrides: Partial<PublicPlayerStats> = {}): PublicPlayerStats {
  return {
    hands: 12,
    vpipRate: 0.4,
    pfrRate: 0.15,
    aggression: 1,
    foldToBetRate: 0.45,
    netChips: 0,
    ...overrides,
  };
}

const EMPTY_SUMMARY: OpponentSummary = {
  count: 0,
  avgVpip: null,
  avgPfr: null,
  avgAggression: null,
  avgFoldToBet: null,
  confidence: 0,
};

async function playHandSimple(table: TableState, maxIterations = 120): Promise<TableState> {
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
      const decision = await decide(view, actor.difficulty ?? 'normal', { maxIterations });
      action = decision.action;
    }
    current = act(current, actorIndex!, action);
  }
  return current;
}

describe('summarizeOpponents：跨手公开统计汇总', () => {
  it('没有统计样本时返回空汇总', () => {
    const summary = summarizeOpponents(fakeView([{ id: 0 }, { id: 1 }, { id: 2 }]));
    expect(summary).toEqual(EMPTY_SUMMARY);
  });

  it('只汇总其他玩家，且忽略无样本的玩家', () => {
    const summary = summarizeOpponents(
      fakeView([
        { id: 0, stats: statsOf({ vpipRate: 0.9 }) }, // 自己，不计入
        { id: 1, stats: statsOf({ hands: 10, vpipRate: 0.5, pfrRate: 0.2, foldToBetRate: 0.6 }) },
        { id: 2, stats: statsOf({ hands: 6, vpipRate: 0.3, pfrRate: 0.1, foldToBetRate: 0.3 }) },
        { id: 3 }, // 无样本
      ]),
    );
    expect(summary.count).toBe(2);
    expect(summary.avgVpip).toBeCloseTo(0.4, 5);
    expect(summary.avgPfr).toBeCloseTo(0.15, 5);
    expect(summary.avgFoldToBet).toBeCloseTo(0.45, 5);
    expect(summary.confidence).toBeCloseTo(1, 5); // 平均 8 手 → 置信度封顶 1
  });

  it('样本少时置信度低', () => {
    const summary = summarizeOpponents(
      fakeView([{ id: 1, stats: statsOf({ hands: 2, foldToBetRate: null }) }]),
    );
    expect(summary.confidence).toBeCloseTo(0.25, 5);
    expect(summary.avgFoldToBet).toBeNull();
  });
});

describe('applyMoodToProfile：情绪影响按难度递减', () => {
  it('正情绪略提高诈唬、负情绪提高失误率', () => {
    const base = DIFFICULTY_PROFILES.normal;
    const hot = applyMoodToProfile(base, 2, 'normal');
    const tilted = applyMoodToProfile(base, -2, 'normal');
    expect(hot.postflop.bluffRate).toBeGreaterThan(base.postflop.bluffRate);
    expect(tilted.postflop.bluffRate).toBeLessThan(base.postflop.bluffRate);
    expect(hot.postflop.errorRate).toBeGreaterThan(base.postflop.errorRate);
    expect(tilted.postflop.errorRate).toBeGreaterThan(base.postflop.errorRate);
  });

  it('情绪为 0 时不变，且入门受影响大于专家', () => {
    const zero = applyMoodToProfile(DIFFICULTY_PROFILES.hard, 0, 'hard');
    expect(zero.postflop.bluffRate).toBe(DIFFICULTY_PROFILES.hard.postflop.bluffRate);
    const beginnerDelta = Math.abs(
      applyMoodToProfile(DIFFICULTY_PROFILES.beginner, -2, 'beginner').postflop.errorRate -
        DIFFICULTY_PROFILES.beginner.postflop.errorRate,
    );
    const expertDelta = Math.abs(
      applyMoodToProfile(DIFFICULTY_PROFILES.expert, -2, 'expert').postflop.errorRate -
        DIFFICULTY_PROFILES.expert.postflop.errorRate,
    );
    expect(beginnerDelta).toBeGreaterThan(expertDelta);
  });
});

describe('applyExploitation：按难度强度利用对手统计', () => {
  it('入门不利用任何统计', () => {
    const summary: OpponentSummary = {
      ...EMPTY_SUMMARY,
      count: 2,
      avgVpip: 0.8,
      avgFoldToBet: 0.7,
      confidence: 1,
    };
    const exploited = applyExploitation(DIFFICULTY_PROFILES.beginner, summary, 'beginner');
    expect(exploited.postflop.bluffRate).toBe(DIFFICULTY_PROFILES.beginner.postflop.bluffRate);
  });

  it('对手弃牌率高 → 专家提高诈唬频率', () => {
    const looseFolder: OpponentSummary = {
      ...EMPTY_SUMMARY,
      count: 2,
      avgVpip: 0.35,
      avgPfr: 0.15,
      avgAggression: 1,
      avgFoldToBet: 0.75,
      confidence: 1,
    };
    const exploited = applyExploitation(DIFFICULTY_PROFILES.expert, looseFolder, 'expert');
    expect(exploited.postflop.bluffRate).toBeGreaterThan(
      DIFFICULTY_PROFILES.expert.postflop.bluffRate,
    );
  });

  it('对手跟注站（弃牌率低）→ 降低诈唬', () => {
    const station: OpponentSummary = {
      ...EMPTY_SUMMARY,
      count: 2,
      avgVpip: 0.8,
      avgPfr: 0.1,
      avgAggression: 0.6,
      avgFoldToBet: 0.2,
      confidence: 1,
    };
    const exploited = applyExploitation(DIFFICULTY_PROFILES.hard, station, 'hard');
    expect(exploited.postflop.bluffRate).toBeLessThan(
      DIFFICULTY_PROFILES.hard.postflop.bluffRate,
    );
  });
});

describe('humanMistakeRate：难度与情绪', () => {
  it('难度越高失误越少', () => {
    const rates = DIFFICULTY_ORDER.map((difficulty) => humanMistakeRate(difficulty, 0));
    for (let i = 1; i < rates.length; i++) {
      expect(rates[i]).toBeLessThan(rates[i - 1]);
    }
    expect(rates[0]).toBeGreaterThan(0.1);
    expect(rates[rates.length - 1]).toBeLessThan(0.03);
  });

  it('上头（负情绪）时失误率升高', () => {
    expect(humanMistakeRate('normal', -2)).toBeGreaterThan(humanMistakeRate('normal', 0));
  });

  it('情绪标签可读', () => {
    expect(moodLabel(0)).toBeNull();
    expect(moodLabel(1.5)).toContain('顺');
    expect(moodLabel(-1.5)).toContain('上头');
  });
});

describe('fold-equity 与下注尺度 EV', () => {
  it('下注越大弃牌率越高，对手越多弃牌率越低', () => {
    expect(estimateFoldProbability(1.2, null, 1)).toBeGreaterThan(
      estimateFoldProbability(0.4, null, 1),
    );
    expect(estimateFoldProbability(0.6, 0.7, 1)).toBeGreaterThan(
      estimateFoldProbability(0.6, 0.3, 1),
    );
    expect(estimateFoldProbability(0.6, null, 3)).toBeLessThan(
      estimateFoldProbability(0.6, null, 1),
    );
  });

  it('evOfBet：对手弃牌率越高 EV 越高', () => {
    const low = evOfBet(100, 0.6, 50, 0.1, 1);
    const high = evOfBet(100, 0.6, 50, 0.7, 1);
    expect(high).toBeGreaterThan(low);
  });

  it('chooseEvBetFraction 返回候选尺度内 EV 最大的一个', () => {
    const legal = {
      currentBet: 0,
      callAmount: 0,
    } as unknown as Parameters<typeof chooseEvBetFraction>[0]['legal'];
    const choice = chooseEvBetFraction({
      fractions: [0.33, 0.75, 1.5],
      pot: 100,
      equity: 0.65,
      currentBet: 0,
      legal,
      foldToBetRate: 0.65,
      opponentCount: 1,
    });
    expect(choice).not.toBeNull();
    expect([0.33, 0.75, 1.5]).toContain(choice!.fraction);
    for (const fraction of [0.33, 0.75, 1.5]) {
      const betChips = Math.max(1, 100 * fraction);
      const ev = evOfBet(
        100,
        0.65,
        betChips,
        estimateFoldProbability(fraction, 0.65, 1),
        1,
      );
      expect(choice!.ev).toBeGreaterThanOrEqual(ev - 1e-9);
    }
  });

  it('没有候选尺度时返回 null', () => {
    const legal = { currentBet: 0, callAmount: 0 } as unknown as Parameters<
      typeof chooseEvBetFraction
    >[0]['legal'];
    expect(
      chooseEvBetFraction({
        fractions: [],
        pot: 100,
        equity: 0.5,
        currentBet: 0,
        legal,
        foldToBetRate: null,
        opponentCount: 1,
      }),
    ).toBeNull();
  });
});

describe('会话统计与情绪跨手累计', () => {
  it('每手结束后累计统计，并在下一手的受限视图中可见', async () => {
    let table = startNextHand(
      createTable({ playerCount: 3, seed: 'human-model-stats', difficulty: 'beginner' }),
    );
    table = await playHandSimple(table);
    expect(['handOver', 'gameOver']).toContain(table.phase);
    for (const player of table.players) {
      expect(player.statsRaw?.hands).toBeGreaterThanOrEqual(1);
      expect(player.mood).toBeGreaterThanOrEqual(-2);
      expect(player.mood).toBeLessThanOrEqual(2);
    }

    if (table.phase === 'handOver') {
      const next = startNextHand(table);
      const bot = next.hand!.players.find((player) => !player.isHuman)!;
      const view = buildPlayerView(next.hand!, bot.id, next.config.seed);
      expect(view.self.stats?.hands).toBeGreaterThanOrEqual(1);
      expect(view.self.stats?.vpipRate).toBeGreaterThanOrEqual(0);
      // VPIP / PFR 按手计一次，不可能超过 100%。
      expect(view.self.stats?.vpipRate).toBeLessThanOrEqual(1);
      expect(view.self.stats?.pfrRate).toBeLessThanOrEqual(1);
      for (const publicPlayer of view.players) {
        if (!publicPlayer.stats) continue;
        expect(publicPlayer.stats.vpipRate).toBeLessThanOrEqual(1);
        expect(publicPlayer.stats.pfrRate).toBeLessThanOrEqual(1);
      }
      // 其他玩家（含人类）的统计同样是公开字段。
      const opponent = view.players.find((player) => player.id !== view.viewerId)!;
      expect(opponent.stats?.hands).toBeGreaterThanOrEqual(1);
    }
  });

  it('toPublicStats / createEmptyStatsRaw 的换算正确', () => {
    expect(toPublicStats(createEmptyStatsRaw())).toBeUndefined();
    const raw = createEmptyStatsRaw();
    raw.hands = 4;
    raw.vpip = 2;
    raw.pfr = 1;
    raw.bets = 2;
    raw.raises = 1;
    raw.calls = 3;
    raw.facedBet = 3;
    raw.foldedToBet = 1;
    raw.netChips = 35;
    const stats = toPublicStats(raw)!;
    expect(stats.vpipRate).toBeCloseTo(0.5, 5);
    expect(stats.pfrRate).toBeCloseTo(0.25, 5);
    expect(stats.aggression).toBeCloseTo(1, 5);
    expect(stats.foldToBetRate).toBeCloseTo(1 / 3, 5);
    expect(stats.netChips).toBe(35);
  });
});

describe('真人化决策不会破坏合法性', () => {
  it('极端对手统计 / 情绪下，四档 AI 仍然输出合法动作', async () => {
    const table = startNextHand(
      createTable({ playerCount: 4, seed: 'human-model-decide', difficulty: 'normal' }),
    );
    for (const difficulty of DIFFICULTY_ORDER) {
      const hand = table.hand!;
      const actorIndex = hand.actingIndex!;
      const actor = hand.players[actorIndex];
      const view = buildPlayerView(hand, actor.id, table.config.seed);
      if (view.legal === null) continue;
      view.self.mood = -2;
      for (const publicPlayer of view.players) {
        if (publicPlayer.id === view.viewerId) continue;
        publicPlayer.stats = statsOf({
          hands: 30,
          vpipRate: 0.85,
          pfrRate: 0.05,
          aggression: 0.4,
          foldToBetRate: 0.1,
          netChips: -500,
        });
      }
      const decision = await decide(view, difficulty, { maxIterations: 200 });
      const legal = view.legal;
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
        case 'bet':
        case 'raise':
          expect(decision.action.amount).toBeGreaterThanOrEqual(legal.minRaiseTo);
          expect(decision.action.amount).toBeLessThanOrEqual(legal.maxRaiseTo);
          break;
      }
      expect(decision.debug.reasoning.length).toBeGreaterThan(0);
      expect(decision.debug.profile.length).toBeGreaterThan(0);
    }
  });

  it('同一视图相同种子决策可复现', async () => {
    const table = startNextHand(
      createTable({ playerCount: 3, seed: 'human-model-repro', difficulty: 'hard' }),
    );
    const hand = table.hand!;
    const actor = hand.players[hand.actingIndex!];
    const view = buildPlayerView(hand, actor.id, table.config.seed);
    if (view.legal === null) return;
    view.self.mood = -1.5;
    const first = await decide(view, 'hard', { maxIterations: 300 });
    const second = await decide(view, 'hard', { maxIterations: 300 });
    expect(second.action).toEqual(first.action);
    expect(second.debug.equity).toBe(first.debug.equity);
  });
});
describe('大模型提示词包含对手公开画像', () => {
  it('有统计样本时 prompt 带 READS 行', () => {
    const table = startNextHand(
      createTable({ playerCount: 3, seed: 'llm-reads', difficulty: 'normal' }),
    );
    const hand = table.hand!;
    const actor = hand.players[hand.actingIndex!];
    const view = buildPlayerView(hand, actor.id, table.config.seed);
    for (const publicPlayer of view.players) {
      if (publicPlayer.id === view.viewerId) continue;
      publicPlayer.stats = statsOf({
        hands: 10,
        vpipRate: 0.62,
        pfrRate: 0.11,
        aggression: 0.8,
        foldToBetRate: 0.71,
      });
    }
    const config: LlmSeatConfig = {
      slot: 1,
      name: '测试模型',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'test-model',
      enabled: true,
    };
    const prompt = buildLlmPrompt(view, 'normal', config, { includeHints: false });
    expect(prompt.user).toContain('READS ');
    expect(prompt.user).toContain('VPIP62');
    expect(prompt.user).toContain('F2B71%');
  });
});

describe('maybeHumanMistake：真人式失误层', () => {
  function fakeCtx(overrides: {
    difficulty: Difficulty;
    action: PlayerAction;
    mood?: number;
    rng?: () => number;
    reference?: number;
    callAmount?: number;
    canCheck?: boolean;
    canBet?: boolean;
    hasDraw?: boolean;
  }) {
    const callAmount = overrides.callAmount ?? 40;
    const legal = {
      playerId: 0,
      currentBet: 0,
      callAmount,
      canFold: true,
      canCheck: overrides.canCheck ?? true,
      canCall: callAmount > 0,
      canBet: overrides.canBet ?? false,
      canRaise: false,
      canAllIn: false,
      minRaiseTo: 20,
      maxRaiseTo: 1000,
      aggressiveType: overrides.canBet ? 'bet' : null,
      raiseRights: true,
      isAllInCall: false,
    } as unknown as Parameters<typeof maybeHumanMistake>[0]['legal'];
    const view = {
      board: [{ rank: 2, suit: 'h' }, { rank: 5, suit: 's' }, { rank: 9, suit: 'd' }],
      pot: 100,
      bigBlind: 20,
      legal,
    } as unknown as PlayerView;
    const ctx = {
      view,
      legal,
      difficulty: overrides.difficulty,
      profile: DIFFICULTY_PROFILES[overrides.difficulty],
      rng: overrides.rng ?? (() => 0),
      potOdds: 0.2,
      mood: overrides.mood ?? 0,
      opponents: EMPTY_SUMMARY,
      styleId: 0,
    } as unknown as Parameters<typeof maybeHumanMistake>[0];
    return { ctx, legal, view };
  }

  it('入门：面对小注弃牌会被好奇心改成跟注', () => {
    const { ctx } = fakeCtx({
      difficulty: 'beginner',
      action: { type: 'fold' },
      callAmount: 40,
    });
    const result = maybeHumanMistake(ctx, { type: 'fold' }, undefined, false);
    expect(result?.action.type).toBe('call');
    expect(result?.note).toContain('真人式失误');
  });

  it('命中概率之外不会产生失误', () => {
    const { ctx } = fakeCtx({
      difficulty: 'beginner',
      action: { type: 'fold' },
      rng: () => 0.99,
    });
    expect(maybeHumanMistake(ctx, { type: 'fold' }, undefined, false)).toBeNull();
  });

  it('翻牌前不产生真人式失误', () => {
    const { ctx, view } = fakeCtx({ difficulty: 'beginner', action: { type: 'fold' } });
    (view as unknown as { board: unknown[] }).board = [];
    expect(maybeHumanMistake(ctx, { type: 'fold' }, undefined, false)).toBeNull();
  });

  it('上头时偶尔用弱牌乱加注', () => {
    const { ctx } = fakeCtx({
      difficulty: 'normal',
      action: { type: 'check' },
      mood: -1.8,
      canCheck: true,
      canBet: true,
      rng: () => 0,
    });
    const result = maybeHumanMistake(ctx, { type: 'check' }, 0.2, false);
    expect(result).not.toBeNull();
    expect(['bet', 'raise', 'allin']).toContain(result!.action.type);
    expect(result!.note).toContain('上头');
  });

  it('面对大注的边缘牌会被吓退', () => {
    const { ctx } = fakeCtx({
      difficulty: 'normal',
      action: { type: 'call' },
      callAmount: 80,
      canCheck: false,
      rng: () => 0,
    });
    const result = maybeHumanMistake(ctx, { type: 'call' }, 0.3, false);
    expect(result?.action.type).toBe('fold');
    expect(result?.note).toContain('大注');
  });

  it('专家几乎不出现明显失误（概率极低）', () => {
    const { ctx } = fakeCtx({
      difficulty: 'expert',
      action: { type: 'fold' },
      rng: () => 0,
    });
    expect(maybeHumanMistake(ctx, { type: 'fold' }, undefined, false)).toBeNull();
  });
});
