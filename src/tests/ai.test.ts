import { describe, expect, it } from 'vitest';
import { buildPlayerView, type PlayerView } from '../game/playerView';
import { getLegalActions, validateAction } from '../game/betting';
import { playAction } from '../game/gameEngine';
import { hashString, mulberry32 } from '../game/cards';
import type { Card, Difficulty, HandState, PlayerAction } from '../game/types';
import { decide, type AIDecision } from '../ai/aiPlayer';
import { DIFFICULTY_PROFILES, profileSignature } from '../ai/difficulty';
import { estimateEquity } from '../ai/equity';
import {
  analyzePostflop,
  handKey,
  positionOf,
  preflopClasses,
  preflopStrength,
  preflopStrengthOf,
  preflopThresholds,
  type Position,
} from '../ai/rangeModel';
import { CC, makeHand, playSequence, playToStreet } from './helpers';

const DIFFS: Difficulty[] = ['beginner', 'normal', 'hard', 'expert'];

const CHINESE = /[\u4e00-\u9fff]/;

function actingView(hand: HandState, seed: string): PlayerView {
  const acting = hand.actingIndex;
  if (acting === null) throw new Error('当前没有行动玩家');
  return buildPlayerView(hand, hand.players[acting].id, seed);
}

function expectLegal(hand: HandState, action: PlayerAction): void {
  const acting = hand.actingIndex;
  expect(acting).not.toBeNull();
  if (acting === null) throw new Error('当前没有行动玩家');
  expect(() => validateAction(hand, acting, action)).not.toThrow();
}

/**
 * 随机翻牌后局面：
 * - mode 0：翻牌后第一个行动者（通常无人下注）；
 * - mode 1：先下注，再轮到下一个行动者（面对下注）；
 * - mode 2：下注 + 跟注后再取行动者（多人底池 / 转牌）。
 */
function randomPostflopSituation(seed: string): { hand: HandState; view: PlayerView } {
  const rand = mulberry32(hashString(seed));
  const playerCount = 3 + Math.floor(rand() * 4); // 3-6 人
  const buttonIndex = Math.floor(rand() * playerCount);
  const stacks = Array.from({ length: playerCount }, () => 500 + Math.floor(rand() * 1000));
  let hand = makeHand({ stacks, buttonIndex, seed });
  hand = playToStreet(hand, 'flop');

  const placeBet = (): void => {
    const index = hand.actingIndex;
    if (index === null) return;
    const legal = getLegalActions(hand, index);
    if (!legal.canBet) return;
    const amount = Math.min(
      legal.maxRaiseTo,
      Math.max(legal.minRaiseTo, Math.round(hand.pot * 0.5)),
    );
    if (!Number.isInteger(amount) || amount < legal.minRaiseTo) return;
    hand = playAction(hand, index, { type: 'bet', amount });
  };
  const placeCall = (): void => {
    const index = hand.actingIndex;
    if (index === null) return;
    const legal = getLegalActions(hand, index);
    if (legal.canCall) hand = playAction(hand, index, { type: 'call' });
  };

  const mode = Math.floor(rand() * 3);
  if (mode >= 1) placeBet();
  if (mode === 2) placeCall();

  if (hand.phase !== 'playing' || hand.actingIndex === null) {
    throw new Error(`无法构造翻牌后局面：${seed}`);
  }
  return { hand, view: actingView(hand, seed) };
}

/** 同一公共状态下的两副牌：仅对手底牌不同，用于防作弊测试。 */
function antiCheatHand(opponents: readonly string[]): HandState {
  return makeHand({
    stacks: [1000, 1000, 1000, 1000],
    buttonIndex: 3,
    holeCards: [CC('Ah Kh'), ...opponents.map((cards) => CC(cards))],
    board: CC('Qh 9d 4c 2s 7h'),
    seed: 'anti-cheat-seed',
  });
}

/** 强牌（AA）与垃圾牌（72o）在同一翻牌面、同一行动线下的对照视图。 */
function strengthComparisonView(hero: string): PlayerView {
  let hand = makeHand({
    stacks: [1000, 1000, 1000, 1000],
    buttonIndex: 3,
    holeCards: [CC(hero), CC('Tc 8c'), CC('5h 6h'), CC('Qd 9d')],
    board: CC('Kh Jd 9c 4s 3d'),
    seed: 'sanity',
  });
  hand = playToStreet(hand, 'flop');
  hand = playSequence(hand, [
    [0, { type: 'check' }],
    [1, { type: 'bet', amount: 60 }],
    [2, { type: 'fold' }],
    [3, { type: 'fold' }],
  ]);
  return actingView(hand, 'sanity');
}

