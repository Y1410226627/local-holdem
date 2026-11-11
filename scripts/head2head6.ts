/**
 * 6 人桌配对强度测量台：比较「挑战宗师组」与对照组（当前专家 / 旧版本专家）。
 *
 * 为什么需要：现有 `h2h-shard.ts` 只支持单挑。人类实际玩的是 6 人桌，而 4–6 人桌的
 * 挑战档在旧实现里和专家档走同一套启发式——用单挑的 +51.6 去代表 6 人桌强度是错的。
 *
 * 设计（同 seed 配对 + 座位镜像）：
 *   · 一张 6 人桌固定打 SESSION_HANDS 手，每手重置筹码到 1000（50BB）；
 *   · 每个 seed 开两桌：A 桌「挑战组坐 0/1/2，对照组坐 3/4/5」，
 *     B 桌「挑战组坐 3/4/5，对照组坐 0/1/2」——两桌用同一副牌（seed 相同、手号相同），
 *     座位/位置偏差被镜像抵消；
 *   · 每手记录 A、B 两桌里挑战组的净赢 `na`、`nb`，合并时用 `d = (na + nb) / 2`
 *     作为该 seed-手 的配对观测，先按 seed 求平均，再对 seed 求 95% CI。
 *
 * 用法（8 进程并行，每片 250 seed）：
 *   OPPONENT=expert  SEED_START=0    SEEDS=250 OUT=tmp/h6-0.jsonl npx tsx scripts/head2head6.ts
 *   OPPONENT=v030    SEED_START=250  SEEDS=250 OUT=tmp/h6-1.jsonl OLD_DIR=<v0.3.0 目录> npx tsx scripts/head2head6.ts
 *   npx tsx scripts/head2head6-combine.ts tmp/h6-*.jsonl
 *
 * 环境变量：SEED_START / SEEDS / SESSION_HANDS / OPPONENT=expert|v030 /
 *           OLD_DIR（OPPONENT=v030 时必填）/ OUT / STACK / ARCH
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { act, createTable, startNextHand } from '../src/game/stateMachine';
import { buildPlayerView } from '../src/game/playerView';
import { decide as decideNew } from '../src/ai/aiPlayer';
import { assignChallengeArchetypes } from '../src/ai/challenge';
import type { PlayerAction, TableState } from '../src/game/types';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const SEED_START = Number(process.env.SEED_START ?? 0);
const SEEDS = Number(process.env.SEEDS ?? 250);
const SESSION_HANDS = Number(process.env.SESSION_HANDS ?? 1);
const OPPONENT = process.env.OPPONENT ?? 'expert';
const STACK = Number(process.env.STACK ?? 1000);
const ARCH = process.env.ARCH ?? 'assign';
const OUT = process.env.OUT ?? '';
const OLD_DIR = process.env.OLD_DIR ?? '../../德州扑克_old';

const oldDirAbs = isAbsolute(OLD_DIR) ? OLD_DIR : resolve(scriptDir, OLD_DIR);
const oldEntry = join(oldDirAbs, 'src', 'ai', 'aiPlayer.ts');
let decideOld: typeof decideNew | null = null;
if (OPPONENT === 'v030') {
  if (!existsSync(oldEntry)) {
    console.error(`OPPONENT=v030 需要 v0.3.0 源码目录：找不到 ${oldEntry}`);
    process.exit(1);
  }
  decideOld = (await import(pathToFileURL(oldEntry).href)).decide as typeof decideNew;
}

type Kind = 'challenge' | 'control';
interface Record {
  seed: string;
  hand: number;
  na: number;
  nb: number;
}

const OPPONENT_COUNT = 6;
const CHALLENGE_SEATS = [0, 1, 2];
const CONTROL_SEATS = [3, 4, 5];

function createSession(seed: string): TableState {
  let table = createTable({
    playerCount: OPPONENT_COUNT,
    startingStack: STACK,
    smallBlind: 10,
    bigBlind: 20,
    seed,
    difficulty: 'expert',
    challengeMode: true,
    humanName: 'P0',
    localBotNames: ['P1', 'P2', 'P3', 'P4', 'P5'],
    llmSeats: [],
  });
  const archetypes =
    ARCH === 'assign'
      ? assignChallengeArchetypes(seed, table.players.map((player) => player.id))
      : null;
  table = {
    ...table,
    players: table.players.map((player) => ({
      ...player,
      styleId: 0,
      challengeArchetypeId: archetypes?.get(player.id) ?? 0,
    })),
  };
  return table;
}

/** 桌 A：挑战组坐 0/1/2；桌 B：挑战组坐 3/4/5（同 seed 同牌）。 */
async function playSession(seed: string, challengeSeats: readonly number[]): Promise<number[]> {
  let table = createSession(seed);
  const challengeNets: number[] = [];
  for (let h = 0; h < SESSION_HANDS; h++) {
    table = {
      ...table,
      players: table.players.map((player) => ({ ...player, stack: STACK })),
    };
    table.phase = 'handOver';
    table = startNextHand(table);
    if (table.phase === 'gameOver') break;
    const starts = new Map(table.players.map((player) => [player.id, player.stack]));
    let guard = 0;
    while (table.phase === 'playing' && guard++ < 500) {
      const hand = table.hand!;
      const idx = hand.actingIndex!;
      const view = buildPlayerView(hand, hand.players[idx].id, `${seed}-h${h}`);
      const isChallenge = challengeSeats.includes(idx);
      let action: PlayerAction;
      if (isChallenge) {
        action = (await decideNew(view, 'expert', { challenge: true })).action;
      } else if (OPPONENT === 'v030') {
        action = (await decideOld!(view as never, 'expert', {} as never)).action as PlayerAction;
      } else {
        action = (await decideNew(view, 'expert', { challenge: false })).action;
      }
      table = act(table, idx, action);
    }
    let net = 0;
    for (const player of table.players) {
      if (challengeSeats.includes(player.id)) {
        net += player.stack - (starts.get(player.id) ?? 0);
      }
    }
    challengeNets.push(net);
  }
  return challengeNets;
}

if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, '');
}
const records: Record[] = [];
for (let s = 0; s < SEEDS; s++) {
  const seedIndex = SEED_START + s;
  const seed = `h6-${ARCH}-${seedIndex}`;
  const a = await playSession(seed, CHALLENGE_SEATS);
  const b = await playSession(seed, CONTROL_SEATS);
  const hands = Math.min(a.length, b.length);
  for (let h = 0; h < hands; h++) {
    records.push({ seed, hand: h, na: a[h], nb: b[h] });
    if (OUT) appendFileSync(OUT, JSON.stringify(records[records.length - 1]) + '\n');
  }
}

const mean = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / Math.max(1, xs.length);
const diffs = records.map((r) => (r.na + r.nb) / 2);
console.log(
  JSON.stringify({
    opponent: OPPONENT,
    seeds: SEEDS,
    sessionHands: SESSION_HANDS,
    records: records.length,
    handsEquivalent: records.length * 2,
    challengeNetPerHand: Number(mean(diffs).toFixed(2)),
    out: OUT || null,
  }),
);
