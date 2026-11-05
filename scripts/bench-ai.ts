/** 方案 B 验收基准：新挑战 AI vs 专家基线，配对展示（相同 seed 交换位置），统计胜率 / BB/100 / 延迟。 */
import { act, createTable, startNextHand } from '../src/game/stateMachine';
import { buildPlayerView } from '../src/game/playerView';
import { decide } from '../src/ai/aiPlayer';
import type { Difficulty, PlayerAction, TableState } from '../src/game/types';

const HANDS = 200;
const MAX_ITER = 800;

async function playSeries(seedPrefix: string, mode: 'new' | 'baseline') {
  let newNet = 0;
  let newWins = 0;
  let decisions = 0;
  let totalMs = 0;
  let handsPlayed = 0;
  for (let handNo = 0; handNo < HANDS; handNo++) {
    let table = startNextHand(
      createTable({
        playerCount: 3,
        seed: `${seedPrefix}-${handNo}`,
        difficulty: 'expert' as Difficulty,
        challengeMode: mode === 'baseline', // baseline 局里机器人用新 AI；人类座位=基线
      }),
    );
    let guard = 0;
    while (table.phase === 'playing') {
      guard += 1;
      if (guard > 500) throw new Error('hand stuck');
      const hand = table.hand!;
      const index = hand.actingIndex!;
      const actor = hand.players[index];
      const view = buildPlayerView(hand, actor.id, table.config.seed);
      let action: PlayerAction;
      const isNewSeat = actor.isHuman ? mode === 'new' : mode === 'baseline';
      if (isNewSeat) {
        const started = performance.now();
        action = (await decide(view, 'expert', { challenge: true, maxIterations: MAX_ITER })).action;
        totalMs += performance.now() - started;
        decisions += 1;
      } else {
        action = (await decide(view, 'expert', { maxIterations: MAX_ITER })).action;
      }
      table = act(table, index, action);
    }
    handsPlayed += 1;
    const newSeatIndex = mode === 'new' ? table.players.findIndex((p) => p.isHuman) : -1;
    if (mode === 'new') {
      const newPlayer = table.players[newSeatIndex];
      const start = table.handStartStacks[newSeatIndex] ?? 0;
      newNet += newPlayer.stack - start;
      if (newPlayer.stack > start) newWins += 1;
    } else {
      // baseline 局：新 AI 是 1/2 号机器人，统计它们合计净收益作为“新 AI”收益。
      for (const p of table.players) {
        if (p.isHuman) continue;
        newNet += p.stack - (table.handStartStacks[p.id] ?? 0);
      }
      const human = table.players.find((p) => p.isHuman)!;
      if ((human.stack - (table.handStartStacks[human.id] ?? 0)) < 0) newWins += 1;
    }
  }
  return { newNet, newWins, handsPlayed, decisions, totalMs };
}

const start = Date.now();
const a = await playSeries('bench-newseat', 'new');
const b = await playSeries('bench-newbots', 'baseline');
const hands = a.handsPlayed + b.handsPlayed;
const newNet = a.newNet + b.newNet;
const newWins = a.newWins + b.newWins;
const decisions = a.decisions + b.decisions;
const totalMs = a.totalMs + b.totalMs;
console.log(JSON.stringify({
  hands,
  newWins,
  winRate: Number((newWins / Math.max(1, hands)).toFixed(4)),
  newNet,
  bbPer100: Number(((newNet / 20) / hands * 100).toFixed(1)),
  avgDecisionMs: Number((totalMs / Math.max(1, decisions)).toFixed(1)),
  decisions,
  wallSeconds: Number(((Date.now() - start) / 1000).toFixed(1)),
  maxIterations: MAX_ITER,
}, null, 2));