describe('AI：合法动作与随机局面', () => {
  it('四种难度在 50 个随机翻牌后局面都返回合法动作', async () => {
    let facingBet = 0;
    for (let i = 0; i < 50; i++) {
      const { hand, view } = randomPostflopSituation(`ai-fuzz-${i}`);
      expect(view.legal).not.toBeNull();
      if (view.legal!.currentBet > 0) facingBet++;
      for (const difficulty of DIFFS) {
        const decision = await decide(view, difficulty, { maxIterations: 200 });
        expect(decision.debug.difficulty).toBe(difficulty);
        expect(decision.debug.reasoning.length).toBeGreaterThan(0);
        expectLegal(hand, decision.action);
      }
    }
    // 确保覆盖了“面对下注”的分支，而不是只测了无人下注。
    expect(facingBet).toBeGreaterThan(10);
  });
});

describe('AI：防作弊与确定性', () => {
  it('公共状态相同、仅对手底牌不同 → 四档决策与 debug 完全一致', async () => {
    const handA = playToStreet(
      antiCheatHand(['2c 3c', '4d 5d', '6h 7c']),
      'flop',
    );
    const handB = playToStreet(
      antiCheatHand(['8c 9c', 'Td Jd', 'Qs Ks']),
      'flop',
    );
    const viewA = buildPlayerView(handA, 0, 'anti-cheat-seed');
    const viewB = buildPlayerView(handB, 0, 'anti-cheat-seed');
    expect(viewA.actingIndex).toBe(0);
    expect(JSON.stringify(viewA)).toBe(JSON.stringify(viewB));

    for (const difficulty of DIFFS) {
      const decisionA = await decide(viewA, difficulty, { maxIterations: 200 });
      const decisionB = await decide(viewB, difficulty, { maxIterations: 200 });
      expect(JSON.stringify(decisionA)).toBe(JSON.stringify(decisionB));
    }
  });

  it('同一 view + 难度连续两次 decide 结果相同', async () => {
    const { view } = randomPostflopSituation('ai-determinism');
    for (const difficulty of ['hard', 'expert'] as Difficulty[]) {
      const first = await decide(view, difficulty, { maxIterations: 120 });
      const second = await decide(view, difficulty, { maxIterations: 120 });
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    }
  });

  it('view.legal 为 null 时抛出中文错误', async () => {
    const hand = makeHand();
    const view = buildPlayerView(hand, 0, 'not-acting');
    expect(view.legal).toBeNull();
    await expect(decide(view, 'normal')).rejects.toThrow('当前不是该玩家的行动回合');
  });
});

describe('AI：蒙特卡洛胜率估算', () => {
  it('AA 单挑翻牌前 > 0.78，72o < 0.42，皇家同花顺 ≈ 1，且同 seed 确定', async () => {
    const aaView = buildPlayerView(
      makeHand({ stacks: [1000, 1000], holeCards: [CC('As Ah')], seed: 'eq-aa' }),
      0,
      'eq-aa',
    );
    const aa = await estimateEquity(aaView, 4000, mulberry32(aaView.seed));
    expect(aa.iterations).toBe(4000);
    expect(aa.equity).toBeGreaterThan(0.78);
    const aaAgain = await estimateEquity(aaView, 4000, mulberry32(aaView.seed));
    expect(aaAgain).toEqual(aa);

    const trashView = buildPlayerView(
      makeHand({ stacks: [1000, 1000], holeCards: [CC('7s 2h')], seed: 'eq-72' }),
      0,
      'eq-72',
    );
    const trash = await estimateEquity(trashView, 4000, mulberry32(trashView.seed));
    expect(trash.equity).toBeLessThan(0.42);

    const royalHand = playToStreet(
      makeHand({
        stacks: [1000, 1000],
        holeCards: [CC('Ah Kh'), CC('6s 7s')],
        board: CC('Qh Jh Th 2c 3d'),
        seed: 'eq-royal',
      }),
      'river',
    );
    const royalView = buildPlayerView(royalHand, 0, 'eq-royal');
    expect(royalView.board).toHaveLength(5);
    const royal = await estimateEquity(royalView, 2000, mulberry32(royalView.seed));
    expect(royal.equity).toBeGreaterThan(0.99);
  });

  it('范围权重会收窄对手底牌：面对强范围时 QQ 的胜率明显更低', async () => {
    const qqView = buildPlayerView(
      makeHand({ stacks: [1000, 1000], holeCards: [CC('Qs Qh')], seed: 'range-eq' }),
      0,
      'range-eq',
    );
    const randomEq = await estimateEquity(qqView, 2000, mulberry32(qqView.seed));
    const strongRange = (first: Card, second: Card) =>
      preflopStrengthOf(first, second) >= 0.88 ? 1 : 0.02;
    const strongEq = await estimateEquity(qqView, 2000, mulberry32(qqView.seed), {
      ranges: [strongRange],
      maxRangeAttempts: 24,
    });
    expect(strongEq.equity).toBeLessThan(randomEq.equity - 0.1);
  });
});

