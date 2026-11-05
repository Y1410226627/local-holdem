import { describe, expect, it } from 'vitest';
import { createHand, getLegalActions, playAction } from '../game/gameEngine';
import { cardLabel } from '../game/cards';
import type { HandState } from '../game/types';
import {
  C,
  CC,
  chipsTotal,
  makeHand,
  playSequence,
  playToShowdown,
  playToStreet,
} from './helpers';

function logText(hand: HandState): string {
  return hand.log.map((entry) => entry.text).join('\n');
}

describe('完整牌局流程', () => {
  it('check/call 走完四条街并摊牌', () => {
    const hand = playToShowdown(makeHand());
    expect(hand.phase).toBe('complete');
    expect(hand.street).toBe('river');
    expect(hand.board).toHaveLength(5);
    expect(hand.burned).toHaveLength(3);
    expect(hand.result).not.toBeNull();
    expect(hand.result!.showdown).toHaveLength(4);
    expect(hand.result!.foldedWin).toBe(false);
    expect(hand.result!.pots.reduce((sum, pot) => sum + pot.amount, 0)).toBe(80);
    expect(chipsTotal(hand)).toBe(4000);
    expect(hand.log.some((entry) => entry.kind === 'board')).toBe(true);
    expect(hand.log.some((entry) => entry.kind === 'showdown')).toBe(true);
    expect(hand.log.some((entry) => entry.kind === 'pot')).toBe(true);
    expect(logText(hand)).toContain('翻牌：');
    expect(logText(hand)).toContain('转牌：');
    expect(logText(hand)).toContain('河牌：');
  });

  it('街道推进：公共牌数量与烧牌数量正确', () => {
    const preflop = makeHand();
    const flop = playToStreet(preflop, 'flop');
    expect(flop.board).toHaveLength(3);
    expect(flop.burned).toHaveLength(1);
    const turn = playToStreet(flop, 'turn');
    expect(turn.board).toHaveLength(4);
    expect(turn.burned).toHaveLength(2);
    const river = playToStreet(turn, 'river');
    expect(river.board).toHaveLength(5);
    expect(river.burned).toHaveLength(3);
  });

  it('底牌 / 公共牌 / 烧牌互不重复', () => {
    const hand = playToShowdown(makeHand());
    const cards = [
      ...hand.players.flatMap((player) => player.holeCards),
      ...hand.board,
      ...hand.burned,
    ];
    expect(cards).toHaveLength(16);
    const ids = new Set(cards.map(cardLabel));
    expect(ids.size).toBe(16);
  });

  it('摊牌前日志不泄露任何玩家底牌', () => {
    const hand = playToStreet(makeHand(), 'flop');
    const text = logText(hand);
    for (const player of hand.players) {
      for (const card of player.holeCards) {
        expect(text).not.toContain(cardLabel(card));
      }
    }
  });
});

describe('只剩一名玩家 / 弃牌获胜', () => {
  it('其他玩家全部弃牌时立即结束，不摊牌', () => {
    let hand = makeHand();
    hand = playSequence(hand, [
      [3, { type: 'fold' }],
      [0, { type: 'fold' }],
      [1, { type: 'fold' }],
    ]);
    expect(hand.phase).toBe('complete');
    expect(hand.board).toHaveLength(0); // 不摊牌
    expect(hand.result!.foldedWin).toBe(true);
    expect(hand.result!.showdown).toBeNull();
    expect(hand.result!.winners[0].playerId).toBe(2);
    // 大盲的 20 中有 10 未被跟注（退还），实际赢得小盲的 10 + 自己的 10 = 20
    expect(hand.result!.refunds).toEqual([{ playerId: 2, name: '机器人2', amount: 10 }]);
    expect(hand.result!.winners[0].amount).toBe(20);
    expect(hand.players[2].stack).toBe(1010);
    expect(chipsTotal(hand)).toBe(4000);
    expect(logText(hand)).toContain('弃牌');
  });

  it('弃牌获胜时退回未跟注的下注', () => {
    let hand = makeHand();
    hand = playSequence(hand, [
      [3, { type: 'raise', amount: 100 }],
      [0, { type: 'fold' }],
      [1, { type: 'fold' }],
      [2, { type: 'fold' }],
    ]);
    expect(hand.phase).toBe('complete');
    expect(hand.result!.foldedWin).toBe(true);
    expect(hand.result!.refunds).toEqual([{ playerId: 3, name: '机器人3', amount: 80 }]);
    expect(hand.result!.pots[0].amount).toBe(50); // 3 的 20 + SB 10 + BB 20
    expect(hand.players[3].stack).toBe(1030);
    expect(chipsTotal(hand)).toBe(4000);
    expect(logText(hand)).toContain('退回未跟注');
  });
});

