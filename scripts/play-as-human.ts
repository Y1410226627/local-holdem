/**
 * 「我亲自下场」的驱动脚本。
 *
 * 决策由我（人类玩家）下，写进 /tmp/my-actions.json；代码只负责：
 *   1) 用固定 seed 重放这一手；
 *   2) 轮到我时取下一个动作；
 *   3) 动作列表用完时，打印当前状态 + 合法动作，然后退出——等我想好下一步再重跑。
 *
 * 这样既能真实地和 5 个挑战档机器人打，又保证「决策不是代码做的」。
 *
 * 用法：
 *   echo '[]' > /tmp/my-actions.json && npx tsx scripts/play-as-human.ts
 *   然后每次把我想好的动作追加进 json，重跑。
 */
import { readFileSync } from 'node:fs';
import { act, createTable, startNextHand } from '../src/game/stateMachine';
import { buildPlayerView } from '../src/game/playerView';
import { decide } from '../src/ai/aiPlayer';
import type { PlayerAction, TableState } from '../src/game/types';

const SEED = process.env.SEED ?? 'human-vs-5-bots-1';
const ACTIONS_FILE = process.env.ACTIONS ?? '.play-actions.json';
const RANK = ['', '', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const card = (c: { rank: number; suit: string }) => `${RANK[c.rank]}${c.suit}`;

const myActions = JSON.parse(readFileSync(ACTIONS_FILE, 'utf8')) as PlayerAction[];
let actionIndex = 0;

let table: TableState = createTable({
  playerCount: 6,
  startingStack: 1000,
  smallBlind: 10,
  bigBlind: 20,
  seed: SEED,
  difficulty: 'expert',
  challengeMode: true,
});
table.players = table.players.map((p) => ({ ...p, styleId: 0, challengeArchetypeId: 0 }));
table = startNextHand(table);

const mySeat = table.players.findIndex((p) => p.isHuman);
console.log(`=== 第 ${table.handNo} 手 | 按钮位 seat ${table.buttonIndex} | 我在 seat ${mySeat} ===`);

let guard = 0;
while (table.phase === 'playing') {
  if (++guard > 200) throw new Error('卡住');
  const hand = table.hand!;
  const index = hand.actingIndex!;
  const view = buildPlayerView(hand, hand.players[index].id, table.config.seed);
  const legal = view.legal!;
  const isMe = index === mySeat;

  if (isMe) {
    if (actionIndex >= myActions.length) {
      // 轮到我了，但还没想好：打印状态等我
      console.log('\n───── 轮到我行动 ─────');
      console.log('我的底牌:', view.self.holeCards.map(card).join(' '));
      console.log('公共牌  :', view.board.length ? view.board.map(card).join(' ') : '（翻前）');
      console.log('街      :', view.street, '| 底池', view.pot, '| 当前下注', view.currentBet);
      console.log('我的筹码:', view.self.stack, '| 本手已投', view.self.totalCommitted);
      console.log('需跟    :', legal.callAmount, '| 底池赔率', (legal.callAmount / Math.max(1, view.pot + legal.callAmount)).toFixed(3));
      console.log('合法动作:', JSON.stringify({
        canFold: legal.canFold,
        canCheck: legal.canCheck,
        canCall: legal.canCall,
        canRaise: legal.canRaise,
        minRaiseTo: legal.minRaiseTo,
        maxRaiseTo: legal.maxRaiseTo,
        aggressiveType: legal.aggressiveType,
      }));
      console.log('\n各家状态:');
      for (const p of view.players) {
        console.log(
          `  ${p.id === view.viewerId ? '★我' : '  '} seat${p.id} ${p.name.padEnd(4)} ` +
            `筹码 ${String(p.stack).padStart(5)} 状态 ${p.status.padEnd(7)} 本轮投 ${p.committedThisStreet}`,
        );
      }
      console.log(`\n已执行我的 ${actionIndex} 个动作，等待第 ${actionIndex + 1} 个。`);
      process.exit(0);
    }
    const action = myActions[actionIndex++];
    console.log(`\n【我】${view.street} ${JSON.stringify(action)}  (底池 ${view.pot})`);
    table = act(table, index, action);
    continue;
  }

  const decision = await decide(view, 'expert', { challenge: true, maxIterations: 800 });
  console.log(
    `【${hand.players[index].name}】${view.street} ${JSON.stringify(decision.action)}  ` +
      `(${decision.debug.engine}) ${decision.debug.reasoning.slice(0, 150)}`,
  );
  table = act(table, index, decision.action);
}

console.log('\n───── 本手结束 ─────');
console.log('公共牌:', table.hand?.board.map(card).join(' ') ?? '—');
for (const p of table.players) {
  const start = table.handStartStacks[p.id] ?? 0;
  console.log(`  ${p.name.padEnd(4)} ${String(p.stack).padStart(5)}  (${p.stack - start >= 0 ? '+' : ''}${p.stack - start})`);
}
if (table.hand?.showdown) {
  for (const s of table.hand.showdown) {
    console.log(`  摊牌 ${s.name}: ${s.holeCards?.map(card).join(' ') ?? '—'}`);
  }
}
