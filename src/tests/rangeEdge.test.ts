/**
 * 挑战档「范围优势层」测试。
 *
 * 这一层只做一件事：在纹理层算完的 `sizeFactor` 上，按双方范围的牌面契合度差
 * （`rangeAdvantage().edge`）做 **≤±12%** 的尺度修正，并且只在 `|edge| > 0.10` 时生效。
 *
 * 因此验收重点是**三件容易做错的事**：
 *   1. 关掉它必须回到接线前的逐位行为（用接线前抓的快照做黄金测试，不是自证）；
 *   2. 门槛内必须逐位不变（否则等于给 77% 的决策注入噪声）；
 *   3. 乘子必须有界，且不与纹理层连乘失控。
 */
import { describe, expect, it } from 'vitest';
import '../ai/solver/blueprint';
import { decide, type AIDecisionOptions } from '../ai/aiPlayer';
import { buildPlayerView, type PlayerView } from '../game/playerView';
import { buildBlueprintRangeWeights } from '../ai/solver/preflop';
import {
  RANGE_EDGE_MAX_SWING,
  RANGE_EDGE_THRESHOLD,
  SIZE_FACTOR_MAX,
  SIZE_FACTOR_MIN,
  rangeEdgeFromRanges,
  rangeEdgeSizeFactor,
} from '../ai/rangeEdge';
import { textureSizeFactor, boardTexture } from '../ai/flopTexture';
import { turnSizeFactor, turnTexture } from '../ai/turnTexture';
import { C, makeHand, playSequence, playToStreet } from './helpers';
import type { Card, PlayerAction } from '../game/types';

const P = (...cards: string[]): Card[] => cards.map((text) => C(text));

interface Scenario {
  name: string;
  holeCards: Card[][];
  board: Card[];
  seed: string;
  street: 'flop' | 'turn';
  challenge: boolean;
  archetype: number;
}

/**
 * 接线前抓的快照（commit 84414c3，`challenge` 档默认行为）。
 * 这些字符串是**回归证据**：`rangeEdge: false` 必须逐字复现它们。
 * 若将来有与范围优势无关的改动（例如剥削文案）确实应该改变这些字符串，
 * 请在改动那次提交里一并重抓快照，并在提交信息里写明原因。
 */
const GOLDEN: Record<string, { action: unknown; reasoning: string; equity: number }> = {
  'hu-flop-Ahigh-dry-btn': {
    action: { type: 'check' },
    reasoning:
      '专家风格：高牌，范围收窄后蒙特卡洛 220 次胜率 47.7%，底池赔率 0.0%，SPR 24.50；对手 1 人（加注 0 次 / 跟注 1 次）；过牌，保留摊牌价值；计划转牌按牌力收缩；剥削：样本不足，按 GTO 基准。（计时伪装：正常节奏）',
    equity: 0.477273,
  },
  'hu-flop-mid-wet-bb': {
    action: { type: 'check' },
    reasoning:
      '专家风格：高牌，范围收窄后蒙特卡洛 220 次胜率 50.2%，底池赔率 0.0%，SPR 24.50；对手 1 人（加注 0 次 / 跟注 1 次）；过牌，保留摊牌价值；计划转牌按牌力收缩；剥削：样本不足，按 GTO 基准。（计时伪装：长考）',
    equity: 0.502273,
  },
  'hu-turn-blank': {
    action: { type: 'check' },
    reasoning:
      '专家风格：高牌，范围收窄后蒙特卡洛 220 次胜率 27.0%，底池赔率 0.0%，SPR 24.50；对手 1 人（加注 0 次 / 跟注 1 次）；过牌，保留摊牌价值；计划河牌控池；剥削：跟注站（置信度 0%，采纳 92%），压薄价值线、停止诈唬、放大尺度，弃牌信号 -40%，偏大尺度。（计时伪装：秒打）',
    equity: 0.270455,
  },
  'hu-turn-scare': {
    action: { type: 'bet', amount: 40 },
    reasoning:
      '专家风格：一对，范围收窄后蒙特卡洛 220 次胜率 71.4%，底池赔率 0.0%，SPR 24.50；对手 1 人（加注 0 次 / 跟注 1 次）；胜率超过价值线 51%，混合尺度下注；计划河牌继续价值下注；剥削：跟注站（置信度 0%，采纳 92%），压薄价值线、停止诈唬、放大尺度，弃牌信号 -40%，偏大尺度。（计时伪装：秒打）',
    equity: 0.713636,
  },
  'expert-flop': {
    action: { type: 'bet', amount: 27 },
    reasoning:
      '专家风格：一对，范围收窄后蒙特卡洛 220 次胜率 75.5%，底池赔率 0.0%，SPR 24.50；对手 1 人（加注 0 次 / 跟注 1 次）；胜率超过价值线 60%，混合尺度下注；计划转牌继续价值下注；剥削：样本不足，按 GTO 基准。',
    equity: 0.754545,
  },
  'expert-turn': {
    action: { type: 'bet', amount: 40 },
    reasoning:
      '专家风格：三条，范围收窄后蒙特卡洛 220 次胜率 98.6%，底池赔率 0.0%，SPR 24.50；对手 1 人（加注 0 次 / 跟注 1 次）；高胜率价值下注（多尺度）；计划河牌继续价值下注；剥削：跟注站（置信度 0%，采纳 55%），压薄价值线、停止诈唬、放大尺度，弃牌信号 -40%，偏大尺度。',
    equity: 0.986364,
  },
};

