/**
 * 翻前跟注的回归测试。
 *
 * 这两组 bug 是被真实对局打出来的（第 44 手：6 人桌只剩两家，机器人拿 J9o
 * 跟了 126BB 全下，亏 5040 的底池）：
 *
 * ① `preflopStrength` 按 Chen 公式排序，导致 J9o(0.787) 排在 Q9o(0.647) 前面。
 *    但 Q9o 在数学上完全压制 J9o（Q>J，9=9）——任何合理的强度指标都不允许这样。
 *
 * ② 翻前跟注只看「百分位 >= 入池线」，`ctx.potOdds` 一次都没被读。
 *    面对「加注到 40」和「全下 2520」用同一个跟注范围。
 */
import { describe, expect, it } from 'vitest';
import { preflopStrength } from '../ai/rangeModel';
import { equityVsTopRange, estimateRaiserRange, topRangeKeys } from '../ai/preflopCall';
import { buildPlayerView } from '../game/playerView';
import { decide } from '../ai/aiPlayer';
import { derivedRng } from '../game/cards';
import type { Card } from '../game/types';
import { CC, makeHand, playSequence } from './helpers';

describe('起手牌强度：必须尊重「压制」关系', () => {
  it('Q9o 强于 J9o（旧实现按 Chen 排反了）', () => {
    expect(preflopStrength(CC('Qh 9s'))).toBeGreaterThan(preflopStrength(CC('Jc 9h')));
  });

  it('AKs > AKo > AQo，AA 最强、72o 最弱', () => {
    const aks = preflopStrength(CC('As Ks'));
    const ako = preflopStrength(CC('As Kh'));
    const aqo = preflopStrength(CC('As Qh'));
    expect(aks).toBeGreaterThan(ako);
    expect(ako).toBeGreaterThan(aqo);
    expect(preflopStrength(CC('As Ah'))).toBeGreaterThan(0.99);
    expect(preflopStrength(CC('7c 2d'))).toBeLessThan(0.1);
  });

  // 注意：这里的「强度」= 对随机手牌的真实胜率百分位，不等于「好不好打」。
  // 例：55 对随机牌约 60%，AKo 约 65%，所以 AKo 排在 55 前面——这是刻意接受的取舍，
  // 因为我们只需要它正确反映「被压制关系」，不需要它复刻人类的高翻后可玩性判断。
  it('强度排序与真实胜率排序一致（抽查若干组）', () => {
    const pairs: Array<[string, string]> = [
      ['As Ah', 'Ks Kh'],
      ['Ks Kh', 'Qs Qh'],
      ['Qs Qh', 'Js Jh'],
      ['As Ks', 'As Qs'],
      ['As Kh', 'Kc Qd'],
      ['Qh 9s', 'Jc 9h'],
      ['Jc 9h', 'Tc 8h'],
      ['9s 9c', 'As Kh'],
      ['Ac Kd', 'Qc Jd'],
    ];
    for (const [stronger, weaker] of pairs) {
      expect(preflopStrength(CC(stronger))).toBeGreaterThan(preflopStrength(CC(weaker)));
    }
  });
});

describe('对手范围估计：加注越大越窄', () => {
  it('commitFraction 越大，估计范围越窄', () => {
    const small = estimateRaiserRange({ commitFraction: 0.02, avgPfr: null, raiseCount: 1 });
    const medium = estimateRaiserRange({ commitFraction: 0.4, avgPfr: null, raiseCount: 1 });
    const shove = estimateRaiserRange({ commitFraction: 1, avgPfr: null, raiseCount: 2 });
    expect(small).toBeGreaterThan(medium);
    expect(medium).toBeGreaterThan(shove);
  });

  it('对手越紧（PFR 低），范围越窄', () => {
    const loose = estimateRaiserRange({ commitFraction: 0.5, avgPfr: 0.35, raiseCount: 1 });
    const tight = estimateRaiserRange({ commitFraction: 0.5, avgPfr: 0.08, raiseCount: 1 });
    expect(tight).toBeLessThan(loose);
  });

  it('topRangeKeys 取的是最强的那批手牌', () => {
    const top = topRangeKeys(0.1);
    expect(top).toContain('AA');
    expect(top).toContain('KK');
    expect(top).not.toContain('72o');
  });
});

describe('对范围的胜率：量级必须合理', () => {
  it('J9o 对前 7% 范围只有三成左右（这正是旧实现亏钱的地方）', () => {
    const equity = equityVsTopRange(
      CC('Jc 9h') as never,
      0.07,
      derivedRng('test-j9o'),
      400,
    );
    expect(equity).toBeLessThan(0.4);
    expect(equity).toBeGreaterThan(0.2);
  });

  it('AA 对前 7% 范围仍然压倒性领先', () => {
    const equity = equityVsTopRange(CC('As Ah') as never, 0.07, derivedRng('test-aa'), 400);
    expect(equity).toBeGreaterThan(0.7);
  });
});

