/**
 * HLB（Human-Like Bot）差分测量台：6 个**完全确定性**的脚本化对手，复刻 §4.2 记录的真人漏洞。
 *
 * 为什么不入 `_diag-*` 那一类：PRD P0-1 与设计 T4 的验收条件直接引用本脚本
 * （「挑战档对每个 bot 点估计 ≥ 0 / 差分 CI 上界 < 0 即判负」），它属于**验收工具**而不是一次性诊断。
 *
 * 为什么需要它：现有三档固定对手（跟注站 / 弃牌怪 / 全下怪）是「极端打法」，只能回答
 * 「对极端打法够不够狠」，不能代理「真人会不会剥削我们」。这 6 个 bot 针对的都是
 * **本项目自己已证实存在的模式化漏洞**（3-bet 后放弃、转牌不给压力、河牌抓不住诈唬……），
 * 它们能赢多少，就是「一个有点经验的真人」能赢多少的下界代理。
 *
 * 口径与 `scripts/session.ts` **完全一致**（同一张桌子连打 N 手、每手双方重置 50BB、
 * statsRaw 跨手累积、不设蒙特卡洛上限）：
 *   · 两边都不传 maxIterations（否则会抹掉挑战档的蒙特卡洛优势）
 *   · hero 侧走 `decide()`（CHALLENGE=1 挑战宗师 / 0 专家），bot 侧走本文件的纯函数
 *   · 每手净胜写 JSONL，供 `hlb-compare.ts` 做**逐手配对差分**（两档必须跑同一批牌）
 *
 * 用法：
 *   BOT=three-bet-caller CHALLENGE=1 HANDS=1800 SEAT=0 OUT=tmp/hlb-3bc-ch.jsonl \
 *     npx tsx scripts/hlb-bots.ts
 *   BOT=three-bet-caller CHALLENGE=0 HANDS=1800 SEAT=0 OUT=tmp/hlb-3bc-ex.jsonl \
 *     npx tsx scripts/hlb-bots.ts
 *   npx tsx scripts/hlb-compare.ts tmp/hlb-3bc-ch.jsonl tmp/hlb-3bc-ex.jsonl
 *
 * **确定性自检**（同命令两次必须逐位相同，改 bot 逻辑后必跑）：
 *   BOT=polarized CHALLENGE=1 HANDS=50 OUT=tmp/a.jsonl npx tsx scripts/hlb-bots.ts
 *   BOT=polarized CHALLENGE=1 HANDS=50 OUT=tmp/b.jsonl npx tsx scripts/hlb-bots.ts
 *   diff tmp/a.jsonl tmp/b.jsonl        # 必须无输出（Windows 下没有 /tmp，用仓库里的 tmp/）
 *
 * 环境变量：BOT / HANDS / CHALLENGE / SEAT / OUT / STACK / DIFF
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { act, createTable, startNextHand } from '../src/game/stateMachine';
import { buildPlayerView, type PlayerView } from '../src/game/playerView';
import { decide } from '../src/ai/aiPlayer';
import { DIFFICULTY_PROFILES } from '../src/ai/difficulty';
import { evaluate, HAND_CATEGORY } from '../src/game/handEvaluator';
import type { Difficulty, PlayerAction, TableState } from '../src/game/types';

type BotId =
  | 'three-bet-caller'   // 跟 3-bet，翻牌未中即弃（§4.2 的真实漏洞）
  | 'turn-barrel'        // 转牌对手过牌即满池，被加注即弃
  | 'river-station'      // 河牌对 ≤2/3 池下注一律跟注
  | 'sb-limper'          // SB 100% 跛入，仅成牌下注
  | 'polarized'          // 两对及以上才加注，其余过牌 / 弃牌
  | 'mdf-dev';           // 专家档 + 跟注线下移 20%（callMargin 0.05→0.04）

const BOT = (process.env.BOT ?? 'three-bet-caller') as BotId;
const HANDS = Number(process.env.HANDS ?? 800);
const CHALLENGE = process.env.CHALLENGE === '1';
const SEAT = Number(process.env.SEAT ?? 0);
const STACK = Number(process.env.STACK ?? 1000);
const DIFF = (process.env.DIFF ?? 'expert') as Difficulty;
const OUT = process.env.OUT ?? '';

/** 把「加到」金额夹到合法区间；全下也走这里。 */
function raiseTo(view: PlayerView, target: number): PlayerAction {
  const legal = view.legal!;
  const min = legal.minRaiseTo;
  const max = legal.maxRaiseTo;
  const amount = Math.max(min, Math.min(max, Math.round(target)));
  return legal.canBet ? { type: 'bet', amount } : { type: 'raise', amount };
}

