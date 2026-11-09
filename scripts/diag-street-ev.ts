/**
 * 诊断台：我方（挑战档宗师）在会话模式对打里的「钱漏在哪」。
 *
 * 与 `scripts/session-h2h.ts` 完全同一牌局推进路径（桌子 / seed / 行为参数都不动），
 * 只额外**只读**记录每手的过程统计，按桶输出 样本数 / 均值 / 95% CI。
 *
 * 单位：BB（1 BB = bigBlind 筹码）；均值按「每手」为独立单位。
 *
 * 用法：
 *   HANDS=3000 EXPERT_SEAT=1 ARCH=assign npx tsx scripts/diag-street-ev.ts
 *   HANDS=3000 EXPERT_SEAT=0 ARCH=assign npx tsx scripts/diag-street-ev.ts
 * 输出最后一行是 JSON（机器可读），其余为人类可读表格。
 */
import { act, createTable, startNextHand } from '../src/game/stateMachine';
import { buildPlayerView } from '../src/game/playerView';
import { decide } from '../src/ai/aiPlayer';
import { assignChallengeArchetypes } from '../src/ai/challenge';
import type { ActionRecord, Street, TableState } from '../src/game/types';

const HANDS = Number(process.env.HANDS ?? 3000);
const STACK = Number(process.env.STACK ?? 1000);
const ARCH = process.env.ARCH ?? 'assign';
const EXPERT_SEAT = Number(process.env.EXPERT_SEAT ?? 1);
const CH_SEAT = 1 - EXPERT_SEAT;
const BB = 20;

const challengeOptions = {
  challenge: true,
  ...(process.env.NEW_FLOP === '0' ? { flopLayer: false } : {}),
  ...(process.env.NEW_PF_EXPLOIT === '0' ? { preflopExploitModel: false } : {}),
  ...(process.env.NEW_BPGATE === '0' ? { blueprintStackGate: false } : {}),
};

const STREETS: Street[] = ['preflop', 'flop', 'turn', 'river'];

interface HandRec {
  handNo: number;
  /** 结束街 */
  endStreet: Street;
  showdown: boolean;
  foldedWin: boolean;
  /** 我方净赢（BB） */
  net: number;
  /** 最终底池（BB） */
  potBB: number;
  /** 我方本手总投入（BB） */
  investedBB: number;
  /** 我方本手拿到钱（BB） */
  wonBB: number;
  /** 我方是否在摊牌中获胜 */
  sdWin: boolean;
  /** 我方最后一个「面对下注」决策的动作类型 */
  lastFace: 'call' | 'fold' | 'raise' | 'allin' | null;
  /** 我方最后一个「面对下注」决策所在街 */
  lastFaceStreet: Street | null;
  /** 我方在面对下注时 call / fold 的次数 */
  faceCalls: number;
  faceFolds: number;
  /** 分街的 call / fold 次数 */
  faceCallsByStreet: Record<Street, number>;
  faceFoldsByStreet: Record<Street, number>;
  /** 我方摊牌时的牌力名次（categoryName），非摊牌为 null */
  sdCategory: string | null;
  /** 我方各街投入（BB） */
  investedByStreet: Record<Street, number>;
  /** 我方各街主动下注/加注次数 */
  aggrByStreet: Record<Street, number>;
  /** 我方各街决策次数 */
  decisionsByStreet: Record<Street, number>;
  /** 我方各街下注/加注后，对手在同一街立刻弃牌的次数 / 机会数 */
  immFoldByStreet: Record<Street, { fold: number; chance: number }>;
  /** 我方是否见过翻牌 / 转牌 / 河牌 */
  sawFlop: boolean;
  sawTurn: boolean;
  sawRiver: boolean;
  /** 我方本手是否在按钮位（单挑时 = 小盲/庄家） */
  isButton: boolean;
  /** 翻前最后一个进攻动作是谁做的 */
  pfAggressor: 'me' | 'opp' | 'none';
}