describe('AI：四档行为差异', () => {
  it('300 个随机翻牌前局面：四档的弃牌 / 跟注 / 加注率明显不同', async () => {
    interface Rate {
      fold: number;
      call: number;
      raise: number;
      check: number;
      total: number;
    }
    const rates: Record<Difficulty, Rate> = {
      beginner: { fold: 0, call: 0, raise: 0, check: 0, total: 0 },
      normal: { fold: 0, call: 0, raise: 0, check: 0, total: 0 },
      hard: { fold: 0, call: 0, raise: 0, check: 0, total: 0 },
      expert: { fold: 0, call: 0, raise: 0, check: 0, total: 0 },
    };

    for (let i = 0; i < 300; i++) {
      const seed = `ai-preflop-${i}`;
      const rand = mulberry32(hashString(seed));
      const playerCount = 3 + Math.floor(rand() * 4);
      const buttonIndex = Math.floor(rand() * playerCount);
      const hand = makeHand({
        stacks: Array.from({ length: playerCount }, () => 1000),
        buttonIndex,
        seed,
      });
      const acting = hand.actingIndex;
      expect(acting).not.toBeNull();
      if (acting === null) throw new Error('当前没有行动玩家');
      const view = buildPlayerView(hand, hand.players[acting].id, seed);
      expect(view.street).toBe('preflop');

      for (const difficulty of DIFFS) {
        const decision = await decide(view, difficulty);
        const rate = rates[difficulty];
        rate.total++;
        switch (decision.action.type) {
          case 'fold':
            rate.fold++;
            break;
          case 'call':
            rate.call++;
            break;
          case 'raise':
          case 'bet':
          case 'allin':
            rate.raise++;
            break;
          default:
            rate.check++;
            break;
        }
      }
    }

    const rateOf = (difficulty: Difficulty, key: keyof Rate): number => {
      const value = rates[difficulty];
      return value[key] / value.total;
    };

    // beginner 松被动：弃牌最少、跟注最多、加注最少。
    expect(rateOf('beginner', 'fold')).toBeLessThan(0.2);
    expect(rateOf('expert', 'fold')).toBeGreaterThan(0.22);
    expect(rateOf('expert', 'raise')).toBeGreaterThan(rateOf('beginner', 'raise'));
    expect(rateOf('beginner', 'call')).toBeGreaterThan(rateOf('normal', 'call'));
    // expert 整体最紧，normal 比 beginner 更愿意弃牌。
    expect(rateOf('normal', 'fold')).toBeGreaterThan(rateOf('beginner', 'fold'));
    expect(rateOf('expert', 'fold')).toBeGreaterThanOrEqual(rateOf('normal', 'fold'));
  });
});

