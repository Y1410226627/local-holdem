/**
 * 新旧版本直接对战：同一个牌桌，座位 0 用当前代码、座位 1 用指定旧版本代码。
 *
 * 为什么需要这个：跟固定对手（跟注站 / 弃牌怪 / 全下怪）打，只能证明「对极端打法更狠」，
 * 不能证明「整体更强」。真正能回答「有没有变强」的，是新版和老版**面对面打**：
 * 同样的牌、同样的座位轮换，净赢筹码就是相对强度差。
 *
 * 用法：
 *   HANDS=800 OLD=1 CHALLENGE=1 npx tsx scripts/head2head.ts
 *
 * 环境变量：
 *   HANDS     每座位手数（总手数 = HANDS × 2）
 *   OLD       老版本是否也用挑战宗师（1=挑战 vs 挑战，0=挑战 vs 专家）
 *   NEW_EXP   新版本用专家档而非挑战档（做「专家 vs 挑战」对照时用）
 *   OLD_DIR   老版本源码目录（默认 D:/德州扑克_old）
 */
import { act, createTable, startNextHand } from '../src/game/stateMachine';
import { buildPlayerView } from '../src/game/playerView';
import { decide as decideNew } from '../src/ai/aiPlayer';
import { decide as decideOld } from '../../德州扑克_old/src/ai/aiPlayer';
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

interface Side {
  challenge: boolean;
  decide: typeof decideNew;
}

async function play(seed: string, newSeat: number): Promise<number> {
  let table: TableState = createTable({
    playerCount: 2, startingStack: STACK, smallBlind: 10, bigBlind: 20, seed,
    difficulty: 'expert', challengeMode: true,
  });
  table.players = table.players.map((p) => ({ ...p, styleId: 0, challengeArchetypeId: 0 }));
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
      maxIterations: 800,
      challenge: side.challenge,
    };
    if (isNew && (NEW_COMBOS > 0 || NEW_ITERS > 0)) {
      options.turnRiver = {
        ...(NEW_COMBOS > 0 ? { maxCombos: NEW_COMBOS } : {}),
        ...(NEW_ITERS > 0 ? { iterations: NEW_ITERS } : {}),
      };
    }
    if (isNew && NEW_FLOP_BP) options.flopBlueprint = true;
    const decision = await (side.decide as typeof decideNew)(view as never, 'expert', options);
    const action: PlayerAction = decision.action;
    table = act(table, idx, action);
  }
  return table.players[newSeat].stack - start;
}

const nets: number[] = [];
for (let h = 0; h < HANDS; h++) {
  const seed = `h2h-${h}`;
  // 同 seed 打两遍、互换座位，消掉牌运与位置偏差
  nets.push(await play(seed, 0));
  nets.push(-(await play(seed, 1)));
}

const n = nets.length;
const mean = nets.reduce((a, b) => a + b, 0) / n;
const varr = nets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
const se = Math.sqrt(varr / n);
const bb = (v: number) => Number((v / 20 * 100).toFixed(1));
console.log(JSON.stringify({
  newTier: NEW_CHALLENGE ? '挑战宗师' : '专家',
  oldTier: OLD_CHALLENGE ? '挑战宗师' : '专家',
  hands: n,
  bbPer100: bb(mean),
  ci95: [bb(mean - 1.96 * se), bb(mean + 1.96 * se)],
}));
