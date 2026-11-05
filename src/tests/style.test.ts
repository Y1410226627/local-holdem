import { describe, expect, it } from 'vitest';
import {
  BASE_DIFFICULTY_PROFILES,
  DIFFICULTY_PROFILES,
  getDifficultyProfile,
} from '../ai/difficulty';
import {
  applyStyleVariant,
  BOT_STYLES,
  LOCAL_TALK_LINES,
  pickLocalTalk,
  sampleSizeIndex,
  shouldLocalTalk,
  styleById,
  styleById as resolveStyle,
  styleLabel,
  stylePromptHint,
  variationRateFor,
} from '../ai/style';
import { BOT_STYLE_COUNT, seededRng } from '../game/cards';
import { act, createTable, startNextHand } from '../game/stateMachine';
import { buildPlayerView } from '../game/playerView';
import { getLegalActions } from '../game/gameEngine';
import { decide } from '../ai/aiPlayer';
import { CC, makeHand, playToStreet } from './helpers';
import type { Difficulty } from '../game/types';

const STYLE_IDS = Array.from({ length: BOT_STYLE_COUNT }, (_item, index) => index);

describe('风格原型：定义与边界', () => {
  it('风格数量与引擎常量一致，key / label 唯一', () => {
    expect(BOT_STYLES).toHaveLength(BOT_STYLE_COUNT);
    expect(new Set(BOT_STYLES.map((style) => style.key)).size).toBe(BOT_STYLES.length);
    expect(new Set(BOT_STYLES.map((style) => style.label)).size).toBe(BOT_STYLES.length);
    for (const style of BOT_STYLES) {
      expect(style.variationRate).toBeGreaterThan(0);
      expect(style.variationRate).toBeLessThanOrEqual(1);
    }
  });

  it('未分配风格时 profile 不变；分配后仍在难度基础值附近', () => {
    for (const difficulty of ['beginner', 'normal', 'hard', 'expert'] as Difficulty[]) {
      const base = DIFFICULTY_PROFILES[difficulty];
      expect(applyStyleVariant(base, undefined)).toBe(base);
      for (const styleId of STYLE_IDS) {
        const styled = applyStyleVariant(base, styleId);
        expect(Math.abs(styled.preflop.play - base.preflop.play)).toBeLessThanOrEqual(0.18);
        expect(Math.abs(styled.preflop.raise - base.preflop.raise)).toBeLessThanOrEqual(0.16);
        expect(styled.preflop.play).toBeGreaterThanOrEqual(0.03);
        expect(styled.preflop.play).toBeLessThanOrEqual(0.85);
        expect(styled.preflop.raise).toBeGreaterThan(styled.preflop.play);
        expect(styled.preflop.threeBet).toBeGreaterThan(styled.preflop.raise);
        expect(styled.postflop.bluffRate).toBeGreaterThan(0);
        expect(styled.postflop.bluffRate).toBeLessThanOrEqual(0.45);
        expect(styled.preflop.errorRate).toBeLessThanOrEqual(0.15);
        // 难度档的牌型结构不被风格破坏
        expect(styled.postflop.mcIterations).toBe(base.postflop.mcIterations);
        expect(styled.postflop.positionAware).toBe(base.postflop.positionAware);
      }
    }
  });

  it('风格差异可观察：疯子比紧弱更松更凶，但入门档仍弱于专家档', () => {
    const maniac = applyStyleVariant(DIFFICULTY_PROFILES.normal, STYLE_IDS[4]);
    const nit = applyStyleVariant(DIFFICULTY_PROFILES.normal, STYLE_IDS[2]);
    expect(maniac.preflop.play).toBeGreaterThan(nit.preflop.play);
    expect(maniac.preflop.bluffRaiseRate).toBeGreaterThan(nit.preflop.bluffRaiseRate);
    expect(maniac.postflop.bluffRate).toBeGreaterThan(nit.postflop.bluffRate);
    expect(maniac.preflop.mixRaiseRate).toBeGreaterThan(nit.preflop.mixRaiseRate);

    const beginnerManiac = applyStyleVariant(DIFFICULTY_PROFILES.beginner, STYLE_IDS[4]);
    const expertNit = applyStyleVariant(DIFFICULTY_PROFILES.expert, STYLE_IDS[2]);
    expect(expertNit.preflop.play).toBeGreaterThan(beginnerManiac.preflop.play);
    expect(expertNit.postflop.bluffRate).toBeGreaterThan(beginnerManiac.postflop.bluffRate);
  });

  it('同风格同难度结果完全确定，不同风格结果不同', () => {
    const base = DIFFICULTY_PROFILES.hard;
    expect(applyStyleVariant(base, 1)).toEqual(applyStyleVariant(base, 1));
    expect(applyStyleVariant(base, 1)).not.toEqual(applyStyleVariant(base, 2));
  });

  it('variationRateFor：疯子更高，入门档随机化更保守', () => {
    const maniac = BOT_STYLES.findIndex((style) => style.key === 'maniac');
    const nit = BOT_STYLES.findIndex((style) => style.key === 'nit');
    expect(variationRateFor(maniac, 'normal')).toBeGreaterThan(variationRateFor(nit, 'normal'));
    expect(variationRateFor(maniac, 'beginner')).toBeLessThan(variationRateFor(maniac, 'normal'));
  });

  it('风格化尺度偏好：疯子偏大尺度，紧弱偏小尺度', () => {
    const maniac = BOT_STYLES.findIndex((style) => style.key === 'maniac');
    const nit = BOT_STYLES.findIndex((style) => style.key === 'nit');
    const sizes = [0.5, 2 / 3, 1] as const;
    const rngA = seededRng('size-maniac');
    const rngB = seededRng('size-maniac');
    let maniacSum = 0;
    let nitSum = 0;
    for (let i = 0; i < 500; i++) {
      maniacSum += sampleSizeIndex(seededRng(`maniac-${i}`), sizes, maniac);
      nitSum += sampleSizeIndex(seededRng(`nit-${i}`), sizes, nit);
    }
    expect(rngA()).toBe(rngB()); // 对照：固定种子可复现
    expect(maniacSum).toBeGreaterThan(nitSum);
  });

  it('风格提示词名与台词：非空、确定性、长度合理', () => {
    expect(stylePromptHint(0)).toContain('tight-aggressive');
    expect(stylePromptHint(undefined)).toBeNull();
    for (const styleId of STYLE_IDS) {
      const line = pickLocalTalk(styleId, 'seed', 1, 2);
      expect(line.length).toBeGreaterThan(0);
      expect(line.length).toBeLessThanOrEqual(20);
      expect(pickLocalTalk(styleId, 'seed', 1, 2)).toBe(line);
      expect(LOCAL_TALK_LINES[resolveStyle(styleId)!.key].length).toBeGreaterThan(2);
    }
    let talks = 0;
    for (let i = 0; i < 200; i++) {
      if (shouldLocalTalk(0, 'talk', i)) talks += 1;
    }
    expect(talks).toBeGreaterThan(10);
    expect(talks).toBeLessThan(190);
  });
});

