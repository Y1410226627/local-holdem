import { describe, expect, it } from 'vitest';
import { playAction } from '../game/gameEngine';
import { getLegalActions } from '../game/betting';
import { playSequence, playToStreet, makeHand } from './helpers';

describe('行动顺序', () => {
  it('4 人桌：翻牌前从大盲左边开始（UTG），盲注位置正确', () => {
    const hand = makeHand();
    expect(hand.buttonIndex).toBe(0);
    expect(hand.players[1].committedThisStreet).toBe(10); // 小盲
    expect(hand.players[2].committedThisStreet).toBe(20); // 大盲
    expect(hand.actingIndex).toBe(3); // 大盲左边第一位
  });

  it('4 人桌：翻牌后从按钮左边第一位开始', () => {
    const hand = playToStreet(makeHand(), 'flop');
    expect(hand.street).toBe('flop');
    expect(hand.board).toHaveLength(3);
    expect(hand.actingIndex).toBe(1); // 小盲位
  });

  it('翻牌后行动顺序跳过已全下玩家', () => {
    // 3 人桌：小盲只剩 5 筹码，翻牌前全下；按钮跟注、大盲过牌后进入翻牌
    let hand = makeHand({ stacks: [1000, 5, 1000] });
    expect(hand.players[1].status).toBe('allin');
    expect(hand.actingIndex).toBe(0);
    hand = playSequence(hand, [
      [0, { type: 'call' }],
      [2, { type: 'check' }],
    ]);
    expect(hand.street).toBe('flop');
    expect(hand.actingIndex).toBe(2); // 跳过全下的小盲
  });

  it('3 人桌：按钮翻牌前先行动（UTG = 按钮）；翻牌后小盲先行动', () => {
    const hand = makeHand({ stacks: [1000, 1000, 1000] });
    expect(hand.smallBlind).toBe(10);
    // 3 人桌：SB = 1, BB = 2, 翻牌前按钮 0 先行动
    expect(hand.players[1].committedThisStreet).toBe(10);
    expect(hand.players[2].committedThisStreet).toBe(20);
    expect(hand.actingIndex).toBe(0);
    const flop = playToStreet(hand, 'flop');
    expect(flop.actingIndex).toBe(1);
  });

  it('单挑：按钮兼小盲，翻牌前按钮先行动', () => {
    const hand = makeHand({ stacks: [1000, 1000], buttonIndex: 0 });
    expect(hand.players[0].committedThisStreet).toBe(10); // 按钮=小盲
    expect(hand.players[1].committedThisStreet).toBe(20); // 大盲
    expect(hand.actingIndex).toBe(0);
  });

  it('单挑：翻牌后大盲先行动，按钮后行动', () => {
    const hand = makeHand({ stacks: [1000, 1000], buttonIndex: 0 });
    let current = playSequence(hand, [
      [0, { type: 'call' }],
      [1, { type: 'check' }],
    ]);
    expect(current.street).toBe('flop');
    expect(current.actingIndex).toBe(1); // 大盲先行动
    current = playSequence(current, [[1, { type: 'check' }]]);
    expect(current.actingIndex).toBe(0); // 按钮后行动
  });

  it('单挑：按钮为 1 时，翻牌前玩家 1 先行动', () => {
    const hand = makeHand({ stacks: [1000, 1000], buttonIndex: 1 });
    expect(hand.players[1].committedThisStreet).toBe(10);
    expect(hand.players[0].committedThisStreet).toBe(20);
    expect(hand.actingIndex).toBe(1);
  });
});

describe('大盲 option', () => {
  it('无人加注时，大盲可以选择过牌（而非被迫跟注）', () => {
    let hand = makeHand();
    hand = playSequence(hand, [
      [3, { type: 'call' }],
      [0, { type: 'call' }],
      [1, { type: 'call' }],
    ]);
    expect(hand.actingIndex).toBe(2);
    const legal = getLegalActions(hand, 2);
    expect(legal.canCheck).toBe(true);
    expect(legal.canCall).toBe(false);
    expect(legal.canRaise).toBe(true);
    expect(legal.callAmount).toBe(0);
    const flop = playAction(hand, 2, { type: 'check' });
    expect(flop.street).toBe('flop');
  });

  it('大盲 option 加注：其余玩家需要再次行动', () => {
    let hand = makeHand();
    hand = playSequence(hand, [
      [3, { type: 'call' }],
      [0, { type: 'call' }],
      [1, { type: 'call' }],
      [2, { type: 'raise', amount: 60 }],
    ]);
    expect(hand.street).toBe('preflop');
    expect(hand.actingIndex).toBe(3);
    const legal = getLegalActions(hand, 3);
    expect(legal.canCall).toBe(true);
    expect(legal.callAmount).toBe(40);
    expect(legal.canRaise).toBe(true);
    expect(legal.minRaiseTo).toBe(100);
  });
});

