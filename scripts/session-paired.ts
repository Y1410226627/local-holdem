/**
 * 配对消融：同一手牌、同一 seed，跑两臂（特性关 / 特性开），比较**每手差值**。
 *
 * 为什么不用两次独立测量：单臂 800 手的 95% CI 约 ±120 BB/100，
 * 而翻牌蓝图这类特性的效果量级只有 ±20~40，独立测量根本分辨不出来。
 * 配对后两臂共享底牌与公共牌，差值的方差远小于各自的方差。
 *
 * 用法：
 *   HANDS=800 KIND=caller CHALLENGE=1 npx tsx scripts/session-paired.ts
 *
 * 环境变量：
 *   HANDS / KIND / DIFF / SEAT / CHALLENGE  与 session.ts 相同
 *   FLAG=flopBlueprint                      要消融的 AIDecisionOptions 布尔开关
 */
import { act, createTable, startNextHand } from '../src/game/stateMachine';
import { buildPlayerView } from '../src/game/playerView';
import { decide } from '../src/ai/aiPlayer';
import type { AIDecisionOptions } from '../src/ai/aiPlayer';
import type { Difficulty, PlayerAction, TableState } from '../src/game/types';

type Kind = 'caller' | 'folder' | 'shover';
const HANDS = Number(process.env.HANDS ?? 800);
const KIND = (process.env.KIND ?? 'caller') as Kind;
const DIFF = (process.env.DIFF ?? 'expert') as Difficulty;
const CHALLENGE = process.env.CHALLENGE === '1';
const SEAT = Number(process.env.SEAT ?? 0);
const STACK = Number(process.env.STACK ?? 1000);
const FLAG = (process.env.FLAG ?? 'flopBlueprint') as keyof AIDecisionOptions;
/** 数值型消融：转河求解器的组合数（0 = 不覆盖，用默认值）。 */
const COMBOS_OFF = Number(process.env.COMBOS_OFF ?? 0);
const COMBOS_ON = Number(process.env.COMBOS_ON ?? 0);

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

async function runArm(on: boolean): Promise<number[]> {
  let table: TableState = createTable({
    playerCount: 2, startingStack: STACK, smallBlind: 10, bigBlind: 20,
    seed: `paired-${KIND}-${SEAT}`, difficulty: DIFF, challengeMode: CHALLENGE,
  });
  table.players = table.players.map((p) => ({ ...p, styleId: 0, challengeArchetypeId: 0 }));
  const nets: number[] = [];
  for (let h = 0; h < HANDS; h++) {
    table.players = table.players.map((p) => ({ ...p, stack: STACK }));
    table.phase = 'handOver';
    table = startNextHand(table);
    if (table.phase === 'gameOver') break;
    const start = table.handStartStacks[SEAT] ?? 0;
    let guard = 0;
    while (table.phase === 'playing' && guard++ < 400) {
      const hand = table.hand!;
      const idx = hand.actingIndex!;
      const view = buildPlayerView(hand, hand.players[idx].id, `paired-${KIND}-${SEAT}-h${h}`);
      const legal = view.legal!;
      let action: PlayerAction;
      if (idx === SEAT) {
        const options = { challenge: CHALLENGE, [FLAG]: on } as AIDecisionOptions;
        if (COMBOS_OFF > 0 || COMBOS_ON > 0) {
          options.turnRiver = { maxCombos: on ? COMBOS_ON : COMBOS_OFF };
        }
        action = (await decide(view, DIFF, options)).action;
      } else {
        action = fixed(KIND, legal);
      }
      table = act(table, idx, action);
    }
    nets.push(table.players[SEAT].stack - start);
  }
  return nets;
}

const off = await runArm(false);
const on = await runArm(true);
const n = Math.min(off.length, on.length);
const diffs: number[] = [];
for (let i = 0; i < n; i++) diffs.push(on[i] - off[i]);

const mean = (list: number[]) => list.reduce((a, b) => a + b, 0) / Math.max(1, list.length);
const sd = (list: number[]) => {
  const m = mean(list);
  return Math.sqrt(list.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, list.length - 1));
};
const mDiff = mean(diffs);
const seDiff = sd(diffs) / Math.sqrt(Math.max(1, n));
const bb = (v: number) => Number((v / 20 * 100).toFixed(1));

console.log(JSON.stringify({
  flag: COMBOS_ON > 0 ? `turnRiver.maxCombos ${COMBOS_OFF}->${COMBOS_ON}` : FLAG,
  tier: CHALLENGE ? '挑战宗师' : DIFF,
  opponent: KIND,
  seat: SEAT,
  hands: n,
  offBB100: bb(mean(off)),
  onBB100: bb(mean(on)),
  deltaBB100: bb(mDiff),
  deltaCI95: [bb(mDiff - 1.96 * seDiff), bb(mDiff + 1.96 * seDiff)],
  /** 配对带来的方差缩减倍数（越大说明配对越有效） */
  varianceReduction: Number(((sd(off) ** 2 + sd(on) ** 2) / Math.max(1e-9, sd(diffs) ** 2)).toFixed(2)),
}));