interface Agg {
  n: number;
  mean: number;
  se: number;
  ci: [number, number];
}

function agg(xs: number[]): Agg {
  const n = xs.length;
  if (n === 0) return { n: 0, mean: NaN, se: NaN, ci: [NaN, NaN] };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const varr = n > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const se = Math.sqrt(varr / Math.max(1, n));
  return { n, mean, se, ci: [mean - 1.96 * se, mean + 1.96 * se] };
}

const fmt = (v: number, d = 1): string => (Number.isFinite(v) ? v.toFixed(d) : '—');

function line(label: string, xs: number[], note = ''): string {
  const a = agg(xs);
  const flag = a.n < 200 ? ' ⚠样本不足' : '';
  return (
    `${label.padEnd(26, ' ')} n=${String(a.n).padStart(5)}  ` +
    `均值 ${fmt(a.mean).padStart(7)} BB/手 (${fmt((a.mean / BB) * 100, 0).padStart(6)} BB/100)  ` +
    `95%CI [${fmt(a.ci[0], 1)}, ${fmt(a.ci[1], 1)}]${flag}${note ? '  ' + note : ''}`
  );
}

function emptyByStreet<T>(v: () => T): Record<Street, T> {
  return { preflop: v(), flop: v(), turn: v(), river: v() };
}

/** 从 action 记录重建「每次决策前的当前注额」，用于判断是否面对下注。 */
function analyzeActions(
  actions: ActionRecord[],
  me: number,
): {
  lastFace: HandRec['lastFace'];
  lastFaceStreet: Street | null;
  faceCalls: number;
  faceFolds: number;
  faceCallsByStreet: Record<Street, number>;
  faceFoldsByStreet: Record<Street, number>;
  investedByStreet: Record<Street, number>;
  aggrByStreet: Record<Street, number>;
  decisionsByStreet: Record<Street, number>;
  immFoldByStreet: Record<Street, { fold: number; chance: number }>;
} {
  let curBet: Record<Street, number> = { preflop: 0, flop: 0, turn: 0, river: 0 };
  let lastFace: HandRec['lastFace'] = null;
  let lastFaceStreet: Street | null = null;
  let faceCalls = 0;
  let faceFolds = 0;
  const faceCallsByStreet = emptyByStreet(() => 0);
  const faceFoldsByStreet = emptyByStreet(() => 0);
  const investedByStreet = emptyByStreet(() => 0);
  const aggrByStreet = emptyByStreet(() => 0);
  const decisionsByStreet = emptyByStreet(() => 0);
  const immFoldByStreet = emptyByStreet(() => ({ fold: 0, chance: 0 }));

  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const st = a.street;
    const mine = a.actorId === me;
    const facing = curBet[st] > 0;
    const t = a.action.type;

    if (mine) {
      decisionsByStreet[st] += 1;
      investedByStreet[st] += a.paid / BB;
      if (t === 'call' && facing) {
        faceCalls += 1;
        faceCallsByStreet[st] += 1;
        lastFace = 'call';
        lastFaceStreet = st;
      } else if (t === 'fold') {
        faceFolds += 1;
        faceFoldsByStreet[st] += 1;
        lastFace = 'fold';
        lastFaceStreet = st;
      } else if (t === 'raise') {
        lastFace = 'raise';
        lastFaceStreet = facing ? st : lastFaceStreet;
      } else if (t === 'allin') {
        lastFace = 'allin';
        lastFaceStreet = facing ? st : lastFaceStreet;
      }
      if (t === 'bet' || t === 'raise' || t === 'allin') {
        aggrByStreet[st] += 1;
        // 对手是否在同一街立刻弃牌
        const nxt = actions.slice(i + 1).find((x) => x.street === st && x.actorId !== me);
        if (nxt) {
          immFoldByStreet[st].chance += 1;
          if (nxt.action.type === 'fold') immFoldByStreet[st].fold += 1;
        }
      }
    }

    if (t === 'bet' || t === 'raise' || t === 'allin') {
      curBet[st] = a.toAmount;
    }
  }
  return {
    lastFace,
    lastFaceStreet,
    faceCalls,
    faceFolds,
    faceCallsByStreet,
    faceFoldsByStreet,
    investedByStreet,
    aggrByStreet,
    decisionsByStreet,
    immFoldByStreet,
  };
}

