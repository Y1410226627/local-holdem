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
import type { Difficulty, PlayerAction, TableState } from '../src/game/types';

type Kind = 'caller' | 'folder' | 'shover';
const HANDS = Number(process.env.HANDS ?? 400);
const KIND = (process.env.KIND ?? 'caller') as Kind;
const DIFF = (process.env.DIFF ?? 'expert') as Difficulty;
const CHALLENGE = process.env.CHALLENGE === '1';
const SEAT = Number(process.env.SEAT ?? 0);
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
  let table: TableState = createTable({
    playerCount: 2, startingStack: STACK, smallBlind: 10, bigBlind: 20,
    seed: `sess-${KIND}-${SEAT}`, difficulty: DIFF, challengeMode: CHALLENGE,
  });
  table.players = table.players.map((p) => ({ ...p, styleId: 0, challengeArchetypeId: 0 }));
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
          ? (await decide(view, DIFF, { maxIterations: 800, challenge: CHALLENGE })).action
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
  seat: SEAT,
  hands: n,
  bbPer100: Number((mean / 20 * 100).toFixed(1)),
  ci95: [
    Number(((mean - 1.96 * se) / 20 * 100).toFixed(1)),
    Number(((mean + 1.96 * se) / 20 * 100).toFixed(1)),
  ],
}));
