/**
 * 会话模式对打测量台：**一张桌子连打 N 手，双方都是 AI，对手统计跨手累积**。
 *
 * 为什么需要它：`head2head` / `h2h-shard` 每手都新建牌桌，`statsRaw` 永远是空的，
 * `avgFoldToBet` 等读人统计恒为 null —— 任何依赖「读人」的策略层在那里触发率精确为 0
 * （实测：翻前剥削层 2000 次决策 hits=0，两臂逐位相同）。
 * 也就是说，一手一桌的测量台**在结构上测不了读人能力**。
 *
 * 本台子：同一张桌子、连续 hand、只重置筹码不重置统计（与真实牌桌一致）。
 *
 * 用法：
 *   HANDS=2000 EXPERT_SEAT=1 ARCH=assign npx tsx scripts/session-h2h.ts
 *   NEW_PF_EXPLOIT=0 ...   # 关闭翻前剥削层做 A/B
 *   NEW_FLOP=0 ...         # 关闭翻后两层
 */
import { act, createTable, startNextHand } from '../src/game/stateMachine';
import { buildPlayerView } from '../src/game/playerView';
import { decide } from '../src/ai/aiPlayer';
import { assignChallengeArchetypes } from '../src/ai/challenge';
import type { TableState } from '../src/game/types';

const HANDS = Number(process.env.HANDS ?? 2000);
const STACK = Number(process.env.STACK ?? 1000);
const ARCH = process.env.ARCH ?? 'fixed';
const EXPERT_SEAT = Number(process.env.EXPERT_SEAT ?? 1);
const CH_SEAT = 1 - EXPERT_SEAT;

const challengeOptions = {
  challenge: true,
  ...(process.env.NEW_FLOP === '0' ? { flopLayer: false } : {}),
  ...(process.env.NEW_PF_EXPLOIT === '0' ? { preflopExploitModel: false } : {}),
  ...(process.env.NEW_BPGATE === '0' ? { blueprintStackGate: false } : {}),
};

async function run(): Promise<number[]> {
  // seed 必须含 ARCH：否则 assign 与 fixed 是同一条牌序重跑，当成两组独立样本会把 CI 虚缩 √2。
  const tableSeed = `sess-h2h-${EXPERT_SEAT}-${ARCH}`;
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

  const nets: number[] = [];
  let chDecisions = 0;
  let chExploitHits = 0;
  for (let h = 0; h < HANDS; h++) {
    // 只重置筹码、不重置统计：与 session.ts 同一处理，保证每手风险金额相同。
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
          ? await decide(view, 'expert', challengeOptions).then((r) => {
              chDecisions += 1;
              if (/剥削|读人/.test(r.debug?.reasoning ?? '')) chExploitHits += 1;
              return r.action;
            })
          : (await decide(view, 'expert', { challenge: false })).action;
      table = act(table, idx, action);
    }
    nets.push(table.players[CH_SEAT].stack - start);

    if ((h + 1) % 100 === 0) {
      const done = nets.reduce((a, b) => a + b, 0);
      const bb = ((done / (h + 1)) / 20) * 100;
      console.log(
        `[${new Date().toISOString().slice(11, 19)}] ${h + 1}/${HANDS} 手  ` +
          `累计 ${done} 筹码  平均 ${bb.toFixed(1)} BB/100`,
      );
    }
  }
  return { nets, chDecisions, chExploitHits };
}

const { nets, chDecisions, chExploitHits } = await run();
const n = nets.length;
const mean = nets.reduce((a, b) => a + b, 0) / Math.max(1, n);
const varr = nets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
const se = Math.sqrt(varr / Math.max(1, n));
console.log(
  JSON.stringify({
    mode: 'session-h2h',
    arch: ARCH,
    expertSeat: EXPERT_SEAT,
    hands: n,
    bbPer100: Number(((mean / 20) * 100).toFixed(1)),
    ci95: [
      Number((((mean - 1.96 * se) / 20) * 100).toFixed(1)),
      Number((((mean + 1.96 * se) / 20) * 100).toFixed(1)),
    ],
    flags: challengeOptions,
    preflopExploit: { decisions: chDecisions, hits: chExploitHits },
  }),
);