async function run(): Promise<HandRec[]> {
  const tableSeed = `sess-h2h-${EXPERT_SEAT}-${ARCH}`; // 与 session-h2h 完全一致
  let table: TableState = createTable({
    playerCount: 2,
    startingStack: STACK,
    smallBlind: 10,
    bigBlind: 20,
    seed: tableSeed,
    difficulty: 'expert',
    challengeMode: true,
  });

  const archetypeIds =
    ARCH === 'assign'
      ? assignChallengeArchetypes(tableSeed, table.players.map((p) => p.id))
      : null;
  table.players = table.players.map((p) => ({
    ...p,
    styleId: 0,
    challengeArchetypeId: archetypeIds ? archetypeIds.get(p.id) ?? 0 : 0,
  }));

  const recs: HandRec[] = [];
  const nets: number[] = [];
  const t0 = Date.now();

  for (let h = 0; h < HANDS; h++) {
    table.players = table.players.map((p) => ({ ...p, stack: STACK }));
    table.phase = 'handOver';
    table = startNextHand(table);
    if (table.phase === 'gameOver') break;

    const start = table.handStartStacks[CH_SEAT] ?? 0;
    let guard = 0;
    while (table.phase === 'playing' && guard++ < 400) {
      const hand = table.hand!;
      const idx = hand.actingIndex!;
      const view = buildPlayerView(hand, hand.players[idx].id, `${tableSeed}-h${h}`);
      const action =
        idx === CH_SEAT
          ? (await decide(view, 'expert', challengeOptions)).action
          : (await decide(view, 'expert', { challenge: false })).action;
      table = act(table, idx, action);
    }

    const hand = table.hand!;
    const myIdx = hand.players.findIndex((p) => p.id === CH_SEAT);
    const me = hand.players[myIdx];
    const net = table.players[CH_SEAT].stack - start;
    nets.push(net);

    const payout =
      (hand.result?.pots ?? []).reduce(
        (s, p) => s + p.payouts.filter((x) => x.playerId === me.id).reduce((a, b) => a + b.amount, 0),
        0,
      ) + (hand.result?.refunds ?? []).filter((x) => x.playerId === me.id).reduce((a, b) => a + b.amount, 0);

    const sdEntry = hand.result?.showdown?.find((e) => e.playerId === me.id) ?? null;
    const a = analyzeActions(hand.actions, me.id);

    recs.push({
      handNo: hand.handNo,
      endStreet: hand.street,
      showdown: !!hand.result?.showdown,
      foldedWin: !!hand.result?.foldedWin,
      net: net / BB,
      potBB: (hand.result?.pots ?? []).reduce((s, p) => s + p.amount, 0) / BB,
      investedBB: me.totalCommitted / BB,
      wonBB: payout / BB,
      sdWin: !!sdEntry?.isWinner,
      sdCategory: sdEntry?.categoryName ?? null,
      ...a,
      sawFlop: hand.board.length >= 3,
      sawTurn: hand.board.length >= 4,
      sawRiver: hand.board.length >= 5,
      isButton: hand.buttonIndex === myIdx,
      pfAggressor: (() => {
        const pf = hand.actions.filter((x) => x.street === 'preflop' && (x.action.type === 'bet' || x.action.type === 'raise' || x.action.type === 'allin'));
        if (pf.length === 0) return 'none' as const;
        return pf[pf.length - 1].actorId === me.id ? ('me' as const) : ('opp' as const);
      })(),
    });

    if ((h + 1) % 500 === 0) {
      const done = nets.reduce((x, y) => x + y, 0);
      const bb100 = (done / (h + 1) / BB) * 100;
      const mins = ((Date.now() - t0) / 60000).toFixed(1);
      console.log(
        `[${new Date().toISOString().slice(11, 19)}] ${h + 1}/${HANDS} 手 (${mins}min)  ` +
          `累计 ${done} 筹码  平均 ${bb100.toFixed(1)} BB/100`,
      );
    }
  }
  return recs;
}

