/**
 * GTO / 纳什均衡近似层测试：
 * - 均衡频率公式（MDF / 诈唬比例 / 价值诈唬比 / 底池赔率临界）；
 * - 各难度「均衡接近度」有序且挑战最高；
 * - 平衡诈唬混合与边界混合；
 * - 单挑短码 push/fold 抽象 CFR 求解器（频率范围、强牌更常推/跟、迭代降低可利用度）；
 * - GTO 短码建议与决策集成（挑战模式 debug 标注 GTO 接近度）。
 */
import { describe, expect, it } from 'vitest';
import type { LegalActions } from '../game/types';
import { buildPlayerView } from '../game/playerView';
import { playAction } from '../game/gameEngine';
import { decide } from '../ai/aiPlayer';
import {
  GTO_CLOSENESS,
  bluffFractionForSize,
  bluffToValueRatio,
  bucketOfStrength,
  equilibriumCallThreshold,
  gtoBluffChance,
  gtoBoundaryAdjust,
  gtoClosenessFor,
  gtoEvSizeChoice,
  gtoPushFoldAdvice,
  minimumDefenseFrequency,
  solvePushFold,
} from '../ai/gto';
import { CC, makeHand } from './helpers';
import type { PlayerView } from '../game/playerView';
import { depthLimitedSearch, estimateActionEv, multiwayCaution } from '../ai/search';

const legalBase: LegalActions = {
  playerId: 1,
  currentBet: 50,
  callAmount: 50,
  canFold: true,
  canCheck: false,
  canCall: true,
  canBet: false,
  canRaise: false,
  canAllIn: false,
  minRaiseTo: 100,
  maxRaiseTo: 1000,
  aggressiveType: 'raise',
  raiseRights: true,
  isAllInCall: false,
};

function seqRng(values: number[]): () => number {
  let cursor = 0;
  return () => values[Math.min(cursor++, values.length - 1)] ?? 0;
}

describe('均衡频率公式', () => {
  it('MDF = pot / (pot + bet)，诈唬比例 α = bet/(pot+2bet)', () => {
    expect(minimumDefenseFrequency(100, 50)).toBeCloseTo(2 / 3, 6);
    expect(minimumDefenseFrequency(100, 100)).toBeCloseTo(0.5, 6);
    expect(bluffFractionForSize(100, 50)).toBeCloseTo(0.25, 6);
    expect(bluffToValueRatio(100, 50)).toBeCloseTo(1 / 3, 6);
    expect(equilibriumCallThreshold(100, 50)).toBeCloseTo(0.25, 6);
    expect(minimumDefenseFrequency(100, 0)).toBe(1);
    expect(bluffFractionForSize(100, 0)).toBe(0);
  });

  it('gtoBluffChance：接近度 0 用启发式，接近度 1 用均衡 α', () => {
    const heuristic = 0.6;
    expect(gtoBluffChance(heuristic, 0, 100, 50)).toBeCloseTo(heuristic, 6);
    expect(gtoBluffChance(heuristic, 1, 100, 50)).toBeCloseTo(0.25, 6);
    const middle = gtoBluffChance(heuristic, 0.5, 100, 50);
    expect(middle).toBeGreaterThan(0.25);
    expect(middle).toBeLessThan(heuristic);
  });
});

describe('难度分级：均衡接近度', () => {
  it('入门 < 普通 < 困难 < 专家 < 挑战', () => {
    const beginner = gtoClosenessFor('beginner', false);
    const normal = gtoClosenessFor('normal', false);
    const hard = gtoClosenessFor('hard', false);
    const expert = gtoClosenessFor('expert', false);
    const challenge = gtoClosenessFor('normal', true);
    expect(beginner).toBeLessThan(normal);
    expect(normal).toBeLessThan(hard);
    expect(hard).toBeLessThan(expert);
    expect(expert).toBeLessThan(challenge);
    expect(challenge).toBe(GTO_CLOSENESS.challenge);
    expect(challenge).toBeGreaterThan(0.9);
    expect(beginner).toBeLessThan(0.1);
  });

  it('挑战模式始终使用最高接近度，与基础难度无关', () => {
    expect(gtoClosenessFor('beginner', true)).toBe(GTO_CLOSENESS.challenge);
    expect(gtoClosenessFor('expert', true)).toBe(GTO_CLOSENESS.challenge);
  });
});