describe('AI：debug 信息与非法动作防护', () => {
  it('hard / expert 含 equity 与 iterations；beginner / normal 有中文 reasoning', async () => {
    const { hand, view } = randomPostflopSituation('ai-debug');
    expect(view.legal).not.toBeNull();

    for (const difficulty of ['hard', 'expert'] as Difficulty[]) {
      const decision = await decide(view, difficulty, { maxIterations: 300 });
      expect(typeof decision.debug.equity).toBe('number');
      expect(decision.debug.equity!).toBeGreaterThanOrEqual(0);
      expect(decision.debug.equity!).toBeLessThanOrEqual(1);
      expect(decision.debug.iterations).toBeGreaterThan(0);
      expect(decision.debug.iterations).toBeLessThanOrEqual(300);
      expect(decision.debug.handCategory).toBeTruthy();
      expect(CHINESE.test(decision.debug.reasoning)).toBe(true);
      expect(CHINESE.test(decision.debug.profile)).toBe(true);
      expectLegal(hand, decision.action);
    }

    for (const difficulty of ['beginner', 'normal'] as Difficulty[]) {
      const decision = await decide(view, difficulty);
      expect(CHINESE.test(decision.debug.reasoning)).toBe(true);
      expect(CHINESE.test(decision.debug.profile)).toBe(true);
      expect(decision.debug.handCategory).toBeTruthy();
      expectLegal(hand, decision.action);
    }
  });

  it('被 short all-in 关闭加注权时不返回 raise / bet', async () => {
    // 翻牌前：BB 只有 35，short all-in 到 35，已行动的 UTG 只能跟注 / 弃牌。
    let preflop = makeHand({ stacks: [1000, 1000, 35, 1000] });
    preflop = playSequence(preflop, [
      [3, { type: 'call' }],
      [0, { type: 'call' }],
      [1, { type: 'call' }],
      [2, { type: 'allin' }],
    ]);
    expect(preflop.actingIndex).toBe(3);
    const preflopView = actingView(preflop, 'short-preflop');
    expect(preflopView.legal!.canRaise).toBe(false);
    expect(preflopView.legal!.aggressiveType).toBeNull();

    for (const difficulty of DIFFS) {
      const decision = await decide(preflopView, difficulty, { maxIterations: 100 });
      expect(decision.action.type).not.toBe('raise');
      expect(decision.action.type).not.toBe('bet');
      expectLegal(preflop, decision.action);
    }

    // 翻牌后：P1 下注 100，P2 short all-in 到 180，P3/P0 跟注后回到 P1。
    let postflop = playToStreet(makeHand({ stacks: [1000, 1000, 200, 1000] }), 'flop');
    postflop = playAction(postflop, 1, { type: 'bet', amount: 100 });
    postflop = playAction(postflop, 2, { type: 'allin' });
    postflop = playAction(postflop, 3, { type: 'call' });
    postflop = playAction(postflop, 0, { type: 'call' });
    expect(postflop.actingIndex).toBe(1);
    const postflopView = actingView(postflop, 'short-postflop');
    expect(postflopView.legal!.canRaise).toBe(false);
    expect(postflopView.legal!.aggressiveType).toBeNull();

    for (const difficulty of DIFFS) {
      const decision = await decide(postflopView, difficulty, { maxIterations: 100 });
      expect(decision.action.type).not.toBe('raise');
      expect(decision.action.type).not.toBe('bet');
      expectLegal(postflop, decision.action);
    }
  });

  it('下注金额为整数，且在 [minRaiseTo, maxRaiseTo] 内（短全下允许等于 maxRaiseTo）', async () => {
    let aggressiveCount = 0;
    for (let i = 0; i < 40; i++) {
      const { hand, view } = randomPostflopSituation(`ai-amount-${i}`);
      expect(view.legal).not.toBeNull();
      for (const difficulty of DIFFS) {
        const decision = await decide(view, difficulty, { maxIterations: 120 });
        expectLegal(hand, decision.action);
        const legal = view.legal!;
        if (decision.action.type === 'bet' || decision.action.type === 'raise') {
          aggressiveCount++;
          expect(Number.isInteger(decision.action.amount)).toBe(true);
          expect(decision.action.amount).toBeLessThanOrEqual(legal.maxRaiseTo);
          if (decision.action.amount < legal.minRaiseTo) {
            // 唯一允许低于最小加注额的情况：短全下到 maxRaiseTo。
            expect(decision.action.amount).toBe(legal.maxRaiseTo);
          }
          expect(decision.action.type).toBe(legal.currentBet === 0 ? 'bet' : 'raise');
        }
      }
    }
    expect(aggressiveCount).toBeGreaterThan(0);
  });
});

describe('AI：牌力与继续意愿', () => {
  it('强牌（AA）比垃圾牌（72o）在同一局面下胜率更高、更愿意继续', async () => {
    const strongView = strengthComparisonView('As Ah');
    const weakView = strengthComparisonView('7s 2h');
    expect(strongView.legal).not.toBeNull();
    expect(weakView.legal).not.toBeNull();

    const strongEquity = await estimateEquity(strongView, 3000, mulberry32(strongView.seed));
    const weakEquity = await estimateEquity(weakView, 3000, mulberry32(weakView.seed));
    expect(strongEquity.equity).toBeGreaterThan(weakEquity.equity + 0.2);

    const strongAnalysis = analyzePostflop(strongView.self.holeCards, strongView.board);
    const weakAnalysis = analyzePostflop(weakView.self.holeCards, weakView.board);
    expect(strongAnalysis.strength).toBeGreaterThan(weakAnalysis.strength);

    for (const difficulty of DIFFS) {
      const strongDecision = await decide(strongView, difficulty, { maxIterations: 300 });
      const weakDecision = await decide(weakView, difficulty, { maxIterations: 300 });
      expect(strongDecision.action.type).not.toBe('fold');
      expect(weakDecision.action.type).toBe('fold');
    }
  });
});