const SCENARIOS: Scenario[] = [
  {
    name: 'hu-flop-Ahigh-dry-btn',
    holeCards: [P('As', 'Kd'), P('Qh', 'Jh')],
    board: P('Ah', '7c', '2d', 'Ts', '9c'),
    seed: 'snap-1',
    street: 'flop',
    challenge: true,
    archetype: 0,
  },
  {
    name: 'hu-flop-mid-wet-bb',
    holeCards: [P('9h', '8h'), P('Ad', 'Kc')],
    board: P('9s', '8s', '2h', 'Jc', '3d'),
    seed: 'snap-2',
    street: 'flop',
    challenge: true,
    archetype: 2,
  },
  {
    name: 'hu-turn-blank',
    holeCards: [P('Kd', 'Qd'), P('Jh', 'Th')],
    board: P('Ks', '7h', '3c', '2d', '9s'),
    seed: 'snap-3',
    street: 'turn',
    challenge: true,
    archetype: 1,
  },
  {
    name: 'hu-turn-scare',
    holeCards: [P('Ah', 'Ad'), P('Qs', 'Js')],
    board: P('Qd', '8c', '4h', 'As', '2d'),
    seed: 'snap-4',
    street: 'turn',
    challenge: true,
    archetype: 4,
  },
  {
    name: 'expert-flop',
    holeCards: [P('Ac', 'Kc'), P('9d', '9h')],
    board: P('Kd', '6h', '3s', '2c', 'Qh'),
    seed: 'snap-5',
    street: 'flop',
    challenge: false,
    archetype: 0,
  },
  {
    name: 'expert-turn',
    holeCards: [P('7s', '6s'), P('Jc', 'Jd')],
    board: P('Jh', '5d', '4c', 'Qs', '2h'),
    seed: 'snap-6',
    street: 'turn',
    challenge: false,
    archetype: 0,
  },
];

function viewOf(scenario: Scenario): PlayerView {
  let hand = makeHand({
    stacks: [1000, 1000],
    buttonIndex: 0,
    holeCards: scenario.holeCards,
    board: scenario.board,
    seed: scenario.seed,
  });
  hand = playToStreet(hand, scenario.street);
  const index = hand.actingIndex;
  if (index === null) throw new Error(`${scenario.name}: 没有行动者`);
  const view = buildPlayerView(hand, hand.players[index].id, scenario.seed);
  view.self.challengeArchetypeId = scenario.archetype;
  return view;
}