describe('风格：牌桌分配与视图', () => {
  it('createTable 给机器人分配风格，同种子可复现、换种子变化', () => {
    const a = createTable({ playerCount: 4, seed: 'style-table-a' });
    const a2 = createTable({ playerCount: 4, seed: 'style-table-a' });
    const b = createTable({ playerCount: 4, seed: 'style-table-b' });
    const styleIdsA = a.players.filter((player) => !player.isHuman).map((player) => player.styleId);
    const styleIdsA2 = a2.players.filter((player) => !player.isHuman).map((player) => player.styleId);
    const styleIdsB = b.players.filter((player) => !player.isHuman).map((player) => player.styleId);
    expect(styleIdsA).toEqual(styleIdsA2);
    expect(styleIdsA.every((styleId) => styleId !== undefined)).toBe(true);
    expect(new Set(styleIdsA).size).toBeGreaterThanOrEqual(3);
    expect(styleIdsB).not.toEqual(styleIdsA);
  });

  it('风格随新局（新种子）重新洗牌，重置筹码注入新种子也会重排', () => {
    const table = createTable({ playerCount: 4, seed: 'style-reset-a' });
    const before = table.players.map((player) => player.styleId);
    const second = createTable({ playerCount: 4, seed: 'style-reset-a' });
    expect(second.players.map((player) => player.styleId)).toEqual(before);
  });

  it('PlayerView 暴露自己的 styleId，且 AI 决策调试信息带风格标签', async () => {
    let table = startNextHand(createTable({ playerCount: 4, seed: 'style-view' }));
    let guard = 0;
    while (table.phase === 'playing' && guard < 200) {
      guard += 1;
      const hand = table.hand!;
      const actorIndex = hand.actingIndex!;
      const actor = hand.players[actorIndex];
      if (!actor.isHuman) {
        const view = buildPlayerView(hand, actor.id, table.config.seed);
        expect(view.self.styleId).toBe(actor.styleId);
        expect(styleLabel(view.self.styleId)).toBeTruthy();
        break;
      }
      const legal = getLegalActions(hand, actorIndex);
      table = act(table, actorIndex, legal.canCheck ? { type: 'check' } : { type: 'fold' });
    }
    expect(guard).toBeLessThan(200);
  });

  it('getDifficultyProfile 本身不带风格；风格只在 AI 运行时叠加', () => {
    for (const difficulty of ['beginner', 'normal', 'hard', 'expert'] as Difficulty[]) {
      expect(getDifficultyProfile(difficulty, false)).toBe(BASE_DIFFICULTY_PROFILES[difficulty]);
    }
    expect(styleById(0)?.label).toBe('紧凶');
    expect(styleById(99)?.label).toBe(resolveStyle(99)?.label);
  });
});

describe('体验随机：风格化决策确实会产生变化', () => {
  it('同一个翻后局面在独立随机流下会出现“随机化”决策，但同种子仍完全确定', async () => {
    const hand = makeHand({
      holeCards: [CC('Ah Kh'), CC('2c 3c'), CC('4d 5d'), CC('6s 7s')],
      board: CC('Qh 9d 4c 2s 7h'),
    });
    const flop = playToStreet(hand, 'flop');
    const actorIndex = flop.actingIndex!;
    const actor = flop.players[actorIndex];
    const maniacStyle = BOT_STYLES.findIndex((style) => style.key === 'maniac');
    // 构造“强牌 + 可以过牌的自由局面”：正常策略倾向下注，风格层有一定概率改为慢玩过牌。
    const buildView = (seed: string) => {
      const view = buildPlayerView(flop, actor.id, seed);
      view.self.styleId = maniacStyle;
      view.board = CC('Qh 9d 4c 2s 7h');
      view.self.holeCards = CC('Qs Qd');
      return view;
    };
    const first = await decide(buildView('style-variation-0'), 'normal');
    let varied = 0;
    let plain = 0;
    for (let i = 0; i < 160; i++) {
      const decision = await decide(buildView(`style-variation-${i}`), 'normal');
      if (decision.debug.reasoning.includes('随机化')) varied += 1;
      else plain += 1;
    }
    expect(varied).toBeGreaterThan(0);
    expect(plain).toBeGreaterThan(0);
    const repeat = await decide(buildView('style-variation-0'), 'normal');
    expect(repeat.action).toEqual(first.action);
    expect(repeat.debug.reasoning).toBe(first.debug.reasoning);
  });
});