const recs = await run();
const n = recs.length;
const all = recs.map((r) => r.net);

console.log('\n===== 0. 总览 =====');
console.log(`手数 ${n}  座位 EXPERT_SEAT=${EXPERT_SEAT} / 我方 CH_SEAT=${CH_SEAT}  ARCH=${ARCH}`);
console.log(line('全部手牌', all));

console.log('\n===== 1. 按「结束街 + 是否摊牌」分桶 =====');
const buckets: Array<[string, (r: HandRec) => boolean]> = [
  ['翻前就结束(未见翻牌)', (r) => !r.sawFlop],
  ['翻牌街结束', (r) => r.sawFlop && !r.sawTurn],
  ['转牌街结束', (r) => r.sawTurn && !r.sawRiver],
  ['河牌街结束(未摊牌)', (r) => r.sawRiver && !r.showdown],
  ['摊牌', (r) => r.showdown],
];
for (const [label, f] of buckets) console.log(line(label, recs.filter(f).map((r) => r.net)));

console.log('\n--- 摊牌里再分：我方赢/输 ---');
console.log(line('摊牌且我方赢', recs.filter((r) => r.showdown && r.sdWin).map((r) => r.net)));
console.log(line('摊牌且我方输', recs.filter((r) => r.showdown && !r.sdWin).map((r) => r.net)));

console.log('\n===== 2. 我方投入筹码去哪了（描述性，非盈亏） =====');
for (const st of STREETS) {
  const tot = recs.reduce((s, r) => s + r.investedByStreet[st], 0);
  const hands = recs.filter((r) => r.investedByStreet[st] > 0).length;
  console.log(
    `  ${st.padEnd(8)} 总投入 ${tot.toFixed(0).padStart(6)} BB  涉及 ${String(hands).padStart(5)} 手  ` +
      `平均每次决策 ${(tot / Math.max(1, recs.reduce((s, r) => s + r.decisionsByStreet[st], 0))).toFixed(2)} BB`,
  );
}

console.log('\n===== 3. 按最终底池大小分桶 =====');
const potBuckets: Array<[string, (r: HandRec) => boolean]> = [
  ['小池 <8BB', (r) => r.potBB < 8],
  ['中池 8~30BB', (r) => r.potBB >= 8 && r.potBB < 30],
  ['大池 30~100BB', (r) => r.potBB >= 30 && r.potBB < 100],
  ['巨池 >=100BB(全下)', (r) => r.potBB >= 100],
];
for (const [label, f] of potBuckets) console.log(line(label, recs.filter(f).map((r) => r.net)));