describe('gtoBoundaryAdjust：底池赔率临界混合', () => {
  it('临界附近按接近度把弃牌混合成跟注', () => {
    const result = gtoBoundaryAdjust({
      action: { type: 'fold' },
      equity: 0.2,
      potOdds: 0.2,
      legal: legalBase,
      closeness: 1,
      rng: seqRng([0]),
    });
    expect(result?.action.type).toBe('call');
    expect(result?.note).toContain('GTO');
  });

  it('远离临界时不做混合；低接近度也不做', () => {
    expect(
      gtoBoundaryAdjust({
        action: { type: 'fold' },
        equity: 0.05,
        potOdds: 0.2,
        legal: legalBase,
        closeness: 1,
        rng: () => 0,
      }),
    ).toBeNull();
    expect(
      gtoBoundaryAdjust({
        action: { type: 'fold' },
        equity: 0.2,
        potOdds: 0.2,
        legal: legalBase,
        closeness: 0.1,
        rng: () => 0,
      }),
    ).toBeNull();
  });

  it('临界跟注也可能按均衡频率弃牌', () => {
    const result = gtoBoundaryAdjust({
      action: { type: 'call' },
      equity: 0.2,
      potOdds: 0.2,
      legal: legalBase,
      closeness: 1,
      rng: () => 0,
    });
    expect(result?.action.type).toBe('fold');
  });
});

describe('抽象 CFR：单挑短码 push/fold', () => {
  it('返回 10 个强度桶，频率合法，强牌更常全下 / 跟注', () => {
    const solution = solvePushFold({ iterations: 600, bypassCache: true });
    expect(solution.buckets).toBe(10);
    expect(solution.sbPushFrequency).toHaveLength(10);
    expect(solution.bbCallFrequency).toHaveLength(10);
    for (const frequency of solution.sbPushFrequency) {
      expect(frequency).toBeGreaterThanOrEqual(0);
      expect(frequency).toBeLessThanOrEqual(1);
    }
    for (const frequency of solution.bbCallFrequency) {
      expect(frequency).toBeGreaterThanOrEqual(0);
      expect(frequency).toBeLessThanOrEqual(1);
    }
    // 最强桶比最弱桶更愿意全下 / 跟注。
    expect(solution.sbPushFrequency[9]).toBeGreaterThan(solution.sbPushFrequency[0] + 0.3);
    expect(solution.bbCallFrequency[9]).toBeGreaterThanOrEqual(solution.bbCallFrequency[0]);
    expect(Number.isFinite(solution.exploitability)).toBe(true);
    expect(solution.exploitability).toBeGreaterThanOrEqual(0);
  });

  it('平均策略经单调投影后随牌力单调不减，可利用度有限', () => {
    const solution = solvePushFold({ iterations: 800, bypassCache: true });
    for (let index = 1; index < solution.buckets; index++) {
      expect(solution.sbPushFrequency[index]).toBeGreaterThanOrEqual(
        solution.sbPushFrequency[index - 1] - 1e-9,
      );
      expect(solution.bbCallFrequency[index]).toBeGreaterThanOrEqual(
        solution.bbCallFrequency[index - 1] - 1e-9,
      );
    }
    expect(solution.exploitability).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(solution.exploitability)).toBe(true);
    expect(solution.exploitability).toBeLessThanOrEqual(solution.stackBB * 2);
  });

  it('相同参数命中缓存，结果稳定', () => {
    const first = solvePushFold({ iterations: 500 });
    const second = solvePushFold({ iterations: 500 });
    expect(second.sbPushFrequency).toEqual(first.sbPushFrequency);
    expect(second.bbCallFrequency).toEqual(first.bbCallFrequency);
  });

  it('bucketOfStrength 单调映射', () => {
    const { boundaries } = solvePushFold({ iterations: 200 });
    expect(bucketOfStrength(0, boundaries)).toBe(0);
    expect(bucketOfStrength(1, boundaries)).toBe(9);
    let previous = -1;
    for (let strength = 0; strength <= 1; strength += 0.05) {
      const bucket = bucketOfStrength(strength, boundaries);
      expect(bucket).toBeGreaterThanOrEqual(previous);
      previous = bucket;
    }
  });
});

