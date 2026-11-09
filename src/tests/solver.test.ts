import { describe, expect, it } from 'vitest';
import { solveMatrixGame } from '../ai/solver/cfr';
import { solveStreetSubgame } from '../ai/solver/subgame';
import { solveTurnRiver } from '../ai/solver/subgameTurn';
import { buildStreetRanges, preflopRangeFor, rangeFromWeight } from '../ai/solver/ranges';
import {
  effectiveStackBB,
  preflopAdvice,
  preflopNodeForView,
  solvePreflopBlueprint,
} from '../ai/solver/preflop';
import { evaluatePreflopBlueprint } from '../ai/solver/blueprintEval';
import { PREFLOP_BLUEPRINT } from '../ai/solver/blueprint';
import { PREFLOP_BUCKETS, preflopBucketTable } from '../ai/solver/abstraction';
import { flopSpotMatches } from '../ai/solver/flopBlueprint';
import { turnValueFeaturesOf, TURN_VALUE_FEATURES } from '../ai/solver/turnValue';
import type { Card } from '../game/types';
import { DEFAULT_CONFIG } from '../game/types';
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
    // 河牌单街求解默认启用（ENABLE_RIVER_SOLVER=true），但专家档单挑河牌只有 20% 概率走求解器，
    // 所以这里断言「两种引擎都合法」，不锁死具体分支；直接求解器测试仍覆盖 MCCFR 本身。
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

describe('翻前节点映射：全下不是 3-bet（P0 回归锁）', () => {
  /** SB 开池到 openBB，BB 用 allin / 3-bet 回应，返回 SB 的视图。 */
  function sbFacing(second: { type: 'allin' } | { type: 'raise'; amount: number }, openBB: number) {
    const hand = makeHand({
      stacks: [1000, 1000],
      buttonIndex: 0,
      seed: 'bp-map',
      holeCards: [CC('As Kd'), CC('Qh Jh')],
    });
    const played = playSequence(hand, [
      [0, { type: 'raise', amount: openBB * 20 }],
      [1, second],
    ]);
    return buildPlayerView(played, 0, 'bp-map');
  }

  it('BB 全下 → sb_vs_allin_*；BB 再加注 → sb_vs_3bet_*', () => {
    // 旧实现只数「加注次数」，把全下也算成一次加注，于是 SB 面对 50BB 全下
    // 拿到的是 sb_vs_3bet_*（按 7.5BB 3-bet 解出来的防守范围，弃 53.7%）。
    expect(preflopNodeForView(sbFacing({ type: 'allin' }, 2.5))).toEqual({
      node: 'sb_vs_allin_2.5',
      player: 'sb',
    });
    expect(preflopNodeForView(sbFacing({ type: 'raise', amount: 150 }, 2.5))).toEqual({
      node: 'sb_vs_3bet_2.5',
      player: 'sb',
    });
  });

  it('3.5BB 开池后的全下走 3.5 那一套节点', () => {
    expect(preflopNodeForView(sbFacing({ type: 'allin' }, 3.5))).toEqual({
      node: 'sb_vs_allin_3.5',
      player: 'sb',
    });
  });

  it('面对全下拿到的动作集是 fold / call（没有再加注）', () => {
    const advice = preflopAdvice(sbFacing({ type: 'allin' }, 2.5));
    expect(advice).not.toBeNull();
    expect(advice!.node).toBe('sb_vs_allin_2.5');
    expect(advice!.actions).toEqual(['fold', 'call']);
  });
});

