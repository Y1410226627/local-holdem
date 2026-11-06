/**
 * 可信基准（替换旧版“非配对 + 无置信区间”的 bench-ai.ts）。
 *
 * 口径：
 * - 同一 seed 交换座位 / 轮转座位，消除牌运与位置偏差；
 * - 每个对手独立统计，输出均值、标准差、标准误与 95% 置信区间；
 * - 挑战 AI 默认用降载求解器（40 迭代 / 40 组合），可用 SOLVER=0 关闭；
 * - 统计 debug.engine，报告 CFR 子博弈 / 蓝图 / 多人 / 启发式的实际占比。
 *
 * 用法：
 *   npm run bench                         # HU，2000 对，全部对手
 *   HANDS=5000 npm run bench              # 更大样本
 *   PLAYERS=3 npm run bench               # 3 人桌（挑战 AI 走多人启发式）
 *   OPPONENTS=expert,caller npm run bench # 指定对手
 *   SOLVER=0 npm run bench                # 关闭子博弈求解器（消融）
 */
import { act, createTable, startNextHand } from '../src/game/stateMachine';
import { buildPlayerView } from '../src/game/playerView';
import { decide } from '../src/ai/aiPlayer';
import type { LegalActions, PlayerAction, TableState } from '../src/game/types';

type OpponentKind = 'expert' | 'caller' | 'folder' | 'tight' | 'shover';

const PLAYERS = Math.max(2, Math.min(6, Number(process.env.PLAYERS ?? 2)));
const HANDS = Math.max(20, Math.floor(Number(process.env.HANDS ?? 2000)));
const MAX_ITER = Math.max(50, Math.floor(Number(process.env.MAX_ITER ?? 800)));
const SOLVER_ON = process.env.SOLVER !== '0';
const SOLVER_ITERATIONS = Math.max(10, Math.floor(Number(process.env.SOLVER_ITERATIONS ?? 200)));
const SOLVER_COMBOS = Math.max(10, Math.floor(Number(process.env.SOLVER_COMBOS ?? 60)));
const START_STACK = 1000;
const SB = 10;
const BB = 20;

const defaultOpponents: OpponentKind[] =
  PLAYERS === 2 ? ['expert', 'caller', 'folder', 'tight', 'shover'] : ['expert'];
const opponents = (process.env.OPPONENTS?.split(',').filter(Boolean) as OpponentKind[] | undefined) ?? defaultOpponents;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fixedAction(kind: OpponentKind, legal: LegalActions): PlayerAction {
  if (kind === 'caller') {
    if (legal.canCheck) return { type: 'check' };
    if (legal.canCall) return { type: 'call' };
    return { type: 'fold' };
  }
  if (kind === 'folder') return legal.canCheck ? { type: 'check' } : { type: 'fold' };
  if (kind === 'shover') {
    if (legal.canAllIn) return { type: 'allin' };
    if (legal.canCheck) return { type: 'check' };
    if (legal.canCall) return { type: 'call' };
    return { type: 'fold' };
  }
  if (kind === 'tight') {
    if (legal.canCheck) return { type: 'check' };
    if (legal.canCall && legal.callAmount <= BB) return { type: 'call' };
    return { type: 'fold' };
  }
  return { type: 'fold' };
}

interface HandResult {
  net: number;
  engines: Record<string, number>;
  decisions: number;
}

