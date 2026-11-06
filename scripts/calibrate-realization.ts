/**
 * 从实际引擎里测量权益实现率（equity realization）。
 *
 * 定义：翻牌开始时底池 P、双方各已投入 I、剩余筹码 S。
 * - 理论「全过牌」收益 = equity × P − I
 * - 实际收益 = 从翻牌开始的净筹码变化
 * - 实现率 r = mean(实际) / mean(理论)
 *
 * 分别统计有位置（单挑 SB / 按钮）与无位置（BB）。
 * 离线分析会看到双方底牌，但只用于校准离线蓝图，不进入运行时决策。
 */
import { act, createTable, startNextHand } from '../src/game/stateMachine';
import { buildPlayerView } from '../src/game/playerView';
import { decide } from '../src/ai/aiPlayer';
import { createDeck, derivedRng, shuffle } from '../src/game/cards';
import { showdownSign } from '../src/ai/solver/abstraction';
import type { Card, PlayerAction, TableState } from '../src/game/types';

const HANDS = Number(process.env.HANDS ?? 6000);
const MC = Number(process.env.MC ?? 300);
const MAX_ITER = 800;

interface Sample {
  expected: number;
  actual: number;
  inPosition: boolean;
}

const samples: Sample[] = [];
const rng = derivedRng('realization-calibration');

function equityAtFlop(
  hero: readonly [Card, Card],
  villain: readonly [Card, Card],
  board: readonly Card[],
): number {
  const used = new Set([...hero, ...villain, ...board].map((c) => `${c.rank}${c.suit}`));
  const deck = createDeck().filter((c) => !used.has(`${c.rank}${c.suit}`));
  const need = 5 - board.length;
  let score = 0;
  for (let i = 0; i < MC; i++) {
    const runout = shuffle(deck, rng).slice(0, need);
    const sign = showdownSign(hero, villain, [...board, ...runout]);
    score += sign > 0 ? 1 : sign === 0 ? 0.5 : 0;
  }
  return score / MC;
}

async function play(seed: string) {
  let table: TableState = createTable({
    playerCount: 2, startingStack: 1000, smallBlind: 10, bigBlind: 20, seed,
    difficulty: 'expert', challengeMode: true,
  });
  table.players = table.players.map((p) => ({ ...p, styleId: 0, challengeArchetypeId: 0, stack: 1000 }));
  table = startNextHand(table);

  let flopSnapshot: { pot: number; stacks: number[]; invested: number; board: Card[] } | null = null;
  let guard = 0;
  while (table.phase === 'playing' && guard++ < 80) {
    const hand = table.hand!;
    const idx = hand.actingIndex!;
    const view = buildPlayerView(hand, hand.players[idx].id, seed);
    if (!flopSnapshot && hand.street === 'flop' && hand.board.length >= 3) {
      flopSnapshot = {
        pot: hand.pot,
        stacks: hand.players.map((p) => p.stack),
        invested: hand.players[0].committedTotal ?? 0,
        board: [...hand.board],
      };
    }
    const action: PlayerAction = idx === 0
      ? (await decide(view, 'expert', { challenge: true, maxIterations: MAX_ITER })).action
      : (await decide(view, 'expert', { maxIterations: MAX_ITER })).action;
    table = act(table, idx, action);
  }

  const hand = table.hand;
  if (!flopSnapshot || !hand) return;
  const [p0, p1] = hand.players;
  if (!p0.holeCards || !p1.holeCards) return;
  if (p0.status === 'out' || p1.status === 'out') return;

  const button = table.buttonIndex;
  const pair: Sample[] = [];
  for (const seat of [0, 1]) {
    const hero = hand.players[seat];
    const villain = hand.players[1 - seat];
    if (!hero.holeCards || !villain.holeCards) continue;
    const equity = equityAtFlop(
      hero.holeCards as [Card, Card],
      villain.holeCards as [Card, Card],
      flopSnapshot.board,
    );
    const expected = equity * flopSnapshot.pot - flopSnapshot.invested;
    const actual = hero.stack - flopSnapshot.stacks[seat];
    pair.push({ expected, actual, inPosition: seat === button });
  }
  // 成对筛选：两侧都要满足条件才计入，避免 IP/OOP 用了不同子集导致比值偏差。
  if (pair.length !== 2) return;
  if (pair.some((sample) => Math.abs(sample.expected) < 0.5)) return;
  samples.push(...pair);
}

for (let h = 0; h < HANDS; h++) {
  await play(`real-${h}`);
}

for (const label of [true, false]) {
  const subset = samples.filter((s) => s.inPosition === label);
  if (subset.length === 0) continue;
  const expectedMean = subset.reduce((sum, s) => sum + s.expected, 0) / subset.length;
  const actualMean = subset.reduce((sum, s) => sum + s.actual, 0) / subset.length;
  console.log(
    `${label ? '有位置(IP)' : '无位置(OOP)'} n=${String(subset.length).padStart(5)} ` +
      `理论均值=${expectedMean.toFixed(2)} 实际均值=${actualMean.toFixed(2)} ` +
      `实现率=${(actualMean / expectedMean).toFixed(3)}`,
  );
}
