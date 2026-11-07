/** 统计各决策引擎的命中次数（翻牌蓝图到底用上了没有）。 */
import { act, createTable, startNextHand } from '../src/game/stateMachine';
import { buildPlayerView } from '../src/game/playerView';
import { decide } from '../src/ai/aiPlayer';
import type { Difficulty, PlayerAction, TableState } from '../src/game/types';

const HANDS = Number(process.env.HANDS ?? 300);
const KIND = (process.env.KIND ?? 'caller') as 'caller' | 'folder' | 'shover';
const CHALLENGE = process.env.CHALLENGE === '1';
const DIFF = (process.env.DIFF ?? 'expert') as Difficulty;
const FLOP_BP = process.env.FLOP_BP === '1';

const engines: Record<string, number> = {};
const flopDecisions: Record<string, number> = {};

function fixed(legal: { canCheck: boolean; canCall: boolean; canAllIn: boolean }): PlayerAction {
  if (KIND === 'caller') {
    if (legal.canCheck) return { type: 'check' };
    if (legal.canCall) return { type: 'call' };
    return { type: 'fold' };
  }
  if (KIND === 'folder') return legal.canCheck ? { type: 'check' } : { type: 'fold' };
  if (legal.canAllIn) return { type: 'allin' };
  if (legal.canCheck) return { type: 'check' };
  if (legal.canCall) return { type: 'call' };
  return { type: 'fold' };
}

let table: TableState = createTable({
  playerCount: 2, startingStack: 1000, smallBlind: 10, bigBlind: 20,
  seed: `eng-${KIND}`, difficulty: DIFF, challengeMode: CHALLENGE,
});
table.players = table.players.map((p) => ({ ...p, styleId: 0, challengeArchetypeId: 0 }));
const SEAT = 0;
for (let h = 0; h < HANDS; h++) {
  table.players = table.players.map((p) => ({ ...p, stack: 1000 }));
  table.phase = 'handOver';
  table = startNextHand(table);
  if (table.phase === 'gameOver') break;
  let guard = 0;
  while (table.phase === 'playing' && guard++ < 400) {
    const hand = table.hand!;
    const idx = hand.actingIndex!;
    const view = buildPlayerView(hand, hand.players[idx].id, `eng-${h}`);
    const legal = view.legal!;
    let action: PlayerAction;
    if (idx === SEAT) {
      const d = await decide(view, DIFF, { maxIterations: 800, challenge: CHALLENGE, flopBlueprint: FLOP_BP });
      action = d.action;
      const e = d.debug.engine ?? 'heuristic';
      engines[e] = (engines[e] ?? 0) + 1;
      if (view.street === 'flop') flopDecisions[e] = (flopDecisions[e] ?? 0) + 1;
    } else {
      action = fixed(legal);
    }
    table = act(table, idx, action);
  }
}
const total = Object.values(engines).reduce((a, b) => a + b, 0);
const flopTotal = Object.values(flopDecisions).reduce((a, b) => a + b, 0);
const pct = (n: number, d: number) => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
console.log(JSON.stringify({
  tier: CHALLENGE ? '挑战宗师' : DIFF,
  opponent: KIND,
  flopBlueprint: FLOP_BP,
  totalDecisions: total,
  engines: Object.fromEntries(Object.entries(engines).map(([k, v]) => [k, `${v} (${pct(v, total)})`])),
  flopDecisions: flopTotal,
  flopEngines: Object.fromEntries(Object.entries(flopDecisions).map(([k, v]) => [k, `${v} (${pct(v, flopTotal)})`])),
}, null, 2));
