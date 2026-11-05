/**
 * B1：离线 GTO push/fold 查表测试。
 * 校验表完整性、精确/插值查表、越界回退，以及短码建议优先使用查表结果。
 */
import { describe, expect, it } from 'vitest';
import {
  GTO_PUSH_FOLD_TABLE,
  lookupPushFoldChart,
} from '../ai/gtoTable';
import { gtoPushFoldAdvice } from '../ai/gtoAdvice';
import { buildPlayerView } from '../game/playerView';
import { CC, makeHand } from './helpers';

describe('GTO push/fold 查表（B1）', () => {
  it('表包含 4–20BB 共 17 个深度，10 个强度桶', () => {
    expect(GTO_PUSH_FOLD_TABLE.stackMinBB).toBe(4);
    expect(GTO_PUSH_FOLD_TABLE.stackMaxBB).toBe(20);
    expect(GTO_PUSH_FOLD_TABLE.entries).toHaveLength(17);
    expect(GTO_PUSH_FOLD_TABLE.buckets).toBe(10);
    expect(GTO_PUSH_FOLD_TABLE.boundaries).toHaveLength(9);
  });

  it('每个深度的频率合法且随牌力单调不减', () => {
    for (const entry of GTO_PUSH_FOLD_TABLE.entries) {
      expect(entry.sbPushFrequency).toHaveLength(10);
      expect(entry.bbCallFrequency).toHaveLength(10);
      for (let index = 0; index < 10; index++) {
        expect(entry.sbPushFrequency[index]).toBeGreaterThanOrEqual(0);
        expect(entry.sbPushFrequency[index]).toBeLessThanOrEqual(1);
        expect(entry.bbCallFrequency[index]).toBeGreaterThanOrEqual(0);
        expect(entry.bbCallFrequency[index]).toBeLessThanOrEqual(1);
        if (index > 0) {
          expect(entry.sbPushFrequency[index]).toBeGreaterThanOrEqual(entry.sbPushFrequency[index - 1]);
          expect(entry.bbCallFrequency[index]).toBeGreaterThanOrEqual(entry.bbCallFrequency[index - 1]);
        }
      }
    }
  });

  it('表内深度精确命中，表外深度返回 null', () => {
    const exact = lookupPushFoldChart(10);
    expect(exact).not.toBeNull();
    expect(exact!.source).toBe('exact');
    expect(exact!.sbPushFrequency).toEqual(
      GTO_PUSH_FOLD_TABLE.entries.find((entry) => entry.stackBB === 10)!.sbPushFrequency,
    );
    expect(lookupPushFoldChart(3)).toBeNull();
    expect(lookupPushFoldChart(21)).toBeNull();
    expect(lookupPushFoldChart(Number.NaN)).toBeNull();
  });

  it('10.5BB 在 10BB 与 11BB 之间线性插值', () => {
    const lower = lookupPushFoldChart(10)!;
    const upper = lookupPushFoldChart(11)!;
    const middle = lookupPushFoldChart(10.5)!;
    expect(middle.source).toBe('interpolated');
    for (let index = 0; index < middle.sbPushFrequency.length; index++) {
      const expected = (lower.sbPushFrequency[index] + upper.sbPushFrequency[index]) / 2;
      expect(middle.sbPushFrequency[index]).toBeCloseTo(expected, 6);
    }
  });

  it('短码单挑建议优先查表（理由含「查表」或「插值」）', () => {
    const hand = makeHand({
      stacks: [300, 300],
      buttonIndex: 1,
      holeCards: [undefined, CC('As Ah')],
    });
    const view = buildPlayerView(hand, 1, 'gto-table-sb');
    const advice = gtoPushFoldAdvice(view);
    expect(advice).not.toBeNull();
    expect(advice!.note).toMatch(/查表|插值/);
    expect(advice!.action).toBe('push');
    expect(advice!.frequency).toBeGreaterThan(0.5);
  });

  it('超过 20BB 不再触发短码查表建议', () => {
    const hand = makeHand({
      stacks: [600, 600],
      buttonIndex: 1,
      holeCards: [undefined, CC('As Ah')],
    });
    expect(gtoPushFoldAdvice(buildPlayerView(hand, 1, 'gto-table-deep'))).toBeNull();
  });
});