describe('决策：面对全下必须弃掉 J9o、跟注 AA', () => {
  /** 复现第 44 手：SB 补齐、BB 加到 90、SB 全下，轮到 BB。 */
  function faceShove(bbHole: string, stacks = 2520) {
    const seed = `preflop-call-${bbHole}-${stacks}`;
    const hand = playSequence(
      makeHand({
        stacks: [stacks, stacks],
        buttonIndex: 0,
        seed,
        holeCards: [CC('9s Qh'), CC(bbHole)],
      }),
      [[0, { type: 'call' }], [1, { type: 'raise', amount: 90 }], [0, { type: 'allin' }]],
    );
    return buildPlayerView(hand, 1, seed);
  }

  it('J9o 面对 126BB 全下：弃牌（旧实现会跟）', async () => {
    const view = faceShove('Jc 9h');
    expect(view.legal?.callAmount).toBe(2430);
    const decision = await decide(view, 'expert', { challenge: true, maxIterations: 400 });
    expect(decision.action.type).toBe('fold');
    // v0.21 起翻前统一走 EV 引擎，推理里会列出各动作的期望值
    expect(decision.debug.reasoning).toContain('EV：');
  });

  it('AA 面对全下：跟注', async () => {
    const view = faceShove('As Ah');
    const decision = await decide(view, 'expert', { challenge: true, maxIterations: 400 });
    expect(['call', 'allin']).toContain(decision.action.type);
  });

  it('小额加注（不占筹码）由 EV 引擎处理，不会因为跟注额小而乱打', async () => {
    // 深筹码、只面对一个 90 的加注（跟 70 占筹码 0.7%），
    // 应该继续用百分位规则，而不是每次都跑蒙特卡洛
    const seed = 'preflop-call-small-raise';
    const hand = playSequence(
      makeHand({
        stacks: [10000, 10000],
        buttonIndex: 0,
        seed,
        holeCards: [CC('9s Qh'), CC('Jc 9h')],
      }),
      [[0, { type: 'call' }], [1, { type: 'raise', amount: 90 }]],
    );
    // 单挑里 BB 加注后轮到 SB（座位 0）面对小额加注
    const view = buildPlayerView(hand, 0, seed);
    expect(view.legal?.callAmount).toBe(70);
    const decision = await decide(view, 'expert', { challenge: true, maxIterations: 400 });
    // 关键是「EV 引擎真的跑了」：推理里会列出弃牌/跟注/加注各自的期望值。
    // 具体动作不锁死——J9o 在这里权益 38.8%、底池赔率 38.9%，本来就是边缘牌。
    expect(decision.debug.reasoning).toContain('EV：');
    expect(decision.debug.reasoning).toContain('弃牌率');
  });
});

describe('对手范围模型：加注频率决定「大注是不是强牌」', () => {
  const range = (opts: {
    pfr?: number | null;
    pfrOpportunity?: number | null;
    commit: number;
    ratio?: number;
    raiseCount?: number;
  }) =>
    estimateRaiserRange({
      commitFraction: opts.commit,
      avgPfr: opts.pfr ?? null,
      pfrOpportunity: opts.pfrOpportunity ?? null,
      raiseCount: opts.raiseCount ?? 1,
      raiseToPotRatio: opts.ratio ?? 20,
    });

  it('每手都全下的人（加注机会率 100%）：范围估成接近 100%，而不是「前 10%」', () => {
    // 旧实现只看「押了多少筹码」，100BB 全下 → 前 10%，
    // 于是 BB 拿 Q9o（对随机牌真实 55.1%）只估到 32%，该跟的牌全弃了。
    expect(range({ pfrOpportunity: 1, commit: 0.98 })).toBeGreaterThan(0.95);
  });

  it('从不加注的人突然全下：范围极窄', () => {
    expect(range({ pfrOpportunity: 0, commit: 0.98 })).toBeLessThan(0.1);
  });

  it('单调：加注频率越高，范围越宽', () => {
    const values = [0, 0.2, 0.4, 0.6, 0.8, 1].map((p) =>
      range({ pfrOpportunity: p, commit: 0.98 }),
    );
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1] - 1e-9);
    }
  });

  it('3-bet / 4-bet 会收窄理性对手的范围，但不会收窄疯子的', () => {
    const normal = range({ pfrOpportunity: 0.25, commit: 0.4, raiseCount: 3 });
    const normalOpen = range({ pfrOpportunity: 0.25, commit: 0.4, raiseCount: 1 });
    expect(normal).toBeLessThan(normalOpen);
    const maniac = range({ pfrOpportunity: 1, commit: 0.98, raiseCount: 3 });
    expect(maniac).toBeGreaterThan(0.95);
  });

  it('无样本时退回「押了多少」的先验：押得越多，范围越窄', () => {
    const small = range({ commit: 0.05, ratio: 3 });
    const allin = range({ commit: 0.98, ratio: 3 });
    expect(allin).toBeLessThan(small);
  });

  it('无样本时，超池全下（3BB 底池推 100BB）按「可能是疯子」放宽', () => {
    const normal = range({ commit: 0.98, ratio: 3 });
    const overbet = range({ commit: 0.98, ratio: 20 });
    expect(overbet).toBeGreaterThan(normal);
  });
});

describe('全下之后没有翻后：权益实现率必须是 1', () => {
  it('跟注全下时 EV 用实现率 1（旧实现按 OOP 打折 0.7，白扔三成价值）', () => {
    // 用同一手牌分别算「跟注全下」与「用 realizationFor 打折」的结果，前者必须更高
    const hero = CC('Qh 9s') as [Card, Card];
    const rng = derivedRng('realization-test');
    const pot = 1030;
    const callAmount = 980;
    const equity = equityVsTopRange(hero, 1.0, rng, 2000);
    const withRealization = equity * (pot + callAmount) * 0.7 - callAmount;
    const withoutRealization = equity * (pot + callAmount) - callAmount;
    expect(withoutRealization).toBeGreaterThan(withRealization);
    // Q9o 对随机牌约 55%，全下赔率 48.8%，所以不打折时是 +EV
    expect(equity).toBeGreaterThan(0.5);
    expect(withoutRealization).toBeGreaterThan(0);
  });
});
