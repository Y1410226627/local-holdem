import { describe, expect, it } from 'vitest';
import {
  describeSeed,
  generateRandomSeed,
  RANDOM_SEED_PLACEHOLDER,
  resolveSeed,
} from '../ui/seed';
import { buildShuffledDeck, cardId } from '../game/cards';
import { createTable, startNextHand, resetChips } from '../game/stateMachine';

function holeCardsOf(table: ReturnType<typeof startNextHand>): number[][] {
  return table.hand!.players.map((player) => player.holeCards.map(cardId));
}

describe('随机种子（默认每局不同）', () => {
  it('每次生成的都是非空且足够不同的种子', () => {
    const seeds = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const seed = generateRandomSeed();
      expect(seed.length).toBeGreaterThan(6);
      expect(seed).toMatch(/^[0-9a-z-]+$/i);
      seeds.add(seed);
    }
    // 50 次里允许极端碰撞但不应出现大量重复
    expect(seeds.size).toBeGreaterThan(49);
  });

  it('不同种子产生不同牌堆，相同种子可复现', () => {
    const a = generateRandomSeed();
    const b = generateRandomSeed();
    expect(a).not.toBe(b);
    const deckA1 = buildShuffledDeck(a, 1).map(cardId);
    const deckA2 = buildShuffledDeck(a, 1).map(cardId);
    const deckB = buildShuffledDeck(b, 1).map(cardId);
    expect(deckA1).toEqual(deckA2);
    expect(deckA1).not.toEqual(deckB);
  });

  it('种子输入框提供了随机语义提示', () => {
    expect(RANDOM_SEED_PLACEHOLDER).toContain('随机');
  });
});

describe('resolveSeed：留空随机，填写固定', () => {
  it('留空 / 纯空白 → 随机种子，且每次不同', () => {
    const first = resolveSeed('');
    const second = resolveSeed('   ');
    const third = resolveSeed(undefined);
    expect(first.isRandom).toBe(true);
    expect(second.isRandom).toBe(true);
    expect(third.isRandom).toBe(true);
    expect(new Set([first.seed, second.seed, third.seed]).size).toBe(3);
  });

  it('填写固定种子 → 原样使用且标记为非随机（保留可复现）', () => {
    const resolved = resolveSeed('  demo-b  ');
    expect(resolved).toEqual({ seed: 'demo-b', isRandom: false });
  });

  it('两次留空开局（resolveSeed → 开始第一手）发出不同的底牌', () => {
    const a = resolveSeed('').seed;
    const b = resolveSeed('').seed;
    const tableA = startNextHand(createTable({ seed: a, playerCount: 4 }));
    const tableB = startNextHand(createTable({ seed: b, playerCount: 4 }));
    expect(holeCardsOf(tableA)).not.toEqual(holeCardsOf(tableB));
  });

  it('固定种子重复开局 → 完全相同的一局（可复现）', () => {
    const resolved = resolveSeed('replay-me');
    const tableA = startNextHand(createTable({ seed: resolved.seed, playerCount: 4 }));
    const tableB = startNextHand(createTable({ seed: resolved.seed, playerCount: 4 }));
    expect(holeCardsOf(tableA)).toEqual(holeCardsOf(tableB));
  });

  it('提示文案区分随机种子与固定种子', () => {
    expect(describeSeed({ seed: 'abc', isRandom: true })).toContain('随机');
    expect(describeSeed({ seed: 'abc', isRandom: false })).not.toContain('随机');
  });
});

describe('重置筹码时使用新种子', () => {
  it('resetChips 可注入新种子，开始下一手后发牌不同', () => {
    const table = startNextHand(createTable({ seed: 'fixed-old-seed', playerCount: 4 }));
    const oldCards = holeCardsOf(table);
    expect(table.config.seed).toBe('fixed-old-seed');

    const reset = resetChips(table, { seed: 'fixed-new-seed' });
    expect(reset.config.seed).toBe('fixed-new-seed');
    expect(reset.handNo).toBe(0);
    expect(reset.phase).toBe('idle');

    const next = startNextHand(reset);
    expect(next.config.seed).toBe('fixed-new-seed');
    expect(holeCardsOf(next)).not.toEqual(oldCards);
  });

  it('不传种子时 resetChips 保持原种子，可在固定种子模式复现', () => {
    const table = startNextHand(createTable({ seed: 'keep-seed', playerCount: 4 }));
    const reset = resetChips(table);
    expect(reset.config.seed).toBe('keep-seed');
    expect(startNextHand(reset).config.seed).toBe('keep-seed');
  });

  it('重置筹码并注入随机种子 → 与上一局不同的牌', () => {
    const table = startNextHand(createTable({ seed: 'reset-random-base', playerCount: 4 }));
    const oldCards = holeCardsOf(table);
    const reset = resetChips(table, { seed: resolveSeed('').seed });
    const next = startNextHand(reset);
    expect(next.config.seed).not.toBe('reset-random-base');
    expect(holeCardsOf(next)).not.toEqual(oldCards);
  });
});
