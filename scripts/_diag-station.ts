/** 对跟注站时，统计各档位的动作频率与引擎分布。 */
import { act, createTable, startNextHand } from '../src/game/stateMachine';
import { buildPlayerView } from '../src/game/playerView';
import { decide } from '../src/ai/aiPlayer';
import type { Difficulty, PlayerAction, TableState } from '../src/game/types';

const HANDS = Number(process.env.HANDS ?? 300);
const CHALLENGE = process.env.CHALLENGE === '1';
const DIFF = (process.env.DIFF ?? 'expert') as Difficulty;

const stat = {
  preflop: { n: 0, raise: 0, call: 0, fold: 0 },
  betWhenChecked: 0, checkWhenChecked: 0,
  foldFacing: 0, callFacing: 0,
  engines: {} as Record<string, number>,
  sizeSum: 0, sizeN: 0,
};

async function play(seed: string, botSeat: number): Promise<void> {
  let table: TableState = createTable({
    playerCount: 2, startingStack: 1000, smallBlind: 10, bigBlind: 20, seed,
    difficulty: DIFF, challengeMode: CHALLENGE,
  });
  table.players = table.players.map((p) => ({ ...p, styleId: 0, challengeArchetypeId: 0 }));
  table = startNextHand(table);
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
      const e = d.debug.engine ?? 'heuristic';
      stat.engines[e] = (stat.engines[e] ?? 0) + 1;
      const street = view.street;
      if (street === 'preflop') {
        stat.preflop.n++;
        if (action.type === 'raise' || action.type === 'allin') stat.preflop.raise++;
        else if (action.type === 'call') stat.preflop.call++;
        else stat.preflop.fold++;
      } else if (legal.callAmount > 0) {
        if (action.type === 'fold') stat.foldFacing++;
        else stat.callFacing++;
      } else if (legal.canCheck) {
        if (action.type === 'check') stat.checkWhenChecked++;
        else {
          stat.betWhenChecked++;
          if (action.amount) { stat.sizeSum += action.amount; stat.sizeN++; }
        }
      }
    } else {
      // 跟注站：能过牌就过牌，面对下注一律跟
      action = legal.canCheck ? { type: 'check' } : legal.canCall ? { type: 'call' } : { type: 'fold' };
    }
    table = act(table, idx, action);
  }
}

for (let h = 0; h < HANDS; h++) {
  const seed = `cmp-caller-${h}`;
  await play(seed, 0);
  await play(seed, 1);
}

const pct = (a: number, b: number) => `${((a / Math.max(1, b)) * 100).toFixed(0)}%`;
console.log(JSON.stringify({
  tier: CHALLENGE ? '挑战宗师' : DIFF,
  preflopVPIP: pct(stat.preflop.raise + stat.preflop.call, stat.preflop.n),
  preflopRaise: pct(stat.preflop.raise, stat.preflop.n),
  preflopFold: pct(stat.preflop.fold, stat.preflop.n),
  betWhenChecked: pct(stat.betWhenChecked, stat.betWhenChecked + stat.checkWhenChecked),
  avgBetSize: stat.sizeN ? Math.round(stat.sizeSum / stat.sizeN) : 0,
  foldFacingBet: pct(stat.foldFacing, stat.foldFacing + stat.callFacing),
  engines: stat.engines,
}));
