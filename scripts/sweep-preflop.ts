/** 扫 169 个起手牌分类，统计新 EV 引擎在各场景下的动作分布。 */
import { buildPlayerView } from '../src/game/playerView';
import { decide } from '../src/ai/aiPlayer';
import { CC, makeHand, playSequence } from '../src/tests/helpers';
import type { PlayerView } from '../src/game/playerView';

const RANKS = 'AKQJT98765432';
const SUITS = ['s', 'h', 'd', 'c'];

/** 分类键 → 一组具体牌（优先选不冲突的花色）。 */
function cardsFor(key: string): [string, string] {
  const high = RANKS.indexOf(key[0]);
  const low = RANKS.indexOf(key[1]);
  const suited = key.length === 3 && key[2] === 's';
  const h = RANKS[high];
  const l = RANKS[low];
  if (high === low) return [`${h}s`, `${h}h`];
  return suited ? [`${h}s`, `${l}s`] : [`${h}s`, `${l}h`];
}

function allKeys(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 13; i++) {
    out.push(`${RANKS[i]}${RANKS[i]}`);
    for (let j = i + 1; j < 13; j++) {
      out.push(`${RANKS[i]}${RANKS[j]}s`);
      out.push(`${RANKS[i]}${RANKS[j]}o`);
    }
  }
  return out;
}

type Scenario = { name: string; build: (hole: [string, string]) => PlayerView | null };

function sixMaxOpen(hole: [string, string]): PlayerView | null {
  // 6 人桌，按钮 0，UTG（座位 3）先行动
  const seed = `sweep-open-${hole[0]}${hole[1]}`;
  const hand = makeHand({
    stacks: [1000, 1000, 1000, 1000, 1000, 1000],
    buttonIndex: 0,
    seed,
    holeCards: [CC('2c 3d'), CC('2d 3c'), CC('2h 3s'), CC(hole.join(' ')), CC('4c 5d'), CC('4d 5h')],
  });
  const index = hand.actingIndex!;
  return buildPlayerView(hand, index, seed);
}

function sixMaxFacingRaise(hole: [string, string]): PlayerView | null {
  // 座位 3 开池到 60（3BB），轮到座位 4
  const seed = `sweep-face-${hole[0]}${hole[1]}`;
  let hand = makeHand({
    stacks: [1000, 1000, 1000, 1000, 1000, 1000],
    buttonIndex: 0,
    seed,
    holeCards: [CC('2c 3d'), CC('2d 3c'), CC('2h 3s'), CC('4c 5d'), CC(hole.join(' ')), CC('4d 5h')],
  });
  hand = playSequence(hand, [[3, { type: 'raise', amount: 60 }]]);
  const index = hand.actingIndex!;
  return buildPlayerView(hand, index, seed);
}

function headsUpFacingShove(hole: [string, string]): PlayerView | null {
  const seed = `sweep-shove-${hole[0]}${hole[1]}`;
  let hand = makeHand({
    stacks: [2520, 2520],
    buttonIndex: 0,
    seed,
    holeCards: [CC('9s Qh'), CC(hole.join(' '))],
  });
  hand = playSequence(hand, [[0, { type: 'call' }], [1, { type: 'raise', amount: 90 }], [0, { type: 'allin' }]]);
  const index = hand.actingIndex!;
  return buildPlayerView(hand, index, seed);
}

const scenarios: Scenario[] = [
  { name: '6人桌 无人加注（开池）', build: sixMaxOpen },
  { name: '6人桌 面对 3BB 开池', build: sixMaxFacingRaise },
  { name: '单挑 面对 126BB 全下', build: headsUpFacingShove },
];

for (const scenario of scenarios) {
  const counts: Record<string, number> = {};
  const raised: string[] = [];
  for (const key of allKeys()) {
    const hole = cardsFor(key);
    const view = scenario.build(hole);
    if (!view || !view.legal) continue;
    const d = await decide(view, 'expert', { challenge: true, maxIterations: 200, blueprint: false });
    const t = d.action.type;
    counts[t] = (counts[t] ?? 0) + 1;
    if (t === 'raise' || t === 'allin') raised.push(key);
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const pct = (n: number) => `${((n / Math.max(1, total)) * 100).toFixed(0)}%`;
  console.log(`\n=== ${scenario.name} ===`);
  console.log('  分布:', Object.entries(counts).map(([k, v]) => `${k} ${v} (${pct(v)})`).join('  '));
  console.log('  加注范围(前20):', raised.slice(0, 20).join(' '));
}