describe('翻前蓝图离线验收（v0.26 按实战桌深重训）', () => {
  it('训练深度等于实战桌深：1000 筹码 / 20 大盲 = 50BB', () => {
    // 旧产物按 100BB 训练，而每手都以 50BB 开局（createTable 的 startingStack）。
    // all-in 分支是唯一对深度敏感的地方，深度错了策略就等于按 2 倍筹码算出来的。
    const realStackBB = DEFAULT_CONFIG.startingStack / DEFAULT_CONFIG.bigBlind;
    expect(PREFLOP_BLUEPRINT.stackBB).toBe(realStackBB);
  });

  it('抽象只含运行时真能执行的动作：3-bet 用最小加注', () => {
    // preflopActionOf 把 raise_big 折算成 3.5BB，实际执行就是 open+1BB 的最小加注。
    // 树里按 open×3 解出来的 3-bet 防守范围，运行时根本用不上。
    expect(PREFLOP_BLUEPRINT.threeBet ?? 'x3').toBe('min');
  });

  it('离线验收器与求解器等价（同一份蓝图，两条实现算出的可利用度一致）', () => {
    // 这条锁住 blueprintEval.ts 与 preflop.ts 的叶节点估值/最佳回应没有漂移。
    // 一旦有人只改一边，这里会立刻红。
    const fresh = solvePreflopBlueprint({ iterations: 800, allowLimp: false });
    const audited = evaluatePreflopBlueprint(fresh, {
      stackBB: fresh.stackBB,
      threeBet: fresh.threeBet,
    });
    expect(audited.exploitability).toBeCloseTo(fresh.exploitability, 3);
  });

  it('仓库里的蓝图在运行时口径下可利用度 ≤ 0.05 BB/手', () => {
    // 旧产物在同深度的抽象里是 1.15 BB/手（按 100BB 训、放到 50BB 打）。
    const result = evaluatePreflopBlueprint(PREFLOP_BLUEPRINT, {
      stackBB: PREFLOP_BLUEPRINT.stackBB,
      threeBet: 'min',
      jamMapping: 'correct',
    });
    expect(result.exploitability).toBeLessThan(0.05);
  });
});

describe('翻前节点映射：开池全下走专节点（B）', () => {
  it('SB 开池即全下 → bb_vs_allin，而不是按 3.5BB 开池解的 bb_vs_open_3.5', () => {
    // 旧映射只看「第一个加注的尺度」：50BB 全下 > 3BB，于是落进 bb_vs_open_3.5，
    // 那是弃 40.5% / 跟 44.7% 的开池防守范围，拿去接 50BB 全下明显太松。
    const hand = playSequence(
      makeHand({ stacks: [1000, 1000], buttonIndex: 0, seed: 'bp-allin-open', holeCards: [undefined, CC('Qh Jh')] }),
      [[0, { type: 'allin' }]],
    );
    const view = buildPlayerView(hand, 1, 'bp-allin-open');
    expect(preflopNodeForView(view)).toEqual({ node: 'bb_vs_allin', player: 'bb' });
    const advice = preflopAdvice(view);
    expect(advice).not.toBeNull();
    expect(advice!.actions).toEqual(['fold', 'call']);
  });
});

describe('翻前蓝图深度闸门（A）', () => {
  async function engineAt(stacks: number, gate = true): Promise<string> {
    const hand = makeHand({
      stacks: [stacks, stacks],
      buttonIndex: 0,
      seed: 'bp-gate',
      holeCards: [CC('As Kd'), CC('Qh Jh')],
    });
    const index = hand.actingIndex!;
    const view = buildPlayerView(hand, index, 'bp-gate');
    const decision = await decide(view, 'expert', {
      challenge: true,
      maxIterations: 200,
      blueprintStackGate: gate,
    });
    return decision.debug.engine ?? 'unknown';
  }

  it('有效筹码换算：1000 筹码 / 20 大盲 = 50BB', () => {
    const hand = makeHand({ stacks: [1000, 1000], buttonIndex: 0, seed: 'bp-eff' });
    const view = buildPlayerView(hand, 0, 'bp-eff');
    expect(effectiveStackBB(view)).toBeCloseTo(50, 6);
  });

  it('40BB 在闸门内：走蓝图', async () => {
    expect(await engineAt(800)).toBe('preflop-blueprint');
  });

  it('20BB 在闸门外：不走蓝图（push/fold 表或启发式接管）', async () => {
    // 蓝图按 50BB 求解，短码还去套它会盖掉 decidePreflop 里已经返回的
    // gtoPushFoldAdvice——那才是 15~20BB 下正确的策略。
    expect(await engineAt(400)).not.toBe('preflop-blueprint');
  });

  it('80BB 在闸门外：不走蓝图', async () => {
    expect(await engineAt(1600)).not.toBe('preflop-blueprint');
  });

  it('blueprintStackGate=false 时闸门失效（消融可复现 v0.25 行为）', async () => {
    expect(await engineAt(400, false)).toBe('preflop-blueprint');
  });
});