/** 单加注底池：SB 加注 60 / BB 跟注，然后过牌到指定街的指定座位行动。 */
function headsUpSpot(options: {
  hero: Card[];
  villain: Card[];
  board: Card[];
  viewer: 0 | 1;
  street: 'flop' | 'turn';
  seed: string;
}): PlayerView {
  let hand = makeHand({
    stacks: [1000, 1000],
    buttonIndex: 0,
    holeCards: options.viewer === 0 ? [options.hero, options.villain] : [options.villain, options.hero],
    board: options.board,
    seed: options.seed,
  });
  hand = playSequence(hand, [
    [0, { type: 'raise', amount: 60 }],
    [1, { type: 'call' }],
  ]);
  let guard = 0;
  while (hand.phase === 'playing' && !(hand.street === options.street && hand.actingIndex === options.viewer)) {
    if (guard++ > 12) throw new Error('推进街道失败');
    const index = hand.actingIndex;
    if (index === null) throw new Error('没有行动者');
    hand = playSequence(hand, [[index, { type: 'check' }]]);
  }
  return buildPlayerView(hand, options.viewer, options.seed);
}

function edgeOf(view: PlayerView): number {
  const ranges = buildBlueprintRangeWeights(view, { includeViewer: true });
  if (!ranges) return 0;
  let hero: unknown = null;
  let villain: unknown = null;
  for (const [playerId, weight] of ranges) {
    if (playerId === view.viewerId) hero = weight;
    else if (!villain) villain = weight;
  }
  if (!hero || !villain) return 0;
  return rangeEdgeFromRanges(view.board, hero as never, villain as never, view.self.holeCards);
}

async function decideAt(view: PlayerView, options: AIDecisionOptions) {
  return decide(view, 'expert', options);
}

describe('rangeEdgeSizeFactor：乘子与硬边界', () => {
  it('门槛内逐位不变（|edge| ≤ 0.10）', () => {
    for (const base of [0.7, 0.8, 0.85, 1, 1.1, 1.15, 1.2]) {
      for (const edge of [0, 0.05, -0.05, RANGE_EDGE_THRESHOLD, -RANGE_EDGE_THRESHOLD]) {
        expect(rangeEdgeSizeFactor(base, edge)).toBe(base);
      }
    }
    // 非有限值同样不生效（数据缺失 / NaN 时退化为中性）。
    expect(rangeEdgeSizeFactor(1, Number.NaN)).toBe(1);
  });

  it('edge = +1 上调，且不超过 +12% / 不超过 clamp 上界', () => {
    const factor = rangeEdgeSizeFactor(1, 1);
    expect(factor).toBeCloseTo(1 + RANGE_EDGE_MAX_SWING, 12);
    expect(factor).toBeLessThanOrEqual(1 + RANGE_EDGE_MAX_SWING + 1e-12);
    expect(factor).toBeLessThanOrEqual(SIZE_FACTOR_MAX);
    // 纹理层最大 1.2：连乘后仍在上界内，且涨幅仍是 12%。
    expect(rangeEdgeSizeFactor(1.2, 1)).toBeCloseTo(1.2 * (1 + RANGE_EDGE_MAX_SWING), 12);
    expect(rangeEdgeSizeFactor(1.2, 1)).toBeLessThanOrEqual(SIZE_FACTOR_MAX);
    // 越界值先被夹到 ±1。
    expect(rangeEdgeSizeFactor(1, 5)).toBe(rangeEdgeSizeFactor(1, 1));
  });

  it('edge = −1 对称下调', () => {
    const up = rangeEdgeSizeFactor(1, 1);
    const down = rangeEdgeSizeFactor(1, -1);
    expect(down).toBeCloseTo(1 - RANGE_EDGE_MAX_SWING, 12);
    expect(up - 1).toBeCloseTo(1 - down, 12); // 严格对称
    expect(rangeEdgeSizeFactor(1.2, -1)).toBeCloseTo(1.2 * (1 - RANGE_EDGE_MAX_SWING), 12);
    expect(rangeEdgeSizeFactor(1.2, -1)).toBeGreaterThanOrEqual(SIZE_FACTOR_MIN);
  });

  it('极端基值也被硬边界拦住（不会连乘失控）', () => {
    expect(rangeEdgeSizeFactor(3, 1)).toBe(SIZE_FACTOR_MAX);
    expect(rangeEdgeSizeFactor(0.2, -1)).toBe(SIZE_FACTOR_MIN);
    // 纹理层的自然取值区间 × ±12% 全部落在边界内 → clamp 对现有行为是恒等。
    for (const texture of [0.7, 0.85, 1, 1.1, 1.2]) {
      for (const edge of [1, -1]) {
        const factor = rangeEdgeSizeFactor(texture, edge);
        expect(factor).toBeGreaterThanOrEqual(SIZE_FACTOR_MIN);
        expect(factor).toBeLessThanOrEqual(SIZE_FACTOR_MAX);
        expect(factor).toBeCloseTo(texture * (1 + RANGE_EDGE_MAX_SWING * edge), 12);
      }
    }
  });

  it('范围数据缺失时返回 0（中性），不抛错', () => {
    const board = P('Ah', 'Kd', '7c');
    const fn = () => 1;
    expect(rangeEdgeFromRanges(board, null, fn)).toBe(0);
    expect(rangeEdgeFromRanges(board, fn, null)).toBe(0);
    expect(rangeEdgeFromRanges(board, null, null)).toBe(0);
    expect(rangeEdgeFromRanges(board, undefined, undefined)).toBe(0);
  });
});

