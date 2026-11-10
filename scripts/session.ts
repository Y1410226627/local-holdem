/**
 * 连续对局测试台：同一张桌子打 N 手，对手统计会累积（真实牌桌就是这样的）。
 *
 * 为什么必须这样测：旧测试台每手新建一张桌子，`statsRaw` 永远是空的，
 * 机器人根本没有机会观察到「这家伙每手都全下」，只能靠单手尺度猜范围。
 * 这会把「会不会读人」这项能力完全屏蔽掉，测出来的分不代表真实强度。
 */
import { act, createTable, startNextHand } from '../src/game/stateMachine';
import { buildPlayerView } from '../src/game/playerView';
import { decide } from '../src/ai/aiPlayer';
import { assignChallengeArchetypes } from '../src/ai/challenge';
import type { Difficulty, PlayerAction, TableState } from '../src/game/types';

type Kind = 'caller' | 'folder' | 'shover';
const HANDS = Number(process.env.HANDS ?? 400);
const KIND = (process.env.KIND ?? 'caller') as Kind;
const DIFF = (process.env.DIFF ?? 'expert') as Difficulty;
const CHALLENGE = process.env.CHALLENGE === '1';
const SEAT = Number(process.env.SEAT ?? 0);
/** 消融开关：FLOP_BP=1 打开翻牌蓝图；TURN_NET=1 打开转牌价值网络叶子。 */
const FLOP_BP = process.env.FLOP_BP === '1';
/**
 * 蒙特卡洛上限（0 = 不设上限，用各档位自己的 profile 值）。
 *
 * 必须默认 0：`resolveIterations` 取 `min(profile.mcIterations, maxIterations)`。
 * 挑战档 mcIterations=30000、专家档 20000；传 800 会把挑战档的优势整个抹掉，
 * 测出来的「挑战 vs 专家」自然只有 0。真实游戏（`useAiDriver`）对本地 AI 不传这个参数。
 */
const MAX_ITER = Number(process.env.MAX_ITER ?? 0);
/** ARCH=fixed（默认）钉死宗师原型 0；ARCH=assign 按 seed 分配（与 stateMachine.ts 同源）。只改测量面。 */
const ARCH = process.env.ARCH ?? 'fixed';
const STACK = Number(process.env.STACK ?? 1000);

function fixed(kind: Kind, legal: { canCheck: boolean; canCall: boolean; canAllIn: boolean }): PlayerAction {
  if (kind === 'caller') {
    if (legal.canCheck) return { type: 'check' };
    if (legal.canCall) return { type: 'call' };
    return { type: 'fold' };
  }
  if (kind === 'folder') return legal.canCheck ? { type: 'check' } : { type: 'fold' };
  if (legal.canAllIn) return { type: 'allin' };
  if (legal.canCheck) return { type: 'check' };
  if (legal.canCall) return { type: 'call' };
  return { type: 'fold' };
}

async function session(): Promise<number[]> {
  const tableSeed = `sess-${KIND}-${SEAT}-${ARCH}`;
  let table: TableState = createTable({
    playerCount: 2, startingStack: STACK, smallBlind: 10, bigBlind: 20,
    seed: tableSeed, difficulty: DIFF, challengeMode: CHALLENGE,
  });
  // ARCH=assign：按 seed 分配宗师原型（与 stateMachine.ts 同源）；默认 fixed 钉死 0，与历史数字可比。
  const archetypeIds = ARCH === 'assign'
    ? assignChallengeArchetypes(tableSeed, table.players.map((p) => p.id))
    : null;
  table.players = table.players.map((p) => ({
    ...p,
    styleId: 0,
    challengeArchetypeId: archetypeIds ? archetypeIds.get(p.id) ?? 0 : 0,
  }));
  const nets: number[] = [];

  for (let h = 0; h < HANDS; h++) {
    // 每手双方都回到固定筹码：否则赢家筹码越滚越深、输家补码回 1000，
    // 每手的风险金额不同，bb/100 就不再是同一个随机变量（实测两个座位能差 1500 BB/100）。
    // 统计（statsRaw）挂在玩家对象上，不受筹码重置影响，读人能力照常累积。
    table.players = table.players.map((p) => ({ ...p, stack: STACK }));
    table.phase = 'handOver';
    table = startNextHand(table);
    if (table.phase === 'gameOver') break;
    const start = table.handStartStacks[SEAT] ?? 0;

    let guard = 0;
    while (table.phase === 'playing' && guard++ < 400) {
      const hand = table.hand!;
      const idx = hand.actingIndex!;
      const view = buildPlayerView(hand, hand.players[idx].id, `sess-${KIND}-${SEAT}-h${h}`);
      const legal = view.legal!;
      const action =
        idx === SEAT
          ? (await decide(view, DIFF, {
              ...(MAX_ITER > 0 ? { maxIterations: MAX_ITER } : {}),
              challenge: CHALLENGE,
              flopBlueprint: FLOP_BP,
            })).action
          : fixed(KIND, legal);
      table = act(table, idx, action);
    }
    nets.push(table.players[SEAT].stack - start);
  }
  return nets;
}

const nets = await session();
const n = nets.length;
const mean = nets.reduce((a, b) => a + b, 0) / Math.max(1, n);
const varr = nets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
const se = Math.sqrt(varr / Math.max(1, n));
console.log(JSON.stringify({
  version: process.env.VER_TAG ?? 'v0.22',
  difficulty: CHALLENGE ? '挑战宗师' : DIFF,
  opponent: KIND,
  arch: ARCH,
  seat: SEAT,
  hands: n,
  bbPer100: Number((mean / 20 * 100).toFixed(1)),
  ci95: [
    Number(((mean - 1.96 * se) / 20 * 100).toFixed(1)),
    Number(((mean + 1.96 * se) / 20 * 100).toFixed(1)),
  ],
}));