describe('最小加注与完整加注重开', () => {
  it('翻牌前：初始最小加注到 40，之后每次最小加注按上一次增量', () => {
    let hand = makeHand();
    const legal3 = getLegalActions(hand, 3);
    expect(legal3.minRaiseTo).toBe(40);
    hand = playSequence(hand, [[3, { type: 'raise', amount: 40 }]]);
    expect(hand.actingIndex).toBe(0);
    expect(getLegalActions(hand, 0).minRaiseTo).toBe(60);
    hand = playSequence(hand, [[0, { type: 'raise', amount: 60 }]]);
    expect(hand.actingIndex).toBe(1);
    expect(getLegalActions(hand, 1).minRaiseTo).toBe(80);
  });

  it('题目示例：当前 100，加注到 250（增量 150），下一次最小加到 400', () => {
    let hand = playToStreet(makeHand(), 'flop');
    expect(hand.actingIndex).toBe(1);
    hand = playSequence(hand, [
      [1, { type: 'bet', amount: 100 }],
      [2, { type: 'raise', amount: 250 }],
    ]);
    expect(hand.actingIndex).toBe(3);
    const legal = getLegalActions(hand, 3);
    expect(legal.currentBet).toBe(250);
    expect(legal.minRaiseTo).toBe(400);
    expect(hand.lastFullRaiseSize).toBe(150);
  });

  it('完整加注重开已行动玩家的加注权', () => {
    let hand = makeHand();
    // UTG 跟注，按钮加注到 100，SB/BB 跟注，回到 UTG（已行动）应可再加注
    hand = playSequence(hand, [
      [3, { type: 'call' }],
      [0, { type: 'raise', amount: 100 }],
      [1, { type: 'call' }],
      [2, { type: 'call' }],
    ]);
    expect(hand.actingIndex).toBe(3);
    const legal = getLegalActions(hand, 3);
    expect(legal.canRaise).toBe(true);
    expect(legal.minRaiseTo).toBe(180);
    expect(hand.players[3].canRaise).toBe(true);
  });

  it('翻牌后最小下注额等于大盲', () => {
    const hand = playToStreet(makeHand(), 'flop');
    const legal = getLegalActions(hand, hand.actingIndex!);
    expect(legal.minRaiseTo).toBe(20);
    const afterBet = playAction(hand, hand.actingIndex!, { type: 'bet', amount: 20 });
    expect(afterBet.currentBet).toBe(20);
  });
});