describe('rangeEdge：挑战档接线', () => {
  it('rangeEdge: false 逐位复现接线前行为（黄金快照）', async () => {
    for (const scenario of SCENARIOS) {
      const view = viewOf(scenario);
      const decision = await decideAt(view, {
        challenge: scenario.challenge,
        maxIterations: 220,
        rangeEdge: false,
      });
      const golden = GOLDEN[scenario.name];
      expect(decision.action).toEqual(golden.action);
      expect(decision.debug.reasoning).toBe(golden.reasoning);
      expect(Number((decision.debug.equity ?? 0).toFixed(6))).toBe(golden.equity);
    }
  });

  it('专家档（challenge: false）开关前后逐位相同', async () => {
    for (const scenario of SCENARIOS.filter((item) => !item.challenge)) {
      const view = viewOf(scenario);
      const off = await decideAt(view, { challenge: false, maxIterations: 220, rangeEdge: false });
      const on = await decideAt(view, { challenge: false, maxIterations: 220, rangeEdge: true });
      expect(on.action).toEqual(off.action);
      expect(on.debug.reasoning).toBe(off.debug.reasoning);
    }
  });

  it('|edge| ≤ 0.10 的局面：开关前后逐位相同（不注入噪声）', async () => {
    const view = headsUpSpot({
      hero: P('Ac', 'Kc'),
      villain: P('Qh', 'Jh'),
      board: P('Ts', '9c', '8d', '2h', '3h'),
      viewer: 0,
      street: 'flop',
      seed: 'edge-neutral',
    });
    expect(Math.abs(edgeOf(view))).toBeLessThanOrEqual(RANGE_EDGE_THRESHOLD);
    const off = await decideAt(view, { challenge: true, maxIterations: 220, rangeEdge: false });
    const on = await decideAt(view, { challenge: true, maxIterations: 220 });
    expect(on.action).toEqual(off.action);
    expect(on.debug.reasoning).toBe(off.debug.reasoning);
    expect(on.debug.reasoning).not.toContain('范围优势 edge');
  });

  it('edge 明显为负时收紧尺度（范围更弱的一方不下大注）', async () => {
    const view = headsUpSpot({
      hero: P('Qh', 'Jh'),
      villain: P('Ac', 'Kc'),
      board: P('Ah', 'Kh', '2d', '7s', '3c'),
      viewer: 1, // BB：在 A-K 高面上范围明显弱于加注方
      street: 'flop',
      seed: 'edge-negative',
    });
    const edge = edgeOf(view);
    expect(edge).toBeLessThan(-RANGE_EDGE_THRESHOLD);
    const off = await decideAt(view, { challenge: true, maxIterations: 220, rangeEdge: false });
    const on = await decideAt(view, { challenge: true, maxIterations: 220 });
    expect(off.action.type).toBe('bet');
    expect(on.action.type).toBe('bet');
    expect(on.debug.reasoning).toContain('范围优势 edge');
    if (off.action.type === 'bet' && on.action.type === 'bet') {
      expect(on.action.amount!).toBeLessThan(off.action.amount!);
      // 单次最多降 12%（取整误差留 1 个筹码）。
      expect(on.action.amount!).toBeGreaterThanOrEqual(Math.floor(off.action.amount! * (1 - RANGE_EDGE_MAX_SWING)) - 1);
    }
  });

  it('edge 明显为正时只会把尺度推向上界，且不越过底池上限', async () => {
    const view = headsUpSpot({
      hero: P('Qh', 'Jh'),
      villain: P('8c', '7c'),
      board: P('Ah', 'Kh', '2d', '7s', '3c'),
      viewer: 0, // SB：A-K 高面正是加注方范围的优势面
      street: 'flop',
      seed: 'edge-positive',
    });
    const edge = edgeOf(view);
    expect(edge).toBeGreaterThan(RANGE_EDGE_THRESHOLD);
    const off = await decideAt(view, { challenge: true, maxIterations: 220, rangeEdge: false });
    const on = await decideAt(view, { challenge: true, maxIterations: 220 });
    expect(on.debug.reasoning).toContain('范围优势 edge');
    if (off.action.type === 'bet' && on.action.type === 'bet') {
      // 正向 edge 不能把下注推到超过底池（`size = min(1, …)` 是既有上限）。
      expect(on.action.amount!).toBeLessThanOrEqual(view.pot);
      expect(on.action.amount!).toBeGreaterThanOrEqual(off.action.amount!);
    }
  });

  it('多人底池（拿不到蓝图范围）不抛错，行为与关层相同', async () => {
    let hand = makeHand({
      stacks: [1000, 1000, 1000],
      buttonIndex: 0,
      holeCards: [P('As', 'Ad'), P('Kh', 'Qh'), P('8s', '8c')],
      board: P('Ah', '7c', '2d', 'Ts', '9c'),
      seed: 'edge-multiway',
    });
    hand = playToStreet(hand, 'flop');
    const index = hand.actingIndex;
    expect(index).not.toBeNull();
    const view = buildPlayerView(hand, hand.players[index!].id, 'edge-multiway');
    expect(buildBlueprintRangeWeights(view, { includeViewer: true })).toBeNull();
    const off = await decideAt(view, { challenge: true, maxIterations: 180, rangeEdge: false });
    const on = await decideAt(view, { challenge: true, maxIterations: 180 });
    expect(on.action).toEqual(off.action);
    expect(on.debug.reasoning).toBe(off.debug.reasoning);
  });
});