/** 按底池比例下注；没有下注权时返回 null。 */
function betFraction(view: PlayerView, frac: number): PlayerAction | null {
  const legal = view.legal!;
  if (!legal.canBet && !legal.canRaise) return null;
  const target = legal.canBet
    ? view.pot * frac
    : view.currentBet + (view.pot + view.currentBet) * frac;
  return raiseTo(view, target);
}

/** 当前成牌类别（翻牌前返回 -1）。只用**自己**的底牌 + 公共牌，不读对手。 */
function madeCategory(view: PlayerView): number {
  if (view.board.length < 3) return -1;
  return evaluate([...view.self.holeCards, ...view.board]).category;
}

/** 面对下注时的「跟注成本占底池比」。 */
function callRatio(view: PlayerView): number {
  const legal = view.legal!;
  if (legal.callAmount <= 0) return 0;
  return legal.callAmount / Math.max(1, view.pot + legal.callAmount);
}

/** 被动的默认线路：能过牌就过牌，小额跟注，大额弃牌。 */
function passive(view: PlayerView, maxRatio = 0.5): PlayerAction {
  const legal = view.legal!;
  if (legal.canCheck) return { type: 'check' };
  if (legal.canCall && callRatio(view) <= maxRatio) return { type: 'call' };
  return { type: 'fold' };
}

// ---------------------------------------------------------------- 6 个 bot

/** 1) 跟 3-bet，翻牌未中即弃：翻前从不加注也从不弃牌；翻后没成对就弃，成对就跟/小注。 */
function threeBetCaller(view: PlayerView): PlayerAction {
  const legal = view.legal!;
  const made = madeCategory(view);
  if (made < 0) return legal.canCheck ? { type: 'check' } : { type: 'call' };
  if (made === HAND_CATEGORY.HIGH_CARD) {
    return legal.canCheck ? { type: 'check' } : { type: 'fold' };
  }
  if (legal.canCheck) return betFraction(view, 0.5) ?? { type: 'check' };
  return { type: 'call' };
}

/** 2) 转牌双管剥削者：转牌上对手过牌就满池，被下注/被加注立刻弃；其余街被动。 */
function turnBarrel(view: PlayerView): PlayerAction {
  const legal = view.legal!;
  if (view.street === 'turn') {
    if (legal.canBet) return betFraction(view, 1) ?? { type: 'check' };
    if (legal.callAmount > 0) return { type: 'fold' };
    return { type: 'check' };
  }
  return passive(view);
}

/** 3) 河牌抓诈站：河牌对 ≤2/3 池的下注一律跟注，更大的弃；前街只跟小额。 */
function riverStation(view: PlayerView): PlayerAction {
  const legal = view.legal!;
  if (view.street === 'river') {
    if (legal.canCheck) return { type: 'check' };
    return callRatio(view) <= 2 / 3 ? { type: 'call' } : { type: 'fold' };
  }
  return passive(view, 0.5);
}

/** 4) 无位置跛入者：翻前永远不加注（100% 跛入 / 过牌），翻后仅在成对及以上时下注。 */
function sbLimper(view: PlayerView): PlayerAction {
  const legal = view.legal!;
  const made = madeCategory(view);
  if (made < 0) return legal.canCheck ? { type: 'check' } : { type: 'call' };
  if (made >= HAND_CATEGORY.PAIR) {
    if (legal.canCheck) return betFraction(view, 0.5) ?? { type: 'check' };
    return { type: 'call' };
  }
  return legal.canCheck ? { type: 'check' } : { type: 'fold' };
}

/**
 * 5) 强弱二分者：两对及以上才下注 / 加注（视为「坚果」），其余过牌或弃牌。
 * 没有中间档——这正是它可被剥削的地方（我们一加注它就弃）。
 */