describe('short all-in（不足最小加注的全下）', () => {
  it('翻牌前 short all-in 不重开已行动玩家的加注权', () => {
    // BB 只有 35 筹码：翻牌前 3/0/1 跟注后，BB 全下到 35（增量 15 < 20）
    let hand = makeHand({ stacks: [1000, 1000, 35, 1000] });
    hand = playSequence(hand, [
      [3, { type: 'call' }],
      [0, { type: 'call' }],
      [1, { type: 'call' }],
    ]);
    expect(hand.actingIndex).toBe(2);
    const bbLegal = getLegalActions(hand, 2);
    expect(bbLegal.canRaise).toBe(false);
    expect(bbLegal.canAllIn).toBe(true); // 短全下加注

    hand = playAction(hand, 2, { type: 'allin' });
    expect(hand.actingIndex).toBe(3);
    expect(hand.currentBet).toBe(35);
    expect(hand.players[2].status).toBe('allin');

    const legal = getLegalActions(hand, 3);
    expect(legal.canRaise).toBe(false); // 已行动，面对 short all-in 只能跟注/弃牌
    expect(legal.canCall).toBe(true);
    expect(legal.callAmount).toBe(15);
    expect(legal.canAllIn).toBe(false);
    expect(hand.lastFullRaiseSize).toBe(20); // 最小加注增量不变

    expect(() => playAction(hand, 3, { type: 'allin' })).toThrow(/无法全下/);
    hand = playSequence(hand, [
      [3, { type: 'call' }],
      [0, { type: 'call' }],
      [1, { type: 'call' }],
    ]);
    expect(hand.street).toBe('flop');
  });

  it('尚未行动的玩家面对 short all-in 仍可加注到完整最小额', () => {
    // 翻牌：SB 下注 100，BB 全下到 180（增量 80 < 100）
    let hand = playToStreet(makeHand({ stacks: [1000, 1000, 200, 1000] }), 'flop');
    expect(hand.actingIndex).toBe(1);
    hand = playAction(hand, 1, { type: 'bet', amount: 100 });
    hand = playAction(hand, 2, { type: 'allin' });
    expect(hand.players[2].status).toBe('allin');
    expect(hand.currentBet).toBe(180);
    expect(hand.actingIndex).toBe(3);

    const legal3 = getLegalActions(hand, 3);
    expect(legal3.canRaise).toBe(true);
    expect(legal3.minRaiseTo).toBe(280); // 180 + 上一次完整加注增量 100
    expect(legal3.callAmount).toBe(180);

    // 玩家 3 跟注后，玩家 0（未行动）仍可加注
    hand = playAction(hand, 3, { type: 'call' });
    expect(hand.actingIndex).toBe(0);
    expect(getLegalActions(hand, 0).canRaise).toBe(true);

    hand = playAction(hand, 0, { type: 'call' });
    // 回到下注者玩家 1：已行动，面对 short all-in 不能加注
    expect(hand.actingIndex).toBe(1);
    const legal1 = getLegalActions(hand, 1);
    expect(legal1.canRaise).toBe(false);
    expect(legal1.callAmount).toBe(80);
    expect(legal1.canCall).toBe(true);
  });

  it('多个短全下累计达到一次完整加注额时重开加注权', () => {
    // 翻牌：P1 下注 100 → P2 全下 150（+50）→ P3 跟注 150 → P0 全下 220（+70）
    // 对 P1 累计 +120 >= 100，重开加注权；对 P3 累计 +70 < 100，不重开。
    let hand = playToStreet(makeHand({ stacks: [240, 1000, 170, 1000] }), 'flop');
    expect(hand.actingIndex).toBe(1);
    hand = playAction(hand, 1, { type: 'bet', amount: 100 });
    hand = playAction(hand, 2, { type: 'allin' });
    expect(hand.players[2].status).toBe('allin');
    hand = playAction(hand, 3, { type: 'call' });
    hand = playAction(hand, 0, { type: 'allin' });
    expect(hand.players[0].status).toBe('allin');
    expect(hand.currentBet).toBe(220);
    expect(hand.actingIndex).toBe(1);
    expect(hand.players[1].canRaise).toBe(true);
    expect(hand.players[3].canRaise).toBe(false);
    expect(getLegalActions(hand, 1).minRaiseTo).toBe(320);
  });

  it('盲注不足时全下：状态为 allin，牌局可继续', () => {
    let hand = makeHand({ stacks: [1000, 1000, 5, 1000] });
    expect(hand.players[2].status).toBe('allin');
    expect(hand.players[2].committedThisStreet).toBe(5);
    expect(hand.players[2].stack).toBe(0);
    expect(hand.currentBet).toBe(10);
    const legal = getLegalActions(hand, 3);
    expect(legal.callAmount).toBe(10);
    expect(legal.minRaiseTo).toBe(20);
    hand = playSequence(hand, [
      [3, { type: 'call' }],
      [0, { type: 'call' }],
      [1, { type: 'check' }],
    ]);
    expect(hand.street).toBe('flop');
    expect(hand.players[2].status).toBe('allin');
  });

  it('面对小于大盲的短全下：最小加注补足到完整大盲', () => {
    // 小盲翻牌前补齐后只剩 5 筹码；翻牌全下 5（小于大盲 20）
    let hand = makeHand({ stacks: [1000, 25, 1000, 1000] });
    hand = playSequence(hand, [
      [3, { type: 'call' }],
      [0, { type: 'call' }],
      [1, { type: 'call' }],
      [2, { type: 'check' }],
    ]);
    expect(hand.street).toBe('flop');
    expect(hand.actingIndex).toBe(1);
    hand = playAction(hand, 1, { type: 'bet', amount: 5 }); // 短全下下注
    expect(hand.players[1].status).toBe('allin');
    expect(hand.currentBet).toBe(5);
    const legal2 = getLegalActions(hand, 2);
    expect(legal2.minRaiseTo).toBe(20); // 补足到完整大盲
    expect(legal2.callAmount).toBe(5);
    expect(legal2.canRaise).toBe(true);
    hand = playAction(hand, 2, { type: 'raise', amount: 20 });
    expect(hand.currentBet).toBe(20);
    expect(getLegalActions(hand, 3).minRaiseTo).toBe(40);
  });
});

