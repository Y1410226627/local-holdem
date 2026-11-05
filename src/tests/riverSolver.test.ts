import { describe, expect, it } from 'vitest';
import { buildPlayerView } from '../game/playerView';
import { playToStreet } from './helpers';
import { solveRiverEndgame } from '../ai/riverSolver';
import { CC, makeHand } from './helpers';

function riverView(seed: string) {
  const hand = playToStreet(
    makeHand({
      seed,
      holeCards: [CC('As Kd'), CC('Qh Jh'), CC('9s 9c'), CC('7c 2d')],
      board: CC('2h 5s 9d Tc 3c'),
    }),
    'river',
  );
  const index = hand.actingIndex!;
  return buildPlayerView(hand, hand.players[index].id, seed);
}

describe('河牌 endgame CFR 求解器（B2）', () => {
  it('河牌局面返回合法频率，且频率归一化', () => {
    const result = solveRiverEndgame(riverView('river-solver-a'), { iterations: 80, maxCombos: 8 });
    expect(result).not.toBeNull();
    const frequencies = Object.values(result!.frequencies);
    expect(frequencies.length).toBeGreaterThan(0);
    for (const value of frequencies) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    const total = frequencies.reduce((sum, value) => sum + value, 0);
    expect(total).toBeGreaterThan(0.95);
    expect(total).toBeLessThan(1.05);
  });

  it('相同输入求解完全可复现', () => {
    const view = riverView('river-solver-repro');
    const first = solveRiverEndgame(view, { iterations: 60, maxCombos: 6 });
    const second = solveRiverEndgame(view, { iterations: 60, maxCombos: 6 });
    expect(second!.frequencies).toEqual(first!.frequencies);
  });

  it('面对下注模式输出跟注/弃牌频率，非河牌返回 null', () => {
    const view = riverView('river-solver-call');
    const result = solveRiverEndgame(view, { mode: 'call', iterations: 60, maxCombos: 6 });
    expect(result).not.toBeNull();
    expect(result!.mode).toBe('call');
    expect(result!.frequencies.call + result!.frequencies.fold).toBeCloseTo(1, 5);
    const preflopHand = makeHand({ seed: 'river-solver-preflop' });
    const preflopView = buildPlayerView(preflopHand, preflopHand.players[preflopHand.actingIndex!].id, 'x');
    expect(solveRiverEndgame(preflopView)).toBeNull();
  });
});
