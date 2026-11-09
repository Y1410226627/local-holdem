import { describe, expect, it } from 'vitest';
import type { Card, Rank, Suit } from '../game/types';
import { TURN_NEUTRAL, turnBarrelTendency, turnSizeFactor, turnTexture } from '../ai/turnTexture';

const c = (rank: Rank, suit: Suit): Card => ({ rank, suit });

describe('turnTexture：转牌是空白牌还是吓人的牌', () => {
  it('空白牌：低、不配对、不成花、不连张、非高张', () => {
    const t = turnTexture([c(14, 's'), c(10, 'h'), c(6, 'd'), c(3, 'c')]);
    expect(t.blank).toBe(true);
    expect(t.scare).toBe(0);
    expect(turnBarrelTendency(t)).toBeGreaterThan(0.3);
  });

  it('第四张同花 = 最吓人，二次开火直接关闭', () => {
    const t = turnTexture([c(9, 's'), c(7, 's'), c(2, 's'), c(4, 's')]);
    expect(t.flushComplete).toBe(true);
    expect(t.blank).toBe(false);
    expect(t.scare).toBeGreaterThanOrEqual(0.5);
    expect(turnBarrelTendency(t)).toBe(0);
  });

  it('高张 overcard 会抬高吓人度', () => {
    const t = turnTexture([c(9, 's'), c(7, 'h'), c(2, 'd'), c(14, 'c')]);
    expect(t.overcard).toBe(true);
    expect(t.scare).toBeGreaterThanOrEqual(0.25);
  });

  it('转牌成对会抬高吓人度', () => {
    const t = turnTexture([c(9, 's'), c(7, 'h'), c(2, 'd'), c(9, 'c')]);
    expect(t.paired).toBe(true);
    expect(t.scare).toBeGreaterThan(0);
  });

  it('尺度：空白牌缩小、极吓人牌放大', () => {
    const blank = turnTexture([c(14, 's'), c(10, 'h'), c(6, 'd'), c(3, 'c')]);
    const scary = turnTexture([c(9, 's'), c(7, 's'), c(2, 's'), c(4, 's')]);
    expect(turnSizeFactor(blank)).toBeLessThan(1);
    expect(turnSizeFactor(scary)).toBeGreaterThan(1);
  });

  it('牌面不足四张时返回中性值，调用方据此跳过调整', () => {
    expect(turnTexture([c(14, 's'), c(9, 'h'), c(2, 'd')])).toEqual(TURN_NEUTRAL);
    expect(turnSizeFactor(TURN_NEUTRAL)).toBe(1);
  });
});