async function playHand(seed: string, challengeSeat: number, opponent: OpponentKind): Promise<HandResult> {
  let table: TableState = createTable({
    playerCount: PLAYERS,
    startingStack: START_STACK,
    smallBlind: SB,
    bigBlind: BB,
    seed,
    difficulty: 'expert',
    challengeMode: true,
  });
  table.players = table.players.map((player) => ({
    ...player,
    styleId: 0,
    challengeArchetypeId: 0,
    stack: START_STACK,
  }));
  table = startNextHand(table);
  const rng = mulberry32(seed.length * 2654435761 + seed.charCodeAt(seed.length - 1));
  const engines: Record<string, number> = {};
  let decisions = 0;
  let guard = 0;
  while (table.phase === 'playing') {
    guard += 1;
    if (guard > 400) throw new Error('hand stuck: ' + seed);
    const hand = table.hand!;
    const index = hand.actingIndex!;
    const view = buildPlayerView(hand, hand.players[index].id, seed);
    let action: PlayerAction;
    if (index === challengeSeat) {
      const decision = await decide(view, 'expert', {
        challenge: true,
        maxIterations: MAX_ITER,
        ...(SOLVER_ON
          ? { solver: { iterations: SOLVER_ITERATIONS, maxCombos: SOLVER_COMBOS } }
          : { solver: { enabled: false } }),
        ...(process.env.BLUEPRINT === '0' ? { blueprint: false } : {}),
        ...(process.env.SB_WIDE === '0' ? { sbWide: false } : {}),
        ...(process.env.TURN_RIVER === '0' ? { turnRiver: { enabled: false } } : {}),
        ...(process.env.BLUEPRINT_RANGES === '0' ? { blueprintRanges: false } : {}),
      });
      action = decision.action;
      const engine = decision.debug.engine ?? 'heuristic';
      engines[engine] = (engines[engine] ?? 0) + 1;
      decisions += 1;
    } else if (PLAYERS === 2 && opponent !== 'expert') {
      action = fixedAction(opponent, view.legal!);
    } else {
      action = (await decide(view, 'expert', { maxIterations: MAX_ITER })).action;
    }
    table = act(table, index, action);
  }
  const net = table.players[challengeSeat].stack - (table.handStartStacks[challengeSeat] ?? 0);
  return { net, engines, decisions };
}

interface Summary {
  players: number;
  opponent: OpponentKind;
  seeds: number;
  hands: number;
  bbPer100: number;
  ci95: [number, number];
  sdBBPerHand: number;
  seBBPer100: number;
  engines: Record<string, number>;
  solverShare: number;
  wallSeconds: number;
}

async function run(opponent: OpponentKind): Promise<Summary> {
  const pairNets: number[] = [];
  const engines: Record<string, number> = {};
  let decisions = 0;
  const started = Date.now();
  for (let handNo = 0; handNo < HANDS; handNo++) {
    const seed = `bench-${PLAYERS}p-${opponent}-${handNo}`;
    let sum = 0;
    for (let seat = 0; seat < PLAYERS; seat++) {
      const result = await playHand(seed, seat, opponent);
      sum += result.net;
      decisions += result.decisions;
      for (const [engine, count] of Object.entries(result.engines)) {
        engines[engine] = (engines[engine] ?? 0) + count;
      }
    }
    pairNets.push(sum / PLAYERS);
  }
  const n = pairNets.length;
  const mean = pairNets.reduce((sum, value) => sum + value, 0) / n;
  const variance = pairNets.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, n - 1);
  const sd = Math.sqrt(variance);
  const se = sd / Math.sqrt(n);
  const bbPer100 = (mean / BB) * 100;
  const seBB = (se / BB) * 100;
  const solverDecisions = engines['cfr-subgame'] ?? 0;
  return {
    players: PLAYERS,
    opponent,
    seeds: n,
    hands: n * PLAYERS,
    bbPer100: Number(bbPer100.toFixed(1)),
    ci95: [Number((bbPer100 - 1.96 * seBB).toFixed(1)), Number((bbPer100 + 1.96 * seBB).toFixed(1))],
    sdBBPerHand: Number((sd / BB).toFixed(2)),
    seBBPer100: Number(seBB.toFixed(1)),
    engines,
    solverShare: Number((solverDecisions / Math.max(1, decisions)).toFixed(3)),
    wallSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
  };
}

const summaries: Summary[] = [];
for (const opponent of opponents) {
  const summary = await run(opponent);
  summaries.push(summary);
  console.log(JSON.stringify(summary));
}

console.log('\n=== 汇总（BB/100，95% CI）===');
for (const summary of summaries) {
  console.log(
    `${summary.players}p vs ${summary.opponent.padEnd(7)} ${summary.bbPer100
      .toFixed(1)
      .padStart(8)}  [${summary.ci95[0].toFixed(1)}, ${summary.ci95[1].toFixed(1)}]  ` +
      `solver=${(summary.solverShare * 100).toFixed(0)}%  ${summary.wallSeconds}s`,
  );
}