describe('转牌 + 河牌联合求解（不需要价值函数）', () => {
  function turnView(seed: string, hole: string, villainBet: number | null) {
    let hand = playToStreet(
      makeHand({
        stacks: [1000, 1000],
        buttonIndex: 0,
        seed,
        holeCards: [CC(hole), CC('Qh Jh')],
        board: CC('2h 5s 9d Tc 3c'),
      }),
      'turn',
    );
    if (villainBet !== null) {
      hand =
        hand.actingIndex === 0
          ? playSequence(hand, [
              [0, { type: 'check' }],
              [1, { type: 'bet', amount: villainBet }],
            ])
          : playSequence(hand, [[1, { type: 'bet', amount: villainBet }]]);
    } else if (hand.actingIndex === 1) {
      hand = playSequence(hand, [[1, { type: 'check' }]]);
    }
    return buildPlayerView(hand, 0, seed);
  }

  it('返回合法动作与归一化混合策略', () => {
    const view = turnView('tr-valid', '9s 9c', 100);
    const result = solveTurnRiver(view, { iterations: 80, maxCombos: 16, riverBuckets: 3 });
    expect(result).not.toBeNull();
    expect(result!.strategy.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 5);
    expect(result!.strategy.every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(result!.riverBuckets).toBeGreaterThan(0);
    expect(result!.actions.length).toBe(result!.strategy.length);
  });

  it('相同输入完全可复现', () => {
    const view = turnView('tr-repeat', '9s 9c', 100);
    const first = solveTurnRiver(view, { iterations: 60, maxCombos: 16, riverBuckets: 3 });
    const second = solveTurnRiver(view, { iterations: 60, maxCombos: 16, riverBuckets: 3 });
    expect(second!.strategy).toEqual(first!.strategy);
    expect(second!.action).toEqual(first!.action);
  });

  it('收敛：200 次与 800 次迭代的平均策略一致', () => {
    const view = turnView('tr-converge', '9s 9c', 100);
    const fast = solveTurnRiver(view, { iterations: 200, maxCombos: 20, riverBuckets: 3 });
    const slow = solveTurnRiver(view, { iterations: 800, maxCombos: 20, riverBuckets: 3 });
    for (let index = 0; index < fast!.strategy.length; index++) {
      expect(Math.abs(fast!.strategy[index] - slow!.strategy[index])).toBeLessThan(0.08);
    }
  });

  it('面对下注：空气以弃牌为主，暗三条不会弃牌', () => {
    const air = solveTurnRiver(turnView('tr-air', '7c 2d', 100), {
      iterations: 200,
      maxCombos: 20,
      riverBuckets: 3,
    });
    const set = solveTurnRiver(turnView('tr-set', '9s 9c', 100), {
      iterations: 200,
      maxCombos: 20,
      riverBuckets: 3,
    });
    const foldIndex = air!.actions.indexOf('fold');
    expect(foldIndex).toBeGreaterThanOrEqual(0);
    expect(air!.strategy[foldIndex]).toBeGreaterThan(0.7);
    expect(set!.strategy[foldIndex]).toBeLessThan(0.1);
  });

  it('多人底池不套单挑解', () => {
    const hand = playToStreet(
      makeHand({
        seed: 'tr-multiway',
        holeCards: [CC('As Kd'), CC('Qh Jh'), CC('9s 9c'), CC('7c 2d')],
        board: CC('2h 5s 9d Tc 3c'),
      }),
      'turn',
    );
    const index = hand.actingIndex!;
    const view = buildPlayerView(hand, hand.players[index].id, 'tr-multiway');
    expect(solveTurnRiver(view, { iterations: 30, maxCombos: 16 })).toBeNull();
  });
});

describe('范围转换（求解器与启发式共用同一套范围）', () => {
  it('rangeFromWeight 展开的组合数正确且不含被占用的牌', () => {
    const hand = playToStreet(
      makeHand({
        stacks: [1000, 1000],
        buttonIndex: 0,
        seed: 'range-convert',
        holeCards: [CC('As Kd'), CC('Qh Jh')],
        board: CC('2h 5s 9d Tc 3c'),
      }),
      'river',
    );
    const view = buildPlayerView(hand, 0, 'range-convert');
    const range = rangeFromWeight(view, () => 1, 1);
    // 52 - 2（我方）- 5（公共牌）= 45 张，C(45,2) = 990
    expect(range.size).toBe(990);
    expect(range.has('As|Kd')).toBe(false);
    expect(range.has('2h|5s')).toBe(false);
  });

  it('权重为 0 或非有限的组合被排除', () => {
    const hand = playToStreet(
      makeHand({
        stacks: [1000, 1000],
        buttonIndex: 0,
        seed: 'range-zero',
        holeCards: [CC('As Kd'), CC('Qh Jh')],
        board: CC('2h 5s 9d Tc 3c'),
      }),
      'river',
    );
    const view = buildPlayerView(hand, 0, 'range-zero');
    const range = rangeFromWeight(view, (first) => (first.rank === 14 ? 1 : 0), 1);
    expect(range.size).toBeGreaterThan(0);
    for (const key of range.keys()) expect(key.includes('14')).toBe(true);
  });
});

describe('翻牌蓝图的适用范围（v0.24.0 修复）', () => {
  const BB = 20;
  const raise = (toBB: number) => ({ action: { type: 'raise', amount: toBB * BB } });
  const call = { action: { type: 'call' } };
  const limp = { action: { type: 'call' } };
  const check = { action: { type: 'check' } };
  const fold = { action: { type: 'fold' } };

  it('单加注底池（开注 2.5~3.5BB + 跟注）才算命中', () => {
    expect(flopSpotMatches([raise(3), call], BB)).toBe(true);
    expect(flopSpotMatches([raise(2.5), call], BB)).toBe(true);
  });

  it('跛入池 / 弃牌 / 3-bet 池 / 超大开注都不命中', () => {
    // 旧实现只要翻牌纹理命中就套用蓝图，这些底池形状它根本没解过
    expect(flopSpotMatches([limp, check], BB)).toBe(false);
    expect(flopSpotMatches([raise(3), fold], BB)).toBe(false);
    expect(flopSpotMatches([raise(3), raise(9), call], BB)).toBe(false);
    expect(flopSpotMatches([raise(12), call], BB)).toBe(false);
    expect(flopSpotMatches([], BB)).toBe(false);
  });
});

describe('转牌价值网络：特征必须能区分成牌类别（v0.24.0 扩容）', () => {
  it('特征维度为 24，且成牌类别 one-hot 只亮一个', () => {
    const board = CC('9s 2h Kd 7c') as [Card, Card, Card, Card];
    const cases: Array<[string, number]> = [
      ['Ac Ah', 1], // 一对（超对）
      ['9h 9d', 3], // 三条
      ['Kh Kc', 3], // 三条
      ['Tc Jc', 0], // 高牌 + 听牌
    ];
    for (const [hole, category] of cases) {
      const features = turnValueFeaturesOf({
        hole: CC(hole) as [Card, Card],
        board,
        pot: 200,
        callAmount: 0,
        stack: 900,
        canCheck: true,
      });
      expect(features.length).toBe(TURN_VALUE_FEATURES);
      // 索引 14..19 是类别 one-hot
      const hot = features.slice(14, 20).reduce((a, b) => a + b, 0);
      expect(hot).toBeCloseTo(1, 6);
      if (category <= 4) {
        expect(features[14 + category]).toBe(1);
      } else {
        expect(features[19]).toBe(1);
      }
    }
  });

  it('同样的牌，面对下注时「面对下注」位为 1', () => {
    const base = {
      hole: CC('Ac Ah') as [Card, Card],
      board: CC('9s 2h Kd 7c') as [Card, Card, Card, Card],
      pot: 200,
      stack: 900,
    };
    const free = turnValueFeaturesOf({ ...base, callAmount: 0, canCheck: true });
    const facing = turnValueFeaturesOf({ ...base, callAmount: 100, canCheck: false });
    expect(free[13]).toBe(0);
    expect(facing[13]).toBe(1);
  });
});