describe('GTO 短码建议与决策集成', () => {
  it('单挑短码给出推/弃建议，深筹码 / 多人桌不触发', () => {
    const hand = makeHand({
      stacks: [120, 120],
      buttonIndex: 1,
      holeCards: [undefined, CC('As Ah')],
    });
    expect(hand.actingIndex).toBe(1);
    const view = buildPlayerView(hand, 1, 'gto-sb');
    const advice = gtoPushFoldAdvice(view);
    expect(advice).not.toBeNull();
    expect(['push', 'fold']).toContain(advice!.action);
    expect(advice!.frequency).toBeGreaterThan(0);
    expect(advice!.note).toContain('GTO 短码');

    const deep = makeHand({
      stacks: [2000, 2000],
      buttonIndex: 1,
      holeCards: [undefined, CC('As Ah')],
    });
    expect(gtoPushFoldAdvice(buildPlayerView(deep, 1, 'gto-deep'))).toBeNull();

    const multiway = makeHand({
      stacks: [120, 120, 120],
      buttonIndex: 1,
      holeCards: [undefined, CC('As Ah')],
    });
    expect(gtoPushFoldAdvice(buildPlayerView(multiway, 1, 'gto-multi'))).toBeNull();
  });

  it('BB 面对全下时给出跟/弃建议', () => {
    const hand = makeHand({
      stacks: [120, 120],
      buttonIndex: 0,
      holeCards: [CC('7c 2d'), CC('As Ah')],
    });
    const pushed = playAction(hand, 0, { type: 'allin' });
    expect(pushed.actingIndex).toBe(1);
    const view = buildPlayerView(pushed, 1, 'gto-bb');
    expect(view.legal?.isAllInCall).toBe(true);
    const advice = gtoPushFoldAdvice(view);
    expect(advice).not.toBeNull();
    expect(['call', 'fold']).toContain(advice!.action);
  });

  it('挑战模式 debug 标注 GTO 接近度，基础难度不标', async () => {
    const hand = makeHand({
      stacks: [120, 120],
      buttonIndex: 1,
      holeCards: [undefined, CC('As Ah')],
    });
    const view = buildPlayerView(hand, 1, 'gto-decide');
    view.self.challengeArchetypeId = 0;
    const challenge = await decide(view, 'normal', { challenge: true, maxIterations: 80 });
    expect(challenge.debug.profile).toContain('GTO 92%');
    const normal = await decide(view, 'normal', { maxIterations: 80 });
    expect(normal.debug.profile).not.toContain('GTO');
  });
});

describe('gtoEvSizeChoice：尺度混合', () => {
  const legal = {
    ...legalBase,
    currentBet: 0,
    callAmount: 0,
    canCheck: true,
    canCall: false,
    canBet: true,
    aggressiveType: 'bet',
  } as LegalActions;

  const input = {
    fractions: [0.33, 0.66, 1],
    pot: 100,
    equity: 0.7,
    currentBet: 0,
    callAmount: 0,
    legal,
    foldToBetRate: 0.5,
    opponentCount: 1,
  };

  it('接近度越高越会按 softmax 混合尺度', () => {
    const greedy = gtoEvSizeChoice({ ...input, closeness: 0, rng: seqRng([0.9, 0.1]) });
    expect([0.33, 0.66, 1]).toContain(greedy.fraction);
    const mixed = gtoEvSizeChoice({ ...input, closeness: 1, rng: seqRng([0, 0.5]) });
    expect([0.33, 0.66, 1]).toContain(mixed.fraction);
    expect(mixed.note).toContain('GTO');
  });
});

