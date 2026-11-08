/** 统计挑战档的转河求解器为什么没触发。 */
import { act, createTable, startNextHand } from '../src/game/stateMachine';
import { buildPlayerView } from '../src/game/playerView';
import { decide } from '../src/ai/aiPlayer';
import { buildStreetRanges, rangeFromWeight } from '../src/ai/solver/ranges';
import { buildBlueprintRangeWeights } from '../src/ai/solver/preflop';
import { solveTurnRiver } from '../src/ai/solver/subgameTurn';
import type { PlayerAction, TableState } from '../src/game/types';

const HANDS = Number(process.env.HANDS ?? 60);
const SEAT = 0;
const reasons: Record<string, number> = {};
let turnDecisions = 0;
let solved = 0;

function bump(key: string) {
  reasons[key] = (reasons[key] ?? 0) + 1;
}

let table: TableState = createTable({
  playerCount: 2, startingStack: 1000, smallBlind: 10, bigBlind: 20,
  seed: 'why-not-solver', difficulty: 'expert', challengeMode: true,
});
table.players = table.players.map((p) => ({ ...p, styleId: 0, challengeArchetypeId: 0 }));

for (let h = 0; h < HANDS; h++) {
  table.players = table.players.map((p) => ({ ...p, stack: 1000 }));
  table.phase = 'handOver';
  table = startNextHand(table);
  if (table.phase === 'gameOver') break;
  let guard = 0;
  while (table.phase === 'playing' && guard++ < 400) {
    const hand = table.hand!;
    const idx = hand.actingIndex!;
    const view = buildPlayerView(hand, hand.players[idx].id, `wns-h${h}`);
    const legal = view.legal!;
    let action: PlayerAction;
    if (idx === SEAT) {
      if (view.street === 'turn') {
        turnDecisions++;
        const opponents = view.players.filter(
          (p) => p.id !== view.viewerId && (p.status === 'active' || p.status === 'allin'),
        );
        if (opponents.length !== 1) bump('对手数≠1');
        else {
          const rangeMap = buildStreetRanges(view);
          const villainRange = rangeMap.get(opponents[0].id);
          if (!villainRange) bump('拿不到对手范围');
          else {
            // 复刻引擎的调用参数
            const weights = buildBlueprintRangeWeights(view);
            const solverRanges = new Map<number, ReturnType<typeof rangeFromWeight>>();
            if (weights) {
              for (const [playerId, weight] of weights) {
                solverRanges.set(playerId, rangeFromWeight(view, weight, playerId));
              }
            }
            const engineOpts = {
              iterations: 160, maxCombos: 20, riverBuckets: 3,
              ranges: solverRanges.size > 0 ? solverRanges : undefined,
            };
            const probe = solveTurnRiver(view, engineOpts);
            if (probe) { solved++; bump('求解成功'); }
            else {
              bump('引擎参数下 null');
              if (!weights) bump('  ↳ 蓝图范围权重为空');
              const probeNoRanges = solveTurnRiver(view, { iterations: 160, maxCombos: 20, riverBuckets: 3 });
              bump(probeNoRanges ? '  ↳ 不传 ranges 时成功（问题在 ranges）' : '  ↳ 不传 ranges 也失败');
            }
          }
        }
      }
      action = (await decide(view, 'expert', { challenge: true })).action;
    } else {
      action = (await decide(view, 'expert', { challenge: false })).action;
    }
    table = act(table, idx, action);
  }
}

console.log(JSON.stringify({ turnDecisions, solved, reasons }, null, 2));
