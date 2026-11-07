/** 会话内诊断：对全下怪时，我方翻前每一次「面对全下」的决策与真实 EV。 */
import { act, createTable, startNextHand } from '../src/game/stateMachine';
import { buildPlayerView } from '../src/game/playerView';
import { decide } from '../src/ai/aiPlayer';
import { equityVsTopRange } from '../src/ai/preflopCall';
import { mulberry32 } from '../src/game/cards';
import type { PlayerAction, TableState } from '../src/game/types';

const HANDS = Number(process.env.HANDS ?? 200);
const CHALLENGE = process.env.CHALLENGE === '1';
const SEAT = Number(process.env.SEAT ?? 0);
const STACK = 1000;
const rng = mulberry32(999);

interface Rec { key: string; pot: number; call: number; est: number; truth: number; act: string; role: string; range: number }
const recs: Rec[] = [];

async function run(): Promise<number> {
  let table: TableState = createTable({
    playerCount: 2, startingStack: STACK, smallBlind: 10, bigBlind: 20,
    seed: 'diag', difficulty: 'expert', challengeMode: CHALLENGE,
  });
  table.players = table.players.map((p) => ({ ...p, styleId: 0, challengeArchetypeId: 0 }));
  let total = 0;
  for (let h = 0; h < HANDS; h++) {
    table.players = table.players.map((p) => ({ ...p, stack: STACK }));
    table.phase = 'handOver';
    table = startNextHand(table);
    if (table.phase === 'gameOver') break;
    const start = table.handStartStacks[SEAT] ?? 0;
    let guard = 0;
    let lastPreflopAggressive = false;
    while (table.phase === 'playing' && guard++ < 400) {
      const hand = table.hand!;
      const idx = hand.actingIndex!;
      const view = buildPlayerView(hand, hand.players[idx].id, `diag-h${h}`);
      const legal = view.legal!;
      let action: PlayerAction;
      if (idx === SEAT) {
        const d = await decide(view, 'expert', { maxIterations: 800, challenge: CHALLENGE });
        action = d.action;
        if (view.street === 'preflop' && legal.callAmount > 400) {
          const m = /权益 ([\d.]+)%/.exec(d.debug.reasoning ?? '');
          const rm = /对范围前 ([\d.]+)%/.exec(d.debug.reasoning ?? '');
          const hole = view.self.holeCards as [never, never];
          const truth = equityVsTopRange(hole, 1.0, rng, 600);
          const hi = hole[0].rank >= hole[1].rank ? hole[0] : hole[1];
          const lo = hole[0].rank >= hole[1].rank ? hole[1] : hole[0];
          recs.push({
            key: `${hi.rank}${lo.rank}${hi.suit === lo.suit ? 's' : 'o'}`,
            pot: view.pot, call: legal.callAmount,
            est: m ? Number(m[1]) / 100 : NaN,
            range: rm ? Number(rm[1]) / 100 : NaN,
            truth,
            act: action.type,
            role: lastPreflopAggressive ? '我加注后被推' : '对手直接推',
          });
        }
        if (view.street === 'preflop' && (action.type === 'raise' || action.type === 'allin')) lastPreflopAggressive = true;
      } else {
        action = legal.canAllIn ? { type: 'allin' } : legal.canCheck ? { type: 'check' } : legal.canCall ? { type: 'call' } : { type: 'fold' };
      }
      table = act(table, idx, action);
    }
    total += table.players[SEAT].stack - start;
  }
  console.log(`总盈亏 ${total} 筹码 / ${HANDS} 手 = ${(total / HANDS / 20 * 100).toFixed(1)} BB/100`);
  return total;
}

await run();

const byRole: Record<string, Rec[]> = {};
for (const r of recs) (byRole[r.role] ??= []).push(r);
for (const [role, list] of Object.entries(byRole)) {
  const calls = list.filter((r) => r.act === 'call' || r.act === 'allin');
  const folds = list.filter((r) => r.act === 'fold');
  const evOf = (r: Rec) => r.truth * (r.pot + r.call) - r.call;
  const missFold = folds.filter((r) => evOf(r) > 0);
  const badCall = calls.filter((r) => evOf(r) < 0);
  const lostByFold = missFold.reduce((a, r) => a + evOf(r), 0);
  const lostByCall = badCall.reduce((a, r) => a + -evOf(r), 0);
  console.log(
    `${role}: n=${list.length} call=${calls.length} fold=${folds.length} | ` +
    `错误弃牌 ${missFold.length} 次，放弃 EV ${lostByFold.toFixed(0)} | 错误跟注 ${badCall.length} 次，损失 ${lostByCall.toFixed(0)}`,
  );
  console.log(`  平均估计权益 ${(list.reduce((a, r) => a + r.est, 0) / list.length * 100).toFixed(1)}% vs 真实 ${(list.reduce((a, r) => a + r.truth, 0) / list.length * 100).toFixed(1)}% | 平均估计范围 ${(list.reduce((a, r) => a + r.range, 0) / list.length * 100).toFixed(0)}%`);
}