describe('AI：范围模型与难度 profile', () => {
  it('起手牌强度与位置阈值合理', () => {
    const aa = preflopStrength(CC('As Ah'));
    const aks = preflopStrength(CC('As Ks'));
    const trash = preflopStrength(CC('7s 2h'));
    expect(aa).toBeGreaterThan(0.9);
    expect(aa).toBeGreaterThan(aks);
    expect(aks).toBeGreaterThan(trash);
    expect(trash).toBeLessThan(0.1);

    expect(handKey(CC('As Ks'))).toBe('AKs');
    expect(handKey(CC('Kh As'))).toBe('AKo');
    expect(handKey(CC('Qs Qh'))).toBe('QQ');
    expect(handKey(CC('7s 2h'))).toBe('72o');
    expect(preflopClasses()).toHaveLength(169);

    const early = preflopThresholds('normal', 'early');
    const late = preflopThresholds('normal', 'late');
    expect(late.play).toBeLessThan(early.play);
    expect(late.raise).toBeLessThan(early.raise);
    expect(late.threeBet).toBeLessThan(early.threeBet);

    for (const difficulty of ['normal', 'hard', 'expert'] as Difficulty[]) {
      const e = preflopThresholds(difficulty, 'early');
      const l = preflopThresholds(difficulty, 'late');
      expect(l.play).toBeLessThan(e.play);
    }

    // beginner 不感知位置：早位与晚位阈值相同。
    expect(preflopThresholds('beginner', 'early')).toEqual(
      preflopThresholds('beginner', 'late'),
    );

    // 位置推导：4 人桌按钮 0 → 玩家 3 是 UTG 早位，1/2 是盲注位。
    const hand = makeHand({ stacks: [1000, 1000, 1000, 1000], buttonIndex: 0 });
    const positionOfViewer = (viewerId: number): Position =>
      positionOf(buildPlayerView(hand, viewerId, 'position'));
    expect(positionOfViewer(3)).toBe('early');
    expect(positionOfViewer(0)).toBe('late');
    expect(positionOfViewer(1)).toBe('blinds');
    expect(positionOfViewer(2)).toBe('blinds');
  });

  it('四档 profile 参数确实不同，不是同一逻辑换参数', () => {
    const p = DIFFICULTY_PROFILES;
    expect(p.beginner.postflop.mcIterations).toBe(0);
    expect(p.normal.postflop.mcIterations).toBe(0);
    expect(p.hard.postflop.mcIterations).toBeGreaterThanOrEqual(5000);
    expect(p.hard.postflop.mcIterations).toBeLessThanOrEqual(10000);
    expect(p.expert.postflop.mcIterations).toBeGreaterThanOrEqual(20000);

    expect(p.beginner.postflop.bluffRate).toBeLessThan(p.normal.postflop.bluffRate);
    expect(p.normal.postflop.bluffRate).toBeLessThan(p.hard.postflop.bluffRate);
    expect(p.hard.postflop.bluffRate).toBeLessThan(p.expert.postflop.bluffRate);

    expect(p.expert.postflop.betSizes.length).toBeGreaterThanOrEqual(4);
    expect(p.hard.postflop.betSizes.length).toBeGreaterThan(p.normal.postflop.betSizes.length);
    expect(p.beginner.postflop.betSizes.length).toBeLessThan(p.normal.postflop.betSizes.length);

    expect(p.beginner.preflop.positionAware).toBe(false);
    expect(p.normal.preflop.positionAware).toBe(true);
    expect(p.expert.preflop.positionAware).toBe(true);

    const styles = DIFFS.map((difficulty) => p[difficulty].style);
    expect(new Set(styles).size).toBe(4);
    const signatures = DIFFS.map((difficulty) => profileSignature(p[difficulty]));
    expect(new Set(signatures).size).toBe(4);
    expect(styles.every((style) => CHINESE.test(style))).toBe(true);
  });
});
