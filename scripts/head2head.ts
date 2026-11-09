/**
 * 新旧版本直接对战：同一个牌桌，座位 0 用当前代码、座位 1 用指定旧版本代码。
 *
 * 为什么需要这个：跟固定对手（跟注站 / 弃牌怪 / 全下怪）打，只能证明「对极端打法更狠」，
 * 不能证明「整体更强」。真正能回答「有没有变强」的，是新版和老版**面对面打**：
 * 同样的牌、同样的座位轮换，净赢筹码就是相对强度差。
 *
 * 用法：
 *   HANDS=800 OLD=1 NEW_CHALLENGE=1 npx tsx scripts/head2head.ts     # 挑战 vs 挑战（同档对打）
 *   HANDS=800 OLD=0 NEW_CHALLENGE=1 npx tsx scripts/head2head.ts     # 挑战 vs 专家（默认的「提升」对照）
 *
 * 环境变量：
 *   HANDS           seed 个数（总手数 = HANDS × 2，每个 seed 换座位打两局）
 *   OLD            老版本是否也用挑战宗师（默认 1 = 挑战 vs 挑战；0 = 挑战 vs 专家）
 *   NEW_CHALLENGE  新版本是否用挑战宗师（默认 1；设 0 可做「专家 vs 挑战」反向对照）
 *   STACK / MAX_ITER / NEW_COMBOS / NEW_ITERS / NEW_FLOP_BP / NEW_SBWIDE /
 *   NEW_BLUEPRINT / NEW_BP_RANGES / NEW_BPGATE / NEW_PF_EXPLOIT / NEW_SOLVER / NEW_EXPLOIT 见下面各自定义
 *
 * 老版本源码目录**写死**在 import 里（`../../德州扑克_old`），换目录要改 import；
 * 不存在 `OLD_DIR` 环境变量，也不存在 `NEW_EXP`（要反向对照用 `NEW_CHALLENGE=0`）。
 *
 * 输出字段：
 *   seeds / games            seed 个数 / 总局数（= seeds × 2）
 *   bbPer100                 点估计（两局平均，BB/100）
 *   ci95                     **正确口径**：按 seed 配对求标准误（v0.25.1 起）
 *   corrSameSeed             同 seed 两局的相关系数 ρ（ρ=1 说明换座位没有产生新信息）
 *   ci95Naive                旧口径（把 2H 局当独立样本），只用于和历史数字逐位对账
 */
import { act, createTable, startNextHand } from '../src/game/stateMachine';
import { buildPlayerView } from '../src/game/playerView';
import { decide as decideNew } from '../src/ai/aiPlayer';
import { decide as decideOld } from '../../德州扑克_old/src/ai/aiPlayer';
import { assignChallengeArchetypes } from '../src/ai/challenge';
import type { PlayerAction, TableState } from '../src/game/types';

const HANDS = Number(process.env.HANDS ?? 600);
const OLD_CHALLENGE = (process.env.OLD ?? '1') === '1';
const NEW_CHALLENGE = (process.env.NEW_CHALLENGE ?? '1') === '1';
const STACK = Number(process.env.STACK ?? 1000);
/** 新版转河求解器组合数（0 = 用默认 24）；老版始终用默认值。 */
const NEW_COMBOS = Number(process.env.NEW_COMBOS ?? 0);
const NEW_ITERS = Number(process.env.NEW_ITERS ?? 0);
/** 新版是否启用翻牌蓝图。 */
const NEW_FLOP_BP = process.env.NEW_FLOP_BP === '1';
/** 逐层消融：把某个挑战档专属层关掉（'0' = 关）。 */
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
/**
 * ARCH=fixed（默认）钉死宗师原型 = 0，与历史数字可比；
 * ARCH=assign 用 `assignChallengeArchetypes(seed, 座位 id)` 分配（与 `stateMachine.ts` 同源）。
 * 只改测量面，不改 AI 行为；原型只影响挑战档，专家档不受影响。
 */
const ARCH = process.env.ARCH ?? 'fixed';
/**
 * 蒙特卡洛上限（0 = 不设上限，用各档位自己的 profile 值）。
 *
 * 这里必须默认 0：`resolveIterations` 取 `min(profile.mcIterations, maxIterations)`，
 * 而挑战档的 mcIterations 是 30000、专家档 20000。旧测试台一律传 800，
 * 等于把挑战档的蒙特卡洛优势整个抹掉——测出来的「挑战 vs 专家」自然只有 0。
 */