describe('全下 run-out', () => {
  it('所有玩家全下：一次发完公共牌并摊牌', () => {
    let hand = makeHand();
    hand = playSequence(hand, [
      [3, { type: 'allin' }],
      [0, { type: 'allin' }],
      [1, { type: 'allin' }],
      [2, { type: 'allin' }],
    ]);
    expect(hand.phase).toBe('complete');
    expect(hand.board).toHaveLength(5);
    expect(hand.burned).toHaveLength(3);
    expect(hand.result!.showdown).toHaveLength(4);
    expect(hand.result!.pots).toHaveLength(1);
    expect(hand.result!.pots[0].amount).toBe(4000);
    expect(chipsTotal(hand)).toBe(4000);
  });

  it('多名玩家不同筹码全下：主池 + 多层边池', () => {
    let hand = makeHand({ stacks: [100, 500, 1000, 1000] });
    hand = playSequence(hand, [
      [3, { type: 'allin' }],
      [0, { type: 'allin' }],
      [1, { type: 'allin' }],
      [2, { type: 'allin' }],
    ]);
    expect(hand.phase).toBe('complete');
    const pots = hand.result!.pots;
    expect(pots).toHaveLength(3);
    expect(pots.map((pot) => pot.label)).toEqual(['主池', '边池 1', '边池 2']);
    expect(pots.map((pot) => pot.amount)).toEqual([400, 1200, 1000]);
    expect(pots[0].winnerIds.length).toBeGreaterThan(0);
    expect(chipsTotal(hand)).toBe(2600);
  });

  it('单挑一方筹码较少全下：退回未被跟注部分', () => {
    let hand = makeHand({ stacks: [1000, 300], buttonIndex: 0 });
    hand = playSequence(hand, [
      [0, { type: 'allin' }],
      [1, { type: 'allin' }],
    ]);
    expect(hand.phase).toBe('complete');
    expect(hand.result!.refunds).toEqual([{ playerId: 0, name: '你', amount: 700 }]);
    const total = hand.result!.pots.reduce((sum, pot) => sum + pot.amount, 0);
    expect(total).toBe(600);
    expect(chipsTotal(hand)).toBe(1300);
  });

  it('翻牌后全员全下：一次性发完转牌与河牌并摊牌', () => {
    let hand = playToStreet(makeHand(), 'flop');
    expect(hand.board).toHaveLength(3);
    // 翻牌行动顺序：1 → 2 → 3 → 0
    hand = playSequence(hand, [
      [1, { type: 'allin' }],
      [2, { type: 'allin' }],
      [3, { type: 'allin' }],
      [0, { type: 'allin' }],
    ]);
    expect(hand.phase).toBe('complete');
    expect(hand.board).toHaveLength(5);
    expect(hand.burned).toHaveLength(3);
    expect(hand.result!.showdown).toHaveLength(4);
    expect(chipsTotal(hand)).toBe(4000);
  });
});

describe('摊牌与牌型', () => {
  it('皇家同花顺赢得底池并高亮', () => {
    const hand = makeHand({
      holeCards: [CC('As Ks'), CC('9h 9d'), CC('2c 7c'), CC('3s 8s')],
      board: CC('Qs Js Ts 4h 5d'),
    });
    const result = playToShowdown(hand);
    expect(result.phase).toBe('complete');
    const player0 = result.result!.showdown!.find((entry) => entry.playerId === 0)!;
    expect(player0.category).toBe(8);
    expect(player0.description).toBe('皇家同花顺');
    expect(player0.isWinner).toBe(true);
    expect(result.result!.showdown!.filter((entry) => entry.isWinner)).toHaveLength(1);
    expect(result.players[0].stack).toBe(1060);
    expect(chipsTotal(result)).toBe(4000);
  });

  it('公共牌皇家同花顺：四人均分底池', () => {
    const hand = makeHand({
      holeCards: [CC('2h 3h'), CC('4h 5h'), CC('6h 7h'), CC('8h 9h')],
      board: CC('As Ks Qs Js Ts'),
    });
    const result = playToShowdown(hand);
    const pot = result.result!.pots[0];
    expect(pot.amount).toBe(80);
    expect(pot.payouts).toHaveLength(4);
    expect(pot.payouts.every((payout) => payout.amount === 20)).toBe(true);
    expect(result.players.every((player) => player.stack === 1000)).toBe(true);
  });

  it('三人平局且底池含弃牌死钱：奇数筹码按按钮左边顺序分配', () => {
    const hand = makeHand({
      holeCards: [CC('2h 3h'), CC('4h 5h'), CC('6h 7h'), CC('8h 9h')],
      board: CC('As Ks Qs Js Ts'),
    });
    // 翻牌前：UTG 跟注、按钮跟注、小盲补齐、大盲过牌
    let current = playSequence(hand, [
      [3, { type: 'call' }],
      [0, { type: 'call' }],
      [1, { type: 'call' }],
      [2, { type: 'check' }],
    ]);
    expect(current.street).toBe('flop');
    // 翻牌：小盲下注 20，大盲跟注，UTG 跟注，按钮弃牌
    current = playSequence(current, [
      [1, { type: 'bet', amount: 20 }],
      [2, { type: 'call' }],
      [3, { type: 'call' }],
      [0, { type: 'fold' }],
    ]);
    const result = playToShowdown(current);
    expect(result.phase).toBe('complete');
    const awards = result.result!.pots;
    const totalAward = awards.reduce(
      (sum, pot) => sum + pot.payouts.reduce((inner, payout) => inner + payout.amount, 0),
      0,
    );
    expect(totalAward).toBe(140);
    const byPlayer = new Map<number, number>();
    for (const pot of awards) {
      for (const payout of pot.payouts) {
        byPlayer.set(payout.playerId, (byPlayer.get(payout.playerId) ?? 0) + payout.amount);
      }
    }
    expect(byPlayer.get(1)).toBe(47);
    expect(byPlayer.get(2)).toBe(47);
    expect(byPlayer.get(3)).toBe(46);
    expect(awards[0].oddChips).toBe(2);
    expect(awards[0].oddChipTo).toBe(1); // 按钮左边第一个赢家是小盲（玩家 1）
    expect(chipsTotal(result)).toBe(4000);
  });
});