function polarized(view: PlayerView): PlayerAction {
  const legal = view.legal!;
  const made = madeCategory(view);
  if (made < 0) return legal.canCheck ? { type: 'check' } : { type: 'call' };
  if (made >= HAND_CATEGORY.TWO_PAIR) {
    return betFraction(view, 1) ?? (legal.canCheck ? { type: 'check' } : { type: 'call' });
  }
  return legal.canCheck ? { type: 'check' } : { type: 'fold' };
}

/** 6) MDJ 偏离者：专家档，仅把跟注线下移 20%（callMargin 0.05 → 0.04），其余完全不变。 */
const MDF_PROFILE = {
  ...DIFFICULTY_PROFILES.expert,
  key: 'expert' as const,
  postflop: { ...DIFFICULTY_PROFILES.expert.postflop, callMargin: 0.04 },
};

async function mdfDev(view: PlayerView): Promise<PlayerAction> {
  const decision = await decide(view, 'expert', { profileOverride: MDF_PROFILE });
  return decision.action;
}

const SYNCHRONOUS_BOTS: Record<Exclude<BotId, 'mdf-dev'>, (v: PlayerView) => PlayerAction> = {
  'three-bet-caller': threeBetCaller,
  'turn-barrel': turnBarrel,
  'river-station': riverStation,
  'sb-limper': sbLimper,
  'polarized': polarized,
};

async function botAction(view: PlayerView): Promise<PlayerAction> {
  if (BOT === 'mdf-dev') return mdfDev(view);
  return SYNCHRONOUS_BOTS[BOT](view);
}

// ---------------------------------------------------------------- 对局循环

async function session(): Promise<number[]> {
  let table: TableState = createTable({
    playerCount: 2, startingStack: STACK, smallBlind: 10, bigBlind: 20,
    // seed 不含 CHALLENGE：挑战档与专家档必须跑**同一批牌**，才能做配对差分
    seed: `hlb-${BOT}-${SEAT}`, difficulty: DIFF, challengeMode: CHALLENGE,
  });
  table.players = table.players.map((p) => ({ ...p, styleId: 0, challengeArchetypeId: 0 }));
  const nets: number[] = [];

  for (let h = 0; h < HANDS; h++) {
    // 每手双方回到固定筹码（与 session.ts 同口径）：保证每手是同一个随机变量
    table.players = table.players.map((p) => ({ ...p, stack: STACK }));
    table.phase = 'handOver';
    table = startNextHand(table);
    if (table.phase === 'gameOver') break;
    const start = table.handStartStacks[SEAT] ?? 0;

    let guard = 0;
    while (table.phase === 'playing' && guard++ < 400) {
      const hand = table.hand!;
      const idx = hand.actingIndex!;
      const view = buildPlayerView(hand, hand.players[idx].id, `hlb-${BOT}-${SEAT}-h${h}`);
      const action =
        idx === SEAT
          ? (await decide(view, DIFF, { challenge: CHALLENGE })).action
          : await botAction(view);
      table = act(table, idx, action);
    }
    nets.push(table.players[SEAT].stack - start);
  }
  return nets;
}

if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, '');
}

const nets = await session();
if (OUT) {
  for (let h = 0; h < nets.length; h++) {
    appendFileSync(OUT, JSON.stringify({ hand: h, bot: BOT, challenge: CHALLENGE ? 1 : 0, net: nets[h] }) + '\n');
  }
}

const n = nets.length;
const mean = nets.reduce((a, b) => a + b, 0) / Math.max(1, n);
const varr = nets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
const se = Math.sqrt(varr / Math.max(1, n));
console.log(JSON.stringify({
  version: process.env.VER_TAG ?? 'v0.25.1',
  bot: BOT,
  difficulty: CHALLENGE ? '挑战宗师' : DIFF,
  seat: SEAT,
  hands: n,
  bbPer100: Number((mean / 20 * 100).toFixed(1)),
  ci95: [
    Number(((mean - 1.96 * se) / 20 * 100).toFixed(1)),
    Number(((mean + 1.96 * se) / 20 * 100).toFixed(1)),
  ],
  sdBB: Number((Math.sqrt(varr) / 20).toFixed(2)),
  out: OUT || null,
}));