describe('全下与跟注', () => {
  it('短码全下跟注（all-in call）被正确记录并退回未被跟注部分', () => {
    // 3 人桌：按钮 0 加注到 100，SB 弃牌，BB 只剩 30，全下跟注 50
    let hand = makeHand({ stacks: [1000, 1000, 50] });
    expect(hand.actingIndex).toBe(0);
    hand = playAction(hand, 0, { type: 'raise', amount: 100 });
    expect(hand.actingIndex).toBe(1);
    hand = playAction(hand, 1, { type: 'fold' });
    expect(hand.actingIndex).toBe(2);
    const legal = getLegalActions(hand, 2);
    expect(legal.isAllInCall).toBe(true);
    expect(legal.canAllIn).toBe(true);

    hand = playAction(hand, 2, { type: 'allin' });
    expect(hand.players[2].status).toBe('allin');
    expect(hand.players[2].totalCommitted).toBe(50);
    expect(hand.phase).toBe('complete');
    expect(hand.board).toHaveLength(5);
    expect(hand.result?.refunds.some((refund) => refund.playerId === 0 && refund.amount === 50)).toBe(true);
    // 底池 = 按钮 50 + 弃牌小盲 10 + 短码全下 50 = 110（弃牌死钱仍归赢家）
    const potTotal = hand.result!.pots.reduce((sum, pot) => sum + pot.amount, 0);
    expect(potTotal).toBe(110);
    const chips = hand.players.reduce((sum, player) => sum + player.stack, 0);
    expect(chips).toBe(2050);
  });

  it('全下加注记录正确，且筹码守恒', () => {
    const hand = makeHand({ stacks: [500, 500, 500, 500] });
    const next = playAction(hand, 3, { type: 'allin' });
    expect(next.players[3].status).toBe('allin');
    expect(next.players[3].stack).toBe(0);
    expect(next.currentBet).toBe(500);
    const total = next.players.reduce((sum, p) => sum + p.stack + p.totalCommitted, 0);
    expect(total).toBe(2000);
  });
});

describe('非法动作校验', () => {
  it('面对下注不能过牌', () => {
    const hand = makeHand();
    expect(() => playAction(hand, 3, { type: 'check' })).toThrow(/不能过牌/);
  });

  it('无人下注时不能跟注', () => {
    const hand = playToStreet(makeHand(), 'flop');
    expect(() => playAction(hand, hand.actingIndex!, { type: 'call' })).toThrow(/无需跟注/);
  });

  it('已有下注时不能使用“下注”', () => {
    const hand = makeHand();
    expect(() => playAction(hand, 3, { type: 'bet', amount: 100 })).toThrow(/应使用加注/);
  });

  it('无人下注时不能使用“加注”', () => {
    const hand = playToStreet(makeHand(), 'flop');
    expect(() => playAction(hand, hand.actingIndex!, { type: 'raise', amount: 100 })).toThrow(
      /应使用下注/,
    );
  });

  it('低于最小加注额被拒绝', () => {
    const hand = makeHand();
    expect(() => playAction(hand, 3, { type: 'raise', amount: 30 })).toThrow(/最小加注额/);
  });

  it('超过剩余筹码被拒绝', () => {
    const hand = makeHand();
    expect(() => playAction(hand, 3, { type: 'raise', amount: 5000 })).toThrow(/超过/);
  });

  it('非整数金额被拒绝', () => {
    const hand = makeHand();
    expect(() => playAction(hand, 3, { type: 'raise', amount: 41.5 })).toThrow(/整数/);
  });

  it('未轮到的玩家不能行动', () => {
    const hand = makeHand();
    expect(() => playAction(hand, 0, { type: 'call' })).toThrow(/行动/);
  });

  it('牌局结束后不能继续行动', () => {
    let hand = makeHand();
    hand = playSequence(hand, [
      [3, { type: 'fold' }],
      [0, { type: 'fold' }],
      [1, { type: 'fold' }],
    ]);
    expect(hand.phase).toBe('complete');
    expect(() => playAction(hand, 2, { type: 'check' })).toThrow(/已经结束/);
  });
});

describe('动作历史', () => {
  it('每个动作都会记录到 actions 中', () => {
    const hand = makeHand();
    const next = playAction(hand, 3, { type: 'call' });
    expect(next.actions).toHaveLength(1);
    const record = next.actions[0];
    expect(record.actorId).toBe(3);
    expect(record.actorName).toBe('机器人3');
    expect(record.action).toEqual({ type: 'call' });
    expect(record.paid).toBe(20);
    expect(record.toAmount).toBe(20);
    expect(record.potAfter).toBe(50);
    expect(record.board).toEqual([]);
  });

  it('日志为中文且包含动作描述', () => {
    const hand = makeHand();
    const next = playAction(hand, 3, { type: 'raise', amount: 100 });
    const texts = next.log.map((entry) => entry.text).join('\n');
    expect(texts).toContain('机器人3 加注到 100');
    expect(texts).toContain('小盲');
    expect(texts).toContain('大盲');
  });
});