console.log('\n===== 4. 摊牌质量 =====');
const sds = recs.filter((r) => r.showdown);
const sdWins = sds.filter((r) => r.sdWin);
const sdLoss = sds.filter((r) => !r.sdWin);
console.log(
  `  摊牌 ${sds.length} 次 (占 ${((sds.length / n) * 100).toFixed(1)}%)  我方赢 ${sdWins.length} 次  ` +
    `胜率 ${((sdWins.length / Math.max(1, sds.length)) * 100).toFixed(1)}%`,
);
console.log(line('  摊牌净收益', sds.map((r) => r.net)));
console.log(
  `  摊牌赢时平均 ${fmt(agg(sdWins.map((r) => r.net)).mean)} BB  输时平均 ${fmt(agg(sdLoss.map((r) => r.net)).mean)} BB  ` +
    `赢输比 ${fmt(Math.abs(agg(sdWins.map((r) => r.net)).mean / (agg(sdLoss.map((r) => r.net)).mean || -1)), 2)}`,
);
const catCount = new Map<string, { n: number; win: number }>();
for (const r of sds) {
  const k = r.sdCategory ?? '?';
  const e = catCount.get(k) ?? { n: 0, win: 0 };
  e.n += 1;
  if (r.sdWin) e.win += 1;
  catCount.set(k, e);
}
console.log('  摊牌牌型分布（次数/胜率）：');
for (const [k, v] of [...catCount.entries()].sort((a, b) => b[1].n - a[1].n))
  console.log(`    ${k.padEnd(10)} n=${String(v.n).padStart(4)} 胜率 ${((v.win / v.n) * 100).toFixed(0)}%`);

console.log('\n===== 5. 面对下注：跟 vs 弃 =====');
const faced = recs.filter((r) => r.lastFace === 'call' || r.lastFace === 'fold');
console.log(
  `  面对过下注的手 ${faced.length}  其中末次决策为 call ${faced.filter((r) => r.lastFace === 'call').length}  ` +
    `/ fold ${faced.filter((r) => r.lastFace === 'fold').length}`,
);
console.log('\n  (a) 按「本手最后一个面对下注决策」分桶（每手只进一个桶，互不重叠）:');
console.log(line('  末次面对下注→跟注', recs.filter((r) => r.lastFace === 'call').map((r) => r.net)));
console.log(line('  末次面对下注→弃牌', recs.filter((r) => r.lastFace === 'fold').map((r) => r.net)));
console.log(line('  末次面对下注→加注', recs.filter((r) => r.lastFace === 'raise').map((r) => r.net)));
console.log(line('  末次面对下注→全下', recs.filter((r) => r.lastFace === 'allin').map((r) => r.net)));
console.log('\n  (b) 按「跟过注」vs「弃过牌」分桶（同一手可能两边都进，样本重叠）:');
console.log(line('  本手至少跟注一次', recs.filter((r) => r.faceCalls > 0).map((r) => r.net)));
console.log(line('  本手至少弃牌一次', recs.filter((r) => r.faceFolds > 0).map((r) => r.net)));
console.log('\n  (c) 分街：该街最后一次面对下注时 跟 vs 弃 的后续净收益:');
for (const st of STREETS) {
  const c = recs.filter((r) => r.lastFaceStreet === st && r.lastFace === 'call');
  const f = recs.filter((r) => r.lastFaceStreet === st && r.lastFace === 'fold');
  console.log(
    `   ${st.padEnd(8)} 面对下注次数 call=${recs.reduce((s, r) => s + r.faceCallsByStreet[st], 0)} ` +
      `fold=${recs.reduce((s, r) => s + r.faceFoldsByStreet[st], 0)}`,
  );
  console.log(line(`     ${st} 跟注收尾的手`, c.map((r) => r.net)));
  console.log(line(`     ${st} 弃牌收尾的手`, f.map((r) => r.net)));
}
console.log(
  `  跟注手摊牌占比 ${(
    (recs.filter((r) => r.faceCalls > 0 && r.showdown).length / Math.max(1, recs.filter((r) => r.faceCalls > 0).length)) *
    100
  ).toFixed(1)}%  跟注手摊牌胜率 ${(
    (recs.filter((r) => r.faceCalls > 0 && r.showdown && r.sdWin).length /
      Math.max(1, recs.filter((r) => r.faceCalls > 0 && r.showdown).length)) *
    100
  ).toFixed(1)}%`,
);