describe('创建手牌参数与种子复现', () => {
  it('人数不足 / 筹码不足时无法开始', () => {
    expect(() =>
      createHand({
        handNo: 1,
        players: [{ id: 0, name: 'A', isHuman: true, stack: 1000 }],
        buttonIndex: 0,
        smallBlind: 10,
        bigBlind: 20,
        seed: 's',
      }),
    ).toThrow(/两名玩家/);
    expect(() =>
      createHand({
        handNo: 1,
        players: [
          { id: 0, name: 'A', isHuman: true, stack: 100 },
          { id: 1, name: 'B', isHuman: false, stack: 0 },
        ],
        buttonIndex: 0,
        smallBlind: 10,
        bigBlind: 20,
        seed: 's',
      }),
    ).toThrow(/有筹码/);
  });

  it('非法盲注配置被拒绝', () => {
    const players = [
      { id: 0, name: 'A', isHuman: true, stack: 1000 },
      { id: 1, name: 'B', isHuman: false, stack: 1000 },
    ];
    expect(() =>
      createHand({ handNo: 1, players, buttonIndex: 0, smallBlind: 0, bigBlind: 20, seed: 's' }),
    ).toThrow(/小盲/);
    expect(() =>
      createHand({ handNo: 1, players, buttonIndex: 0, smallBlind: 30, bigBlind: 20, seed: 's' }),
    ).toThrow(/小盲不能大于大盲/);
  });

  it('相同种子 + 相同动作 → 完全相同牌局', () => {
    const a = playToShowdown(makeHand({ seed: 'repro-42' }));
    const b = playToShowdown(makeHand({ seed: 'repro-42' }));
    expect(a.players.map((p) => p.holeCards.map(cardLabel))).toEqual(
      b.players.map((p) => p.holeCards.map(cardLabel)),
    );
    expect(a.board.map(cardLabel)).toEqual(b.board.map(cardLabel));
    expect(a.burned.map(cardLabel)).toEqual(b.burned.map(cardLabel));
    expect(a.log.map((entry) => entry.text)).toEqual(b.log.map((entry) => entry.text));
    expect(a.players.map((p) => p.stack)).toEqual(b.players.map((p) => p.stack));
  });

  it('不同种子 → 不同牌局', () => {
    const a = makeHand({ seed: 'seed-a' });
    const b = makeHand({ seed: 'seed-b' });
    expect(a.players.map((p) => p.holeCards.map(cardLabel))).not.toEqual(
      b.players.map((p) => p.holeCards.map(cardLabel)),
    );
  });

  it('全部玩家弃牌后无公共牌', () => {
    const hand = playSequence(makeHand(), [
      [3, { type: 'fold' }],
      [0, { type: 'fold' }],
      [1, { type: 'fold' }],
    ]);
    expect(hand.board).toHaveLength(0);
    expect(hand.burned).toHaveLength(0);
    expect(hand.result?.foldedWin).toBe(true);
  });

  it('完成的手牌不能继续行动，合法动作查询抛错', () => {
    const hand = playToShowdown(makeHand());
    expect(() => playAction(hand, 0, { type: 'check' })).toThrow(/已经结束/);
    expect(() => getLegalActions(hand, 0)).toThrow(/已经结束/);
  });
});
