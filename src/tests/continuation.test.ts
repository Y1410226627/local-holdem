import { describe, expect, it } from 'vitest';
import { continuationValue } from '../ai/continuation';

describe('B3 continuation value（叶节点未来街价值）', () => {
  const base = { street: 'turn' as const, equity: 0.8, pot: 100, effectiveStack: 300, opponentCount: 1 };

  it('强牌为正、弱牌为负', () => {
    expect(continuationValue(base)).toBeGreaterThan(0);
    expect(continuationValue({ ...base, equity: 0.2 })).toBeLessThan(0);
    expect(continuationValue({ ...base, equity: 0.5 })).toBe(0);
  });

  it('河牌几乎无后续价值；多人底池打折', () => {
    expect(Math.abs(continuationValue({ ...base, street: 'river' }))).toBeLessThan(
      Math.abs(continuationValue(base)),
    );
    expect(continuationValue({ ...base, opponentCount: 3 })).toBeLessThan(continuationValue(base));
  });

  it('SPR 越高、剩余街越多，未来价值越大', () => {
    expect(continuationValue({ ...base, effectiveStack: 600 })).toBeGreaterThan(
      continuationValue({ ...base, effectiveStack: 100 }),
    );
  });
});
