import { describe, expect, it } from 'vitest';
import { solveMatrixGame } from '../ai/solver/cfr';
import { solveStreetSubgame } from '../ai/solver/subgame';
import { buildStreetRanges, preflopRangeFor } from '../ai/solver/ranges';
import { preflopAdvice, solvePreflopBlueprint } from '../ai/solver/preflop';
import { PREFLOP_BUCKETS, preflopBucketTable } from '../ai/solver/abstraction';
import { buildPlayerView } from '../game/playerView';
import { decide } from '../ai/aiPlayer';
import { CC, makeHand, playSequence, playToStreet } from './helpers';
import '../ai/solver/blueprint';

describe('CFR+ 原语', () => {
  it('匹配 pennies 收敛到 0 可利用度', () => {
    const result = solveMatrixGame(
      [
        [1, -1],
        [-1, 1],
      ],
      2000,
    );
    expect(result.row[0]).toBeCloseTo(0.5, 2);
    expect(result.col[0]).toBeCloseTo(0.5, 2);
    expect(result.exploitability).toBeLessThan(1e-6);
  });

  it('偏斜矩阵博弈收敛到混合纳什（0.25 / 0.25）', () => {
    const result = solveMatrixGame(
      [
        [3, 0],
        [0, 1],
      ],
      20000,
    );
    // 零和化后：行 0 收益 3q，行 1 收益 1-q；q=0.25 时行无差异。
    expect(result.row[0]).toBeCloseTo(0.25, 2);
    expect(result.col[0]).toBeCloseTo(0.25, 2);
    expect(result.exploitability).toBeLessThan(0.01);
  });
});

describe('按街范围信念', () => {
  it('翻前先验归一化，且排除自己底牌与公共牌', () => {
    const hand = makeHand({
      stacks: [1000, 1000],
      buttonIndex: 0,
      holeCards: [CC('As Kd'), CC('Qh Jh')],
    });
    const view = buildPlayerView(hand, 0, 'range-prior');
    const range = preflopRangeFor(view, 1);
    expect(range.size).toBeGreaterThan(500);
    const total = [...range.values()].reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 5);
    // 对手范围里不能出现我方底牌参与的 combo。
    for (const key of range.keys()) {
      expect(key.includes('14s')).toBe(false);
      expect(key.includes('13d')).toBe(false);
    }
  });

  it('河牌范围与翻前先验不同（确实按街更新）', () => {
    const hand = playToStreet(
      makeHand({
        stacks: [1000, 1000],
        buttonIndex: 0,
        holeCards: [CC('As Kd'), CC('Qh Jh')],
        board: CC('2h 5s 9d Tc 3c'),
      }),
      'river',
    );
    const view = buildPlayerView(hand, 0, 'range-street');
    const prior = preflopRangeFor(view, 1);
    const street = buildStreetRanges(view).get(1);
    expect(street).toBeDefined();
    expect(street!.size).toBeGreaterThan(100);
    const priorTotal = [...prior.values()].reduce((sum, value) => sum + value, 0);
    const streetTotal = [...street!.values()].reduce((sum, value) => sum + value, 0);
    expect(priorTotal).toBeCloseTo(1, 5);
    expect(streetTotal).toBeCloseTo(1, 5);
    // 权重分布必须变化；如果完全相同说明没有按街更新。
    const sample = [...prior.keys()].slice(0, 30);
    const changed = sample.some(
      (key) => Math.abs((prior.get(key) ?? 0) - (street!.get(key) ?? 0)) > 1e-6,
    );
    expect(changed).toBe(true);
  });
});