console.log('\n===== 6. 我方主动下注/加注：对手立刻弃牌率与收益 =====');
for (const st of STREETS) {
  const handsWithAggr = recs.filter((r) => r.aggrByStreet[st] > 0);
  const f = handsWithAggr.reduce((s, r) => s + r.immFoldByStreet[st].fold, 0);
  const c = handsWithAggr.reduce((s, r) => s + r.immFoldByStreet[st].chance, 0);
  console.log(
    `  ${st.padEnd(8)} 有主动下注的手 ${String(handsWithAggr.length).padStart(4)}  ` +
      `下注后被立刻弃牌 ${f}/${c} (${c ? ((f / c) * 100).toFixed(0) : '—'}%)`,
  );
  console.log(line(`    该街下注过的手净收益`, handsWithAggr.map((r) => r.net)));
}

console.log('\n===== 7. 我方决策画像（次数） =====');
for (const st of STREETS) {
  const c = recs.filter((r) => r.decisionsByStreet[st] > 0).length;
  const d = recs.reduce((s, r) => s + r.decisionsByStreet[st], 0);
  const ag = recs.reduce((s, r) => s + r.aggrByStreet[st], 0);
  console.log(`  ${st.padEnd(8)} 有决策的手 ${String(c).padStart(4)}  决策 ${String(d).padStart(5)} 次  其中主动 ${ag} 次 (${((ag / Math.max(1, d)) * 100).toFixed(0)}%)`);
}
console.log(`  进入翻牌 ${recs.filter((r) => r.sawFlop).length} 手 (${((recs.filter((r) => r.sawFlop).length / n) * 100).toFixed(1)}%)`);
console.log(`  摊牌 ${sds.length} 手 (${((sds.length / n) * 100).toFixed(1)}%)`);

console.log('\n===== 8. 交叉维度 =====');
console.log(line('按钮位(单挑=庄/小盲)', recs.filter((r) => r.isButton).map((r) => r.net)));
console.log(line('大盲位', recs.filter((r) => !r.isButton).map((r) => r.net)));
console.log(line('翻前我方是进攻方', recs.filter((r) => r.pfAggressor === 'me').map((r) => r.net)));
console.log(line('翻前对手是进攻方', recs.filter((r) => r.pfAggressor === 'opp').map((r) => r.net)));
console.log(line('翻前无人主动(溜入/弃牌)', recs.filter((r) => r.pfAggressor === 'none').map((r) => r.net)));
console.log('\n  大盲位且进翻牌:');
console.log(line('  BB 进翻牌', recs.filter((r) => !r.isButton && r.sawFlop).map((r) => r.net)));
console.log(line('  按钮 进翻牌', recs.filter((r) => r.isButton && r.sawFlop).map((r) => r.net)));

const summary = {
  mode: 'diag-street-ev',
  hands: n,
  expertSeat: EXPERT_SEAT,
  chSeat: CH_SEAT,
  arch: ARCH,
  overall: agg(all),
  byEndStreet: Object.fromEntries(buckets.map(([l, f]) => [l, agg(recs.filter(f).map((r) => r.net))])),
  byPot: Object.fromEntries(potBuckets.map(([l, f]) => [l, agg(recs.filter(f).map((r) => r.net))])),
  showdown: {
    n: sds.length,
    winRate: sdWins.length / Math.max(1, sds.length),
    meanWin: agg(sdWins.map((r) => r.net)).mean,
    meanLoss: agg(sdLoss.map((r) => r.net)).mean,
  },
  lastFacing: Object.fromEntries(
    ['call', 'fold', 'raise', 'allin'].map((k) => [k, agg(recs.filter((r) => r.lastFace === k).map((r) => r.net))]),
  ),
  byPosition: {
    button: agg(recs.filter((r) => r.isButton).map((r) => r.net)),
    bb: agg(recs.filter((r) => !r.isButton).map((r) => r.net)),
  },
  byPfAggressor: Object.fromEntries(
    ['me', 'opp', 'none'].map((k) => [k, agg(recs.filter((r) => r.pfAggressor === k).map((r) => r.net))]),
  ),
};
console.log('\n---JSON---');
console.log(JSON.stringify(summary));
