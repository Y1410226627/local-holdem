import { describe, expect, it } from 'vitest';
import type { Card, Rank, Suit } from '../game/types';
import { boardTexture, rangeBetTendency, textureSizeFactor } from '../ai/flopTexture';

const c = (rank: Rank, suit: Suit): Card => ({ rank, suit });

describe('boardTexture：牌面纹理', () => {
  it('彩虹不连的 A 高面 = 极干', () => {
    const t = boardTexture([c(14, 's'), c(7, 'h'), c(2, 'd')]);
    expect(t.monotone).toBe(false);
    expect(t.twoTone).toBe(false);
    expect(t.connected).toBe(false);
    expect(t.paired).toBe(false);
    expect(t.wetness).toBeLessThan(0.3);
    expect(textureSizeFactor(t)).toBeLessThan(1);
  });

  it('三张同花 + 连张 = 极湿', () => {
    const t = boardTexture([c(9, 's'), c(8, 's'), c(7, 's')]);
    expect(t.monotone).toBe(true);
    expect(t.connected).toBe(true);
    expect(t.wetness).toBeGreaterThan(0.7);
    expect(textureSizeFactor(t)).toBeGreaterThan(1);
  });

  it('成对面会降低湿润度（双方范围都收窄）', () => {
    const paired = boardTexture([c(10, 's'), c(10, 'h'), c(3, 'd')]);
    const unpaired = boardTexture([c(10, 's'), c(9, 'h'), c(8, 'd')]);
    expect(paired.paired).toBe(true);
    expect(unpaired.connected).toBe(true);
    expect(paired.wetness).toBeLessThan(unpaired.wetness);
    expect(rangeBetTendency(paired)).toBeLessThan(0.2);
  });

  it('两张同花比彩虹更湿，但不如三张同花', () => {
    const rainbow = boardTexture([c(13, 's'), c(8, 'h'), c(2, 'd')]);
    const two = boardTexture([c(13, 's'), c(8, 's'), c(2, 'd')]);
    const mono = boardTexture([c(13, 's'), c(8, 's'), c(2, 's')]);
    expect(two.wetness).toBeGreaterThan(rainbow.wetness);
    expect(mono.wetness).toBeGreaterThan(two.wetness);
  });

  it('牌面不足三张时返回中性值，调用方据此跳过调整', () => {
    expect(boardTexture([])).toEqual(boardTexture([c(14, 's')]));
    expect(boardTexture([]).wetness).toBe(0.5);
    expect(textureSizeFactor(boardTexture([]))).toBe(1);
  });

  it('范围下注倾向：干燥面最高，同花面为 0（不能用小尺度范围下注）', () => {
    expect(rangeBetTendency(boardTexture([c(14, 's'), c(7, 'h'), c(2, 'd')]))).toBeGreaterThan(0.3);
    expect(rangeBetTendency(boardTexture([c(9, 's'), c(8, 's'), c(7, 's')]))).toBe(0);
  });
});