describe('深度受限搜索 + 多人谨慎（DeepStack / Pluribus 借鉴）', () => {
  function searchView(pot = 100): PlayerView {
    return { pot } as unknown as PlayerView;
  }

  const facingBetLegal = {
    playerId: 1,
    currentBet: 100,
    callAmount: 100,
    canFold: true,
    canCheck: false,
    canCall: true,
    canBet: false,
    canRaise: true,
    canAllIn: false,
    minRaiseTo: 200,
    maxRaiseTo: 1000,
    aggressiveType: 'raise',
    raiseRights: true,
    isAllInCall: false,
  } as LegalActions;

  it('多人谨慎系数随对手数递减', () => {
    expect(multiwayCaution(1)).toBe(1);
    expect(multiwayCaution(2)).toBeGreaterThan(multiwayCaution(3));
    expect(multiwayCaution(3)).toBeGreaterThan(multiwayCaution(4));
  });

  it('正则型 CFR：迭代越多可利用度越低，且收敛到较低水平', () => {
    const coarse = solvePushFold({ iterations: 80, bypassCache: true });
    const fine = solvePushFold({ iterations: 4000, bypassCache: true });
    expect(fine.exploitability).toBeLessThan(coarse.exploitability + 1e-9);
    expect(fine.exploitability).toBeLessThan(0.1);
  });

  it('强牌可下注时搜索优先选择进攻动作', () => {
    const legal = {
      ...facingBetLegal,
      currentBet: 0,
      callAmount: 0,
      canCheck: true,
      canCall: false,
      canRaise: false,
      canBet: true,
      aggressiveType: 'bet',
    } as LegalActions;
    const ranked = depthLimitedSearch({
      view: searchView(),
      legal,
      equity: 0.9,
      opponentCount: 1,
      foldToBetRate: 0.5,
      timingWeak: true,
      closeness: 1,
    });
    expect(ranked.length).toBeGreaterThan(1);
    expect(['bet', 'raise', 'allin']).toContain(ranked[0].action.type);
  });

  it('弱牌面对大注时搜索优先弃牌', () => {
    const ranked = depthLimitedSearch({
      view: searchView(100),
      legal: facingBetLegal,
      equity: 0.15,
      opponentCount: 1,
      foldToBetRate: 0,
      closeness: 1,
    });
    expect(ranked[0].action.type).toBe('fold');
    expect(ranked[0].ev).toBe(0);
  });

  it('相同输入搜索结果确定，EV 按降序排列', () => {
    const input = {
      view: searchView(120),
      legal: facingBetLegal,
      equity: 0.45,
      opponentCount: 1,
      foldToBetRate: 0.45,
      closeness: 1,
    };
    const first = depthLimitedSearch(input);
    const second = depthLimitedSearch(input);
    expect(second.map((candidate) => candidate.action)).toEqual(
      first.map((candidate) => candidate.action),
    );
    for (let index = 1; index < first.length; index++) {
      expect(first[index].ev).toBeLessThanOrEqual(first[index - 1].ev);
    }
  });

  it('estimateActionEv 与搜索口径一致：弃牌为 0、跟注/过牌可估算', () => {
    const view = searchView(100);
    expect(
      estimateActionEv({
        action: { type: 'fold' },
        view,
        legal: facingBetLegal,
        equity: 0.3,
        opponentCount: 1,
        foldToBetRate: 0.4,
      }),
    ).toBe(0);
    const callEv = estimateActionEv({
      action: { type: 'call' },
      view,
      legal: facingBetLegal,
      equity: 0.3,
      opponentCount: 1,
      foldToBetRate: 0.4,
    });
    expect(callEv).not.toBeNull();
    expect(Number.isFinite(callEv!)).toBe(true);
  });
});