describe('rangeEdge：与纹理层不叠同一维度', () => {
  it('纹理层单独取值落在 [0.55, 1.65] 内，且加上范围优势后仍在内', () => {
    const boards = [
      P('Ah', '7c', '2d', 'Ts', '9c'),
      P('9s', '8s', '2h', 'Jc', '3d'),
      P('Ks', '7h', '3c', '2d', '9s'),
      P('Qd', '8c', '4h', 'As', '2d'),
    ];
    for (const board of boards) {
      const flopFactor = textureSizeFactor(boardTexture(board));
      expect(flopFactor).toBeGreaterThanOrEqual(SIZE_FACTOR_MIN);
      expect(flopFactor).toBeLessThanOrEqual(SIZE_FACTOR_MAX);
      for (const edge of [-1, RANGE_EDGE_THRESHOLD + 0.01, RANGE_EDGE_THRESHOLD * -1 - 0.01, 1]) {
        const combined = rangeEdgeSizeFactor(flopFactor, edge);
        expect(combined).toBeGreaterThanOrEqual(SIZE_FACTOR_MIN);
        expect(combined).toBeLessThanOrEqual(SIZE_FACTOR_MAX);
        // 纹理层的「干燥压小 / 湿润放大」不会被范围优势层反向吃掉。
        if (Math.abs(edge) <= RANGE_EDGE_THRESHOLD) expect(combined).toBe(flopFactor);
        else expect(Math.sign(combined - flopFactor)).toBe(Math.sign(edge));
      }
      const turnFactor = turnSizeFactor(turnTexture(board));
      expect(rangeEdgeSizeFactor(turnFactor, 1)).toBeLessThanOrEqual(SIZE_FACTOR_MAX);
      expect(rangeEdgeSizeFactor(turnFactor, -1)).toBeGreaterThanOrEqual(SIZE_FACTOR_MIN);
    }
  });
});
