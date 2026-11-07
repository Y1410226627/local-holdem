/** 对「每手全下」的对手时，翻前决策分布 + 逐手 EV 明细。 */
import { act, createTable, startNextHand } from '../src/game/stateMachine';
import { buildPlayerView } from '../src/game/playerView';
import { decide } from '../src/ai/aiPlayer';
import type { Difficulty, PlayerAction, TableState } from '../src/game/types';

const HANDS = Number(process.env.HANDS ?? 400);
const CHALLENGE = process.env.CHALLENGE === '1';
const DIFF = (process.env.DIFF ?? 'expert') as Difficulty;
const VERBOSE = process.env.VERBOSE === '1';

interface Row {
  key: string;
  equity: number;
  need: number;
  action: string;
  net: number;
}

const rows: Row[] = [];
let shoveFaced = 0;

async function play(seed: string, botSeat: number): Promise<void> {
  let table: TableState = createTable({
    playerCount: 2, startingStack: 1000, smallBlind: 10, bigBlind: 20, seed,
    difficulty: DIFF, challengeMode: CHALLENGE,
  });
  table.players = table.players.map((p) => ({ ...p, styleId: 0, challengeArchetypeId: 0 }));
  table = startNextHand(table);
  const start = table.handStartStacks[botSeat] ?? 0;
  let guard = 0;
  while (table.phase === 'playing' && guard++ < 300) {
    const hand = table.hand!;
    const idx = hand.actingIndex!;
    const view = buildPlayerView(hand, hand.players[idx].id, seed);
    const legal = view.legal!;
    let action: PlayerAction;
    if (idx === botSeat) {
      const d = await decide(view, DIFF, { maxIterations: 800, challenge: CHALLENGE });
      action = d.action;
      if (view.street === 'preflop' && legal.callAmount > 0) {
        shoveFaced++;
        const m = /权益 ([\d.]+)%/.exec(d.debug.reasoning ?? '');
        const equity = m ? Number(m[1]) / 100 : NaN;
        const need = legal.callAmount / Math.max(1, view.pot);
        rows.push({
          key: `${view.self.holeCards[0].rank >= view.self.holeCards[1].rank ? rankText(view.self.holeCards[0].rank) + rankText(view.self.holeCards[1].rank) : rankText(view.self.holeCards[1].rank) + rankText(view.self.holeCards[0].rank)}${view.self.holeCards[0].suit === view.self.holeCards[1].suit ? 's' : 'o'}`,
          equity,
          need,
          action: action.type,
          net: 0,
        });
      }
    } else {
      action = legal.canAllIn ? { type: 'allin' } : legal.canCheck ? { type: 'check' } : legal.canCall ? { type: 'call' } : { type: 'fold' };
    }
    table = act(table, idx, action);
  }
  const net = table.players[botSeat].stack - start;
  // 把这手最后一个翻前记录的净收益记上
  const last = rows[rows.length - 1];
  if (last) last.net += net;
}

function rankText(rank: number): string {
  return ({ 10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' } as Record<number, string>)[rank] ?? String(rank);
}

for (let h = 0; h < HANDS; h++) {
  const seed = `cmp-shover-${h}`;
  await play(seed, 0);
  await play(seed, 1);
}

const byAction: Record<string, number> = {};
let evSum = 0, needSum = 0, evN = 0;
for (const r of rows) {
  byAction[r.action] = (byAction[r.action] ?? 0) + 1;
  if (Number.isFinite(r.equity)) { evSum += r.equity; needSum += r.need; evN++; }
}
const total = rows.length;
const pct = (n: number) => `${((n / Math.max(1, total)) * 100).toFixed(0)}%`;

// 按权益分桶看弃牌率
const buckets = [0, 0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7];
const bucketStat = buckets.slice(0, -1).map((lo, i) => {
  const hi = buckets[i + 1];
  const inBucket = rows.filter((r) => r.equity >= lo && r.equity < hi);
  const folds = inBucket.filter((r) => r.action === 'fold').length;
  const calls = inBucket.filter((r) => r.action === 'call' || r.action === 'allin').length;
  const net = inBucket.reduce((a, b) => a + b.net, 0);
  return `${lo.toFixed(2)}-${hi.toFixed(2)}: n=${inBucket.length} fold=${folds} call=${calls} net=${net.toFixed(0)}`;
});

console.log(JSON.stringify({
  tier: CHALLENGE ? '挑战宗师' : DIFF,
  shoveFaced,
  actions: Object.fromEntries(Object.entries(byAction).map(([k, v]) => [k, pct(v)])),
  avgEquity: evN ? Number((evSum / evN).toFixed(3)) : null,
  avgNeed: evN ? Number((needSum / evN).toFixed(3)) : null,
  buckets: bucketStat,
}, null, 2));

if (VERBOSE) {
  const sorted = [...rows].sort((a, b) => a.equity - b.equity);
  for (const r of sorted) console.log(`${r.key} eq=${r.equity.toFixed(3)} need=${r.need.toFixed(3)} ${r.action} net=${r.net.toFixed(0)}`);
}