const MAX_ITER = Number(process.env.MAX_ITER ?? 0);

interface Side {
  challenge: boolean;
  decide: typeof decideNew;
}

async function play(seed: string, newSeat: number): Promise<number> {
  let table: TableState = createTable({
    playerCount: 2, startingStack: STACK, smallBlind: 10, bigBlind: 20, seed,
    difficulty: 'expert', challengeMode: true,
  });
  // 与 `h2h-shard.ts` 逐字一致：ARCH=assign 按 seed 分配宗师原型，默认 fixed 钉死 0。
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
    // 两边读同一个 view；老版本的 PlayerView 类型少一个可选字段，运行时完全兼容
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
      if (!NEW_SOLVER) options.turnRiver = { ...(options.turnRiver ?? {}), enabled: false };
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

/**
 * 每个 seed 的两局（换座位）记成一对。
 *
 * 为什么不能像旧实现那样把两局当两个独立样本：同 seed 用的是同一副牌，两局净胜强正相关。
 * 极端情形是「两边同档同代码」——实测 1500/1500 手 `net(seat0) === net(seat1)` 逐位相等，
 * ρ 恰好 = 1，换座位根本没有产生新信息，旧公式 `sd/√(2H)` 把 CI 低估了 √2；
 * 挑战 vs 专家实测 ρ ≈ 0.41，旧公式低估约 19%。（2026-11-08 复核，见 v0.25.1）
 *
 * 正确做法：把每对的两局取平均当作一个观测，对 H 个观测求标准误。
 * 这样 ρ=1 时自动退化成 `sd/√H`，ρ=0 时自动等价于 `sd/√(2H)`，不需要单独估 ρ。
 */
const pairs: Array<[number, number]> = [];
for (let h = 0; h < HANDS; h++) {
  const seed = `h2h-${h}`;
  const seat0 = await play(seed, 0);
  const seat1 = -(await play(seed, 1));
  pairs.push([seat0, seat1]);
}

const n = pairs.length * 2;
const pairMeans = pairs.map(([a, b]) => (a + b) / 2);
const H = pairMeans.length;
const mean = pairMeans.reduce((a, b) => a + b, 0) / H;
const varr = pairMeans.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, H - 1);
const se = Math.sqrt(varr / H);

// 旧口径（把 2H 局当独立样本）仍然输出，方便和历史数字逐位对账。
const flat = pairs.flat();
const flatMean = flat.reduce((a, b) => a + b, 0) / flat.length;
const flatVar = flat.reduce((a, b) => a + (b - flatMean) ** 2, 0) / Math.max(1, flat.length - 1);
const seNaive = Math.sqrt(flatVar / flat.length);

// 同 seed 两局的相关系数：ρ=1 说明这批对局的两局完全重复（同档对打的常态）。
const xs = pairs.map(([a]) => a);
const ys = pairs.map(([, b]) => b);
const mx = xs.reduce((a, b) => a + b, 0) / H;
const my = ys.reduce((a, b) => a + b, 0) / H;
let cov = 0;
let vx = 0;
let vy = 0;
for (let i = 0; i < H; i++) {
  cov += (xs[i] - mx) * (ys[i] - my);
  vx += (xs[i] - mx) ** 2;
  vy += (ys[i] - my) ** 2;
}
const corr = cov / Math.max(1e-12, Math.sqrt(vx * vy));

const bb = (v: number) => Number((v / 20 * 100).toFixed(1));
console.log(JSON.stringify({
  newTier: (NEW_CHALLENGE ? '挑战宗师' : '专家') +
    ` [sbWide=${NEW_SBWIDE} bp=${NEW_BLUEPRINT} bpGate=${NEW_BP_GATE} pfExploit=${NEW_PF_EXPLOIT} solver=${NEW_SOLVER} exploit=${NEW_EXPLOIT} arch=${ARCH}]`,
  oldTier: OLD_CHALLENGE ? '挑战宗师' : '专家',
  seeds: H,
  games: n,
  bbPer100: bb(mean),
  ci95: [bb(mean - 1.96 * se), bb(mean + 1.96 * se)],
  preflopExploit: { decisions: preflopDecisions, hits: preflopExploitHits },
  corrSameSeed: Number(corr.toFixed(4)),
  ci95Naive: [bb(flatMean - 1.96 * seNaive), bb(flatMean + 1.96 * seNaive)],
}));
