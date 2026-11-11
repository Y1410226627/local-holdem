import { describe, expect, it } from 'vitest';
import { foldEquityFor } from '../ai/preflopEv';

describe('翻前 EV：弃牌率（多人池修复，v0.26）', () => {
  it('单挑保持旧口径', () => {
    expect(foldEquityFor(0, 1, null)).toBeCloseTo(0.55, 5);
    expect(foldEquityFor(1, 1, null)).toBeCloseTo(0.45, 5);
    expect(foldEquityFor(2, 1, null)).toBeCloseTo(0.3, 5);
    expect(foldEquityFor(2, 1, 0.4, 1)).toBeCloseTo(0.39, 5);
  });

  it('面对加注后的多人池，所有人弃牌率随对手数下降', () => {
    const one = foldEquityFor(2, 1, null);
    const two = foldEquityFor(2, 2, null);
    const three = foldEquityFor(2, 3, null);
    expect(one).toBeGreaterThan(two);
    expect(two).toBeGreaterThan(three);
    expect(three).toBeLessThan(0.12);
  });

  it('多人池实测弃牌率按独立弃牌合成，而不是直接使用平均值', () => {
    // foldToBet=0.5、置信度 1、3 个对手：应接近 0.5^3 = 0.125，而不是 0.5。
    const fe = foldEquityFor(1, 3, 0.5, 1);
    expect(fe).toBeLessThan(0.2);
    expect(fe).toBeGreaterThan(0.05);
  });

  it('开池（raiseCount=0）的 6 人桌先验不被破坏', () => {
    expect(foldEquityFor(0, 6, null)).toBeCloseTo(0.3, 5);
  });
});
