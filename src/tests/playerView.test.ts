import { describe, expect, it } from 'vitest';
import { buildPlayerView } from '../game/playerView';
import { cardLabel } from '../game/cards';
import { CC, makeHand, playSequence, playToShowdown, playToStreet } from './helpers';

describe('PlayerView：信息隔离', () => {
  it('视图只包含自己的底牌，对手底牌不可见', () => {
    const hand = makeHand();
    const view = buildPlayerView(hand, 0, 'seed');
    expect(view.self.holeCards).toEqual(hand.players[0].holeCards);
    for (const player of view.players) {
      expect('holeCards' in player).toBe(false);
    }
    const json = JSON.stringify(view);
    for (const opponent of hand.players.slice(1)) {
      for (const card of opponent.holeCards) {
        expect(json.includes(cardLabel(card))).toBe(false);
      }
    }
  });

  it('对手底牌不同、其余完全相同 → 同一玩家的视图完全相同（无法作弊）', () => {
    const a = makeHand({
      holeCards: [undefined, CC('2c 3c'), CC('4d 5d'), CC('6h 7h')],
    });
    const b = makeHand({
      holeCards: [undefined, CC('8c 9c'), CC('Td Jd'), CC('Qh Kh')],
    });
    expect(a.players[1].holeCards).not.toEqual(b.players[1].holeCards);
    expect(JSON.stringify(buildPlayerView(a, 0, 'view-seed'))).toBe(
      JSON.stringify(buildPlayerView(b, 0, 'view-seed')),
    );
  });

  it('未轮到行动时 legal 为 null；轮到时返回当前合法动作', () => {
    const hand = makeHand();
    expect(buildPlayerView(hand, 0, 's').legal).toBeNull();
    const acting = buildPlayerView(hand, 3, 's');
    expect(acting.legal).not.toBeNull();
    expect(acting.legal!.canCall).toBe(true);
    expect(acting.legal!.callAmount).toBe(20);
    expect(acting.legal!.playerId).toBe(3);
  });

  it('摊牌后视图过滤摊牌日志，仍不包含对手底牌', () => {
    const hand = playToShowdown(makeHand());
    expect(hand.phase).toBe('complete');
    for (let viewerId = 0; viewerId < 4; viewerId++) {
      const view = buildPlayerView(hand, viewerId, 'seed');
      expect(view.log.every((entry) => entry.kind !== 'showdown')).toBe(true);
      const json = JSON.stringify(view);
      for (const opponent of hand.players) {
        if (opponent.id === viewerId) continue;
        for (const card of opponent.holeCards) {
          expect(json.includes(cardLabel(card))).toBe(false);
        }
      }
    }
  });

  it('不存在玩家时抛错', () => {
    const hand = makeHand();
    expect(() => buildPlayerView(hand, 99, 'seed')).toThrow(/找不到玩家/);
  });

  it('视图中的公共信息与引擎一致', () => {
    let hand = playToStreet(makeHand(), 'flop');
    hand = playSequence(hand, [
      [1, { type: 'bet', amount: 40 }],
      [2, { type: 'call' }],
    ]);
    const view = buildPlayerView(hand, 0, 'seed');
    expect(view.board.map(cardLabel)).toEqual(hand.board.map(cardLabel));
    expect(view.pot).toBe(hand.pot);
    expect(view.currentBet).toBe(hand.currentBet);
    expect(view.street).toBe('flop');
    expect(view.actions).toHaveLength(hand.actions.length);
    expect(view.actions[view.actions.length - 1].actorId).toBe(2);
    expect(view.players.map((player) => player.stack)).toEqual(
      hand.players.map((player) => player.stack),
    );
    expect(view.self.stack).toBe(hand.players[0].stack);
  });

  it('种子派生确定：同一手同一玩家相同，不同玩家不同', () => {
    const hand = makeHand();
    const a1 = buildPlayerView(hand, 0, 'seed-x');
    const a2 = buildPlayerView(hand, 0, 'seed-x');
    const b = buildPlayerView(hand, 1, 'seed-x');
    expect(a1.seed).toBe(a2.seed);
    expect(a1.seed).not.toBe(b.seed);
  });
});