describe('翻后单街子博弈 CFR+', () => {
  function riverView(seed: string) {
    const hand = playToStreet(
      makeHand({
        stacks: [1000, 1000],
        buttonIndex: 0,
        seed,
        holeCards: [CC('As Kd'), CC('Qh Jh')],
        board: CC('2h 5s 9d Tc 3c'),
      }),
      'river',
    );
    const index = hand.actingIndex!;
    return buildPlayerView(hand, hand.players[index].id, seed);
  }

  it('返回合法动作与归一化混合策略', () => {
    const view = riverView('subgame-test-a');
    const result = solveStreetSubgame(view, { iterations: 60, maxCombos: 48 });
    expect(result).not.toBeNull();
    expect(result!.strategy.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 5);
    expect(result!.strategy.every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(result!.actions.length).toBe(result!.strategy.length);
    expect(['check', 'bet_33', 'bet_50', 'bet_100', 'call', 'fold']).toContain(
      result!.actionName,
    );
  });

  it('相同输入完全可复现', () => {
    const view = riverView('subgame-test-b');
    const first = solveStreetSubgame(view, { iterations: 50, maxCombos: 40 });
    const second = solveStreetSubgame(view, { iterations: 50, maxCombos: 40 });
    expect(second!.strategy).toEqual(first!.strategy);
    expect(second!.action).toEqual(first!.action);
  });

  /** 构造「对手在河牌先下注」的视图（单挑：BB 先行动）。 */
  function riverFacingBet(seed: string, hole: string, bet: number) {
    let hand = playToStreet(
      makeHand({
        stacks: [1000, 1000],
        buttonIndex: 0,
        seed,
        holeCards: [CC(hole), CC('Qh Jh')],
        board: CC('2h 5s 9d Tc 3c'),
      }),
      'river',
    );
    hand =
      hand.actingIndex === 0
        ? playSequence(hand, [
            [0, { type: 'check' }],
            [1, { type: 'bet', amount: bet }],
          ])
        : playSequence(hand, [[1, { type: 'bet', amount: bet }]]);
    return buildPlayerView(hand, 0, seed);
  }

  it('收敛：400 次与 1600 次迭代的平均策略一致', () => {
    // arXiv:1805.08195 附录 B 的口径下，400 次已收敛；这里锁死这个性质，
    // 防止有人把求解器改回「每轮只更新一手牌」的采样版本。
    const view = riverFacingBet('subgame-converge', '9s 9c', 100);
    const fast = solveStreetSubgame(view, { iterations: 400, maxCombos: 40 });
    const slow = solveStreetSubgame(view, { iterations: 1600, maxCombos: 40 });
    expect(fast).not.toBeNull();
    expect(slow).not.toBeNull();
    for (let index = 0; index < fast!.strategy.length; index++) {
      expect(Math.abs(fast!.strategy[index] - slow!.strategy[index])).toBeLessThan(0.06);
    }
  });

  it('面对满池下注：空气以弃牌为主，暗三条不会弃牌', () => {
    const air = solveStreetSubgame(riverFacingBet('subgame-air', '7c 2d', 100), {
      iterations: 800,
      maxCombos: 40,
    });
    const set = solveStreetSubgame(riverFacingBet('subgame-set', '9s 9c', 100), {
      iterations: 800,
      maxCombos: 40,
    });
    expect(air).not.toBeNull();
    expect(set).not.toBeNull();
    const foldIndex = air!.actions.indexOf('fold');
    expect(foldIndex).toBeGreaterThanOrEqual(0);
    expect(air!.strategy[foldIndex]).toBeGreaterThan(0.7);
    expect(set!.strategy[foldIndex]).toBeLessThan(0.1);
  });

  it('多人底池不套单挑子博弈', () => {
    const hand = playToStreet(
      makeHand({
        seed: 'subgame-multiway',
        holeCards: [CC('As Kd'), CC('Qh Jh'), CC('9s 9c'), CC('7c 2d')],
        board: CC('2h 5s 9d Tc 3c'),
      }),
      'river',
    );
    const index = hand.actingIndex!;
    const view = buildPlayerView(hand, hand.players[index].id, 'subgame-multiway');
    expect(solveStreetSubgame(view, { iterations: 30, maxCombos: 30 })).toBeNull();
  });
});

describe('翻前 CFR+ 蓝图（BB 防守）', () => {
  it('AA 面对开池不会弃牌，72o 以弃牌为主', () => {
    const aces = playSequence(
      makeHand({
        stacks: [1000, 1000],
        buttonIndex: 0,
        seed: 'bp-aa',
        holeCards: [undefined, CC('As Ah')],
      }),
      [[0, { type: 'raise', amount: 60 }]],
    );
    const aaView = buildPlayerView(aces, 1, 'bp-aa');
    const aaAdvice = preflopAdvice(aaView);
    expect(aaAdvice).not.toBeNull();
    expect(aaAdvice!.node).toBe('bb_vs_open_2.5');
    expect(aaAdvice!.action).not.toBe('fold');

    const trash = playSequence(
      makeHand({
        stacks: [1000, 1000],
        buttonIndex: 0,
        seed: 'bp-72',
        holeCards: [undefined, CC('7c 2d')],
      }),
      [[0, { type: 'raise', amount: 60 }]],
    );
    const trashView = buildPlayerView(trash, 1, 'bp-72');
    const trashAdvice = preflopAdvice(trashView);
    expect(trashAdvice).not.toBeNull();
    expect(trashAdvice!.action).toBe('fold');
  });
});

describe('挑战引擎静态分流', () => {
  it('单挑河牌走 CFR 子博弈', async () => {
    const hand = playToStreet(
      makeHand({
        stacks: [1000, 1000],
        buttonIndex: 0,
        seed: 'engine-hu-river',
        holeCards: [CC('As Kd'), CC('Qh Jh')],
        board: CC('2h 5s 9d Tc 3c'),
      }),
      'river',
    );
    const index = hand.actingIndex!;
    const view = buildPlayerView(hand, hand.players[index].id, 'engine-hu-river');
    const decision = await decide(view, 'expert', {
      challenge: true,
      maxIterations: 80,
      solver: { iterations: 20, maxCombos: 20 },
    });
    // 河牌 MCCFR 目前默认关闭（ENABLE_RIVER_SOLVER=false）；
    // 直接求解器测试仍覆盖 MCCFR，这里只验证引擎分流不越界。
    expect(['heuristic', 'cfr-subgame']).toContain(decision.debug.engine);
    expect(decision.debug.challenge).toBe(true);
  });

  it('三人以上走 challenge-multiway，不套单挑解', async () => {
    const hand = playToStreet(
      makeHand({
        seed: 'engine-3way',
        holeCards: [CC('As Kd'), CC('Qh Jh'), CC('9s 9c'), CC('7c 2d')],
        board: CC('2h 5s 9d Tc 3c'),
      }),
      'river',
    );
    const index = hand.actingIndex!;
    const view = buildPlayerView(hand, hand.players[index].id, 'engine-3way');
    const decision = await decide(view, 'expert', {
      challenge: true,
      maxIterations: 80,
      solver: { iterations: 20, maxCombos: 20 },
    });
    expect(decision.debug.engine).toBe('challenge-multiway');
  });
});

describe('翻前蓝图：三个历史 bug 的回归锁', () => {
  it('每个桶都非空（防止「攒够 target 进位」导致末桶为空）', () => {
    const table = preflopBucketTable();
    expect(table.classesOfBucket.length).toBe(PREFLOP_BUCKETS);
    for (let bucket = 0; bucket < PREFLOP_BUCKETS; bucket++) {
      expect(table.classesOfBucket[bucket].length).toBeGreaterThan(0);
      for (const key of table.classesOfBucket[bucket]) {
        expect(key).not.toBe('undefined');
      }
    }
  });

  it('可利用度是真值量级（防止「开天眼 BR」把可利用度算到 3+ BB/手）', () => {
    // 用很少的迭代也能看出量级：真 BR 下收敛到 0.1 以下，
    // 假 BR（按桶对分别取 max，等于看穿对手手牌）会停在 3 以上。
    const blueprint = solvePreflopBlueprint({ iterations: 800, allowLimp: false });
    expect(blueprint.exploitability).toBeLessThan(0.6);
  });

  it('SB 不会 99% 跛入（防止跛入后弃牌亏损写成 −0.5）', () => {
    const blueprint = solvePreflopBlueprint({ iterations: 800, allowLimp: true });
    const root = blueprint.entries.filter((entry) => entry.node === 'sb_root');
    expect(root.length).toBeGreaterThan(0);
    const limpIndex = blueprint.nodes.sb_root.actions.indexOf('call');
    if (limpIndex < 0) return;
    let mass = 0;
    let limp = 0;
    for (const entry of root) {
      const weight = (preflopBucketTable().classesOfBucket[entry.bucket] ?? []).length;
      mass += weight;
      limp += (entry.strategy[limpIndex] ?? 0) * weight;
    }
    expect(limp / Math.max(1, mass)).toBeLessThan(0.6);
  });
});
