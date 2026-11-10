/**
 * head2head 的可并行分片版本（v0.25.1 起入库）。
 *
 * 与 `scripts/head2head.ts` **语义完全一致**（同样的 seed 命名、同样的对局循环），只多了两件事：
 *   1. 支持 `HAND_START` / `HANDS` 指定 seed 区间（默认 HAND_START=0，HANDS=600，与 head2head 同默认）；
 *   2. 把每局净胜写成 JSONL（`{hand, seed, newSeat, net}`），供 `h2h-combine.ts` 合并。
 *
 * 为什么需要：单进程太慢，80000 局要几小时；多核闲着。分片后每核一片，墙钟时间除以核数。
 * **吞吐取决于档位组合**（实测，口径都是 `NEW_CHALLENGE=1 OLD=0` 的挑战 vs 专家，除非另注）：
 *   · 挑战 vs 专家（一半决策走专家档）：单进程约 **175 局/分钟**；8 进程 **12.5~15 局/秒**；
 *   · 挑战 vs 挑战（两边都跑求解器）：单进程约 **100 局/分钟**，只有前者的一半。
 *   （旧注释写的「192 局/分钟」只对挑战 vs 专家成立，拿它算 8 万局工时会把时间算少一半。）
 * 8 进程已接近饱和，再加进程收益递减——内存带宽和 CPU 抢同一份资源。
 *
 * 用法（8 片并行，每片 500 seed = 1000 局）：
 *   for i in 0 1 2 3 4 5 6 7; do
 *     HAND_START=$((i*500)) HANDS=500 OUT=tmp/h2h-$i.jsonl \
 *       npx tsx scripts/h2h-shard.ts &
 *   done; wait
 *   npx tsx scripts/h2h-combine.ts tmp/h2h-*.jsonl
 *
 * **注意**：分片自己打印的 `ci95` 是旧口径（把同 seed 的两局当独立样本），只用于和
 * 历史数字对账；**结论必须读 `h2h-combine.ts` 的 `pairedBySeed.ci95`**。
 *
 * 环境变量与 head2head.ts 完全相同（OLD / NEW_CHALLENGE / STACK / MAX_ITER / NEW_* ），
 * 另加 HAND_START / HANDS / OUT，以及 ARCH（`fixed`=默认，钉死宗师原型 0，与历史数字可比；
 * `assign`=按 seed 分配 5 个原型，用来量「真实原型分布」下的差距——本脚本每手重抽一张桌子，
 * 所以 assign 得到的是跨原型平均，不是真实游戏里「一张桌子固定一批原型」的分布）。
 */
import { appendFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { act, createTable, startNextHand } from '../src/game/stateMachine';
import { buildPlayerView } from '../src/game/playerView';
import { decide as decideNew } from '../src/ai/aiPlayer';
import { assignChallengeArchetypes } from '../src/ai/challenge';
import type { PlayerAction, TableState } from '../src/game/types';

const HAND_START = Number(process.env.HAND_START ?? 0);
const HANDS = Number(process.env.HANDS ?? 600);
const OLD_DIR = process.env.OLD_DIR ?? '../../德州扑克_old';
const scriptDir = dirname(fileURLToPath(import.meta.url));
const oldDirAbs = isAbsolute(OLD_DIR) ? OLD_DIR : resolve(scriptDir, OLD_DIR);
const oldEntry = join(oldDirAbs, 'src', 'ai', 'aiPlayer.ts');
if (!existsSync(oldEntry)) {
  console.error(`找不到老版本 AI：${oldEntry}\n请设置 OLD_DIR，或用 git worktree add 准备旧版本目录。`);
  process.exit(1);
}
const decideOld = (await import(pathToFileURL(oldEntry).href)).decide as typeof decideNew;
const OLD_CHALLENGE = (process.env.OLD ?? '1') === '1';
const NEW_CHALLENGE = (process.env.NEW_CHALLENGE ?? '1') === '1';
const STACK = Number(process.env.STACK ?? 1000);
const NEW_COMBOS = Number(process.env.NEW_COMBOS ?? 0);
const NEW_ITERS = Number(process.env.NEW_ITERS ?? 0);
const NEW_FLOP_BP = process.env.NEW_FLOP_BP === '1';
const NEW_SBWIDE = process.env.NEW_SBWIDE !== '0';
const NEW_BLUEPRINT = process.env.NEW_BLUEPRINT !== '0';
const NEW_SOLVER = process.env.NEW_SOLVER !== '0';
const NEW_EXPLOIT = process.env.NEW_EXPLOIT !== '0';
const NEW_BP_RANGES = process.env.NEW_BP_RANGES !== '0';
/** NEW_BPGATE=0：关掉翻前蓝图的深度闸门（任何有效筹码都用蓝图，复现 v0.25 行为）。 */
const NEW_BP_GATE = process.env.NEW_BPGATE !== '0';
/** NEW_PF_EXPLOIT=0：关掉「翻前剥削二期」（把对手统计接进蓝图策略分布）。 */
const NEW_PF_EXPLOIT = process.env.NEW_PF_EXPLOIT !== '0';
/** 剥削二期触发面计数（只做统计，不影响决策）。 */
let preflopDecisions = 0;
let preflopExploitHits = 0;
const MAX_ITER = Number(process.env.MAX_ITER ?? 0);
/**
 * ARCH=fixed（默认）钉死宗师原型 = 0，与历史数字可比；
 * ARCH=assign 用 `assignChallengeArchetypes(seed, 座位 id)` 分配，与 `stateMachine.ts` 的 createTable 同源。
 * **只改测量面，不改 AI 行为**；原型只影响挑战档 profile，专家档（旧侧）不受影响。
 * 注意：本脚本每手 createTable 一次，所以分配是「逐手重抽」＝跨原型平均；
 * 真实游戏里一张桌子从头到尾是同一批原型，因此这里对平均强度的估计无偏、但波动更平滑。
 */
const ARCH = process.env.ARCH ?? 'fixed';
const OUT = process.env.OUT ?? '';
/** 写入 JSONL 的配置标识：供 h2h-diff / 事后审计确认两批是同一套开关、同一份代码。 */
const RUN_META = {
  arch: ARCH,
  newChallenge: NEW_CHALLENGE,
  oldChallenge: OLD_CHALLENGE,
  newSolver: NEW_SOLVER,
  newExploit: NEW_EXPLOIT,
  newBlueprint: NEW_BLUEPRINT,
  newBpRanges: NEW_BP_RANGES,
  newBpGate: NEW_BP_GATE,
  newPfExploit: NEW_PF_EXPLOIT,
  newFlopBp: NEW_FLOP_BP,
  newFlop: process.env.NEW_FLOP !== '0',
  oldDir: oldDirAbs,
  stack: STACK,
};

interface Side {
  challenge: boolean;
  decide: typeof decideNew;
}

async function play(seed: string, newSeat: number): Promise<number> {
  let table: TableState = createTable({
    playerCount: 2, startingStack: STACK, smallBlind: 10, bigBlind: 20, seed,
    difficulty: 'expert', challengeMode: true,
  });
  // ARCH=assign：按 seed 给两个座位分配宗师原型（与 stateMachine.ts 的 createTable 同源），
  // 用来量「5 个原型真实分布」下的差距；默认 fixed 仍钉死 0，保证与历史数字可比。
  const archetypeIds = ARCH === 'assign'
    ? assignChallengeArchetypes(seed, table.players.map((p) => p.id))
    : null;
  table.players = table.players.map((p) => ({
    ...p,
    styleId: 0,
    challengeArchetypeId: archetypeIds ? archetypeIds.get(p.id) ?? 0 : 0,
  }));
  table = startNextHand(table);
  const start = table.handStartStacks[newSeat] ?? 0;

  let guard = 0;
  while (table.phase === 'playing' && guard++ < 400) {
    const hand = table.hand!;
    const idx = hand.actingIndex!;
    const view = buildPlayerView(hand, hand.players[idx].id, seed);
    const isNew = idx === newSeat;
    const side: Side = isNew
      ? { challenge: NEW_CHALLENGE, decide: decideNew }
      : { challenge: OLD_CHALLENGE, decide: decideOld };
    const options: Parameters<typeof decideNew>[2] = {
      ...(MAX_ITER > 0 ? { maxIterations: MAX_ITER } : {}),
      challenge: side.challenge,
    };
    if (isNew && (NEW_COMBOS > 0 || NEW_ITERS > 0)) {
      options.turnRiver = {
        ...(NEW_COMBOS > 0 ? { maxCombos: NEW_COMBOS } : {}),
        ...(NEW_ITERS > 0 ? { iterations: NEW_ITERS } : {}),
      };
    }
    if (isNew && NEW_FLOP_BP) options.flopBlueprint = true;
    if (isNew) {
      options.sbWide = NEW_SBWIDE;
      options.blueprint = NEW_BLUEPRINT;
      options.blueprintRanges = NEW_BP_RANGES;
      options.blueprintStackGate = NEW_BP_GATE;
      options.preflopExploitModel = NEW_PF_EXPLOIT;
      options.exploit = NEW_EXPLOIT;
      if (!NEW_SOLVER) {
        options.turnRiver = { ...(options.turnRiver ?? {}), enabled: false };
        options.solver = { ...(options.solver ?? {}), enabled: false };
      }
      // NEW_FLOP=0：消融关闭挑战档翻牌层（对照实验用）。
      if (process.env.NEW_FLOP === '0') options.flopLayer = false;
    }
    const decision = await (side.decide as typeof decideNew)(view as never, 'expert', options);
    // 剥削二期的触发面：翻前决策里有几次真的被对手读人改过（reasoning 带「读人：」）。
    if (isNew && view.street === 'preflop') {
      preflopDecisions += 1;
      if (decision.debug.reasoning.includes('读人：')) preflopExploitHits += 1;
    }
    const action: PlayerAction = decision.action;
    table = act(table, idx, action);
  }
  return table.players[newSeat].stack - start;
}

if (OUT) mkdirSync(dirname(OUT), { recursive: true });
if (OUT) writeFileSync(OUT, '');

const nets: number[] = [];
for (let h = HAND_START; h < HAND_START + HANDS; h++) {
  const seed = `h2h-${h}`;
  const net0 = await play(seed, 0);
  const net1 = -(await play(seed, 1));
  nets.push(net0, net1);
  if (OUT) {
    appendFileSync(OUT, JSON.stringify({ hand: h, seed, newSeat: 0, net: net0, ...RUN_META }) + '\n');
    appendFileSync(OUT, JSON.stringify({ hand: h, seed, newSeat: 1, net: net1, ...RUN_META }) + '\n');
  }
}

// 统计口径与 head2head.ts 的**旧口径**（ci95Naive）逐字相同（ddof=1，bb 保留 1 位）。
// 这是有意保留的：分片单独看没什么意义，配对口径的 CI 由 h2h-combine.ts 统一算。
const n = nets.length;
const mean = nets.reduce((a, b) => a + b, 0) / n;
const varr = nets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
const se = Math.sqrt(varr / n);
const bb = (v: number) => Number((v / 20 * 100).toFixed(1));
console.log(JSON.stringify({
  shard: { handStart: HAND_START, hands: HANDS, out: OUT || null },
  newTier: (NEW_CHALLENGE ? '挑战宗师' : '专家') +
    ` [sbWide=${NEW_SBWIDE} bp=${NEW_BLUEPRINT} bpGate=${NEW_BP_GATE} pfExploit=${NEW_PF_EXPLOIT} solver=${NEW_SOLVER} exploit=${NEW_EXPLOIT} arch=${ARCH}]`,
  oldTier: OLD_CHALLENGE ? '挑战宗师' : '专家',
  hands: n,
  bbPer100: bb(mean),
  ci95: [bb(mean - 1.96 * se), bb(mean + 1.96 * se)],
  preflopExploit: { decisions: preflopDecisions, hits: preflopExploitHits },
  sdChips: Number(Math.sqrt(varr).toFixed(2)),
  sdBB: Number((Math.sqrt(varr) / 20).toFixed(3)),
}));
