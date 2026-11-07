/**
 * 转牌 + 河牌联合子博弈求解（精确，不需要价值函数）。
 *
 * ## 为什么这条路是对的
 *
 * 现有 `subgame.ts` 只解**河牌**单街。转牌如果也按单街解，树的叶子会把「转牌 check-check」
 * 当成立即摊牌——但真实游戏里后面还有一条河牌街。这个建模错误让转牌求解一直是负贡献。
 *
 * 转河**联合**求解没有这个问题：树一直展开到河牌摊牌，终点就是真实收益。
 * 这是 DeepStack「深度受限求解」里唯一不需要神经网络的情形——因为深度已经到游戏终点。
 *
 * ## 河牌抽象
 *
 * 河牌有 46 张，逐张展开会让树大 46 倍。这里按**牌面影响**把 46 张分成 K 个桶
 * （成对 / 成花 / 高张 打分后等分），每个桶用桶内所有牌的摊牌矩阵**取平均**。
 * 这是标准的牌面抽象，误差远小于「用一张代表牌」。
 *
 * ## 成本
 *
 * 实测：摊牌判定 0.73µs/次，向量化 CFR+ 约 3.5 亿次乘加/秒。
 * K=4、24 手、150 次迭代时单次决策约 150–250ms，可在「思考动画」预算内。
 */
import type { Card, PlayerAction } from '../../game/types';
import type { PlayerView } from '../../game/playerView';
import { derivedRng, createDeck } from '../../game/cards';
import { cardKey, comboKey, showdownSign } from './abstraction';
import {
  buildRangeForPlayer,
  buildStreetRanges,
  normalizeRange,
  sampleRange,
  type Range,
  type RangeEntry,
} from './ranges';

const AVERAGE_SKIP = 0.5;
const REGRET_DISCOUNT_ITERS = 30;

export interface TurnRiverResult {
  action: PlayerAction;
  actionName: string;
  frequency: number;
  strategy: number[];
  actions: string[];
  iterations: number;
  combos: number;
  riverBuckets: number;
  /** 平均策略下根节点的期望收益（英雄视角，单位筹码）。价值网络的训练标签。 */
  rootValue: number;
  /** 「从现在往后还值多少」= rootValue + 自己本手已投入。价值函数的训练标签。 */
  rootValueFromNow: number;
  /** 同上，换算成大盲。 */
  rootValueBB: number;
  elapsedMs: number;
}

type Terminal =
  | { kind: 'heroFold'; invested: number }
  | { kind: 'showdown'; pot: number; invested: number }
  | { kind: 'villainFold'; pot: number; invested: number };

interface HeroNode {
  kind: 'hero';
  id: string;
  actions: Array<{ name: string; action: PlayerAction; next: Node }>;
  regret?: Float64Array;
  sum?: Float64Array;
}

interface VillainNode {
  kind: 'villain';
  id: string;
  actions: Array<{ name: string; next: Node }>;
  regret?: Float64Array;
  sum?: Float64Array;
}

/** 河牌发牌节点：每个分支是一张（桶内平均后的）摊牌矩阵 + 独立的河牌子树。 */
interface ChanceNode {
  kind: 'chance';
  id: string;
  branches: Array<{ weight: number; signs: Float64Array; next: Node }>;
}

type Node = HeroNode | VillainNode | ChanceNode | Terminal;

function clampBet(amount: number, maxAmount: number): number {
  if (!Number.isFinite(amount) || maxAmount <= 0) return 0;
  return Math.max(1, Math.min(maxAmount, Math.round(amount)));
}

/**
 * 构造河牌子树（一条新街，无人下注）。
 * `heroFirst` 决定谁先行动：单挑翻后大盲（无位置）先行动。
 */
function buildRiverTree(input: {
  heroFirst: boolean;
  pot: number;
  investedHero: number;
  investedVillain: number;
  maxTotal: number;
  aggressiveType: 'bet' | 'raise' | null;
  prefix: string;
}): Node {
  const P0 = input.pot;
  const sizes = [0.5, 1]
    .map((fraction) => clampBet(P0 * fraction, input.maxTotal))
    .filter((amount, index, list) => amount > 0 && list.indexOf(amount) === index);
  const raiseToFor = (bet: number): number =>
    Math.min(input.maxTotal, Math.max(bet * 2, Math.round(bet * 2.5)));

  /** 先行动方下注后，后行动方面对下注：fold / call / raise。 */
  const responderFacingBet = (bet: number, heroIsResponder: boolean): Node => {
    const raiseTo = raiseToFor(bet);
    const potIfCall = P0 + 2 * bet;
    const invHero = input.investedHero + (heroIsResponder ? bet : 0);
    const invVillain = input.investedVillain + (heroIsResponder ? 0 : bet);
    const actions: Array<{ name: string; action?: PlayerAction; next: Node }> = [
      {
        name: 'fold',
        action: { type: 'fold' },
        next: heroIsResponder
          ? { kind: 'heroFold', invested: invHero }
          : { kind: 'villainFold', pot: potIfCall, invested: invHero },
      },
      {
        name: 'call',
        action: { type: 'call' },
        next: { kind: 'showdown', pot: potIfCall, invested: invHero + bet },
      },
    ];
    if (input.aggressiveType && raiseTo > bet) {
      const invHeroRaise = input.investedHero + (heroIsResponder ? raiseTo : 0);
      const invVillainRaise = input.investedVillain + (heroIsResponder ? 0 : raiseTo);
      const raiserIsHero = !heroIsResponder;
      const responseActions = [
        {
          name: 'fold',
          action: { type: 'fold' as const },
          next: raiserIsHero
            ? { kind: 'villainFold' as const, pot: P0 + 2 * bet, invested: invHeroRaise }
            : { kind: 'heroFold' as const, invested: invHeroRaise },
        },
        {
          name: 'call',
          action: { type: 'call' as const },
          next: {
            kind: 'showdown' as const,
            pot: P0 + 2 * raiseTo,
            invested: Math.max(invHeroRaise, invVillainRaise),
          },
        },
      ];
      const responseNode: Node = raiserIsHero
        ? { kind: 'villain', id: `${input.prefix}_vs_raise_${bet}`, actions: responseActions as VillainNode['actions'] }
        : { kind: 'hero', id: `${input.prefix}_vs_raise_${bet}`, actions: responseActions as HeroNode['actions'] };
      actions.push({
        name: `raise_${Math.round((raiseTo / Math.max(1, P0)) * 100)}`,
        action: { type: input.aggressiveType, amount: raiseTo },
        next: responseNode,
      });
    }
    if (heroIsResponder) {
      return {
        kind: 'hero',
        id: `${input.prefix}_hero_facing_${bet}`,
        actions: actions as HeroNode['actions'],
      };
    }
    return {
      kind: 'villain',
      id: `${input.prefix}_villain_facing_${bet}`,
      actions: actions as VillainNode['actions'],
    };
  };

  /** 先行动方过牌后，后行动方的选择：check / bet。 */
  const afterCheck = (): Node => {
    const actions: Array<{ name: string; action?: PlayerAction; next: Node }> = [
      { name: 'check', action: { type: 'check' }, next: { kind: 'showdown', pot: P0, invested: input.investedHero } },
    ];
    if (input.aggressiveType) {
      for (const amount of sizes) {
        actions.push({
          name: `bet_${Math.round((amount / Math.max(1, P0)) * 100)}`,
          action: { type: input.aggressiveType, amount },
          next: responderFacingBet(amount, input.heroFirst),
        });
      }
    }
    return input.heroFirst
      ? { kind: 'villain', id: `${input.prefix}_after_check`, actions: actions as VillainNode['actions'] }
      : { kind: 'hero', id: `${input.prefix}_after_check`, actions: actions as HeroNode['actions'] };
  };

  const rootActions: Array<{ name: string; action: PlayerAction; next: Node }> = [
    { name: 'check', action: { type: 'check' }, next: afterCheck() },
  ];
  if (input.aggressiveType) {
    for (const amount of sizes) {
      rootActions.push({
        name: `bet_${Math.round((amount / Math.max(1, P0)) * 100)}`,
        action: { type: input.aggressiveType, amount },
        next: responderFacingBet(amount, !input.heroFirst),
      });
    }
  }
  return input.heroFirst
    ? { kind: 'hero', id: `${input.prefix}_root`, actions: rootActions }
    : { kind: 'villain', id: `${input.prefix}_root`, actions: rootActions as VillainNode['actions'] };
}

/** 转牌走到「本街结束」时，进入河牌发牌节点。 */
function chanceNode(
  input: { pot: number; investedHero: number; maxTotal: number; aggressiveType: 'bet' | 'raise' | null; heroFirstRiver: boolean },
  branches: Array<{ weight: number; signs: Float64Array }>,
): ChanceNode {
  return {
    kind: 'chance',
    id: 'river_chance',
    branches: branches.map((branch, index) => ({
      weight: branch.weight,
      signs: branch.signs,
      next: buildRiverTree({
        heroFirst: input.heroFirstRiver,
        pot: input.pot,
        investedHero: input.investedHero,
        investedVillain: input.investedHero,
        maxTotal: input.maxTotal,
        aggressiveType: input.aggressiveType,
        prefix: `rv${index}`,
      }),
    })),
  };
}

/**
 * 构造转牌树。转牌所有「本街结束」的路径都接到河牌发牌节点。
 * 收益口径：从**转牌开始时**算净筹码变化。
 */
function buildTurnTree(
  input: {
    pot: number;
    toCall: number;
    maxTotal: number;
    canCheck: boolean;
    canBet: boolean;
    canRaise: boolean;
    aggressiveType: 'bet' | 'raise' | null;
    heroFirstRiver: boolean;
  },
  branches: Array<{ weight: number; signs: Float64Array }>,
): Node {
  const P0 = Math.max(1, input.pot - input.toCall);
  const sizes = [0.5, 1]
    .map((fraction) => clampBet(P0 * fraction, input.maxTotal))
    .filter((amount, index, list) => amount > 0 && list.indexOf(amount) === index);
  const raiseToFor = (bet: number): number =>
    Math.min(input.maxTotal, Math.max(bet * 2, Math.round(bet * 2.5)));
  const toRiver = (invested: number): Node =>
    chanceNode(
      {
        pot: P0 + 2 * invested,
        investedHero: invested,
        maxTotal: input.maxTotal - invested,
        aggressiveType: input.aggressiveType,
        heroFirstRiver: input.heroFirstRiver,
      },
      branches,
    );

  /** 我方面对下注：fold / call / raise。 */
  const heroFacing = (bet: number): HeroNode => {
    const raiseTo = raiseToFor(bet);
    const actions: HeroNode['actions'] = [
      { name: 'fold', action: { type: 'fold' }, next: { kind: 'heroFold', invested: 0 } },
      { name: 'call', action: { type: 'call' }, next: toRiver(bet) },
    ];
    if (input.canRaise && raiseTo > bet && input.aggressiveType) {
      actions.push({
        name: `raise_${Math.round((raiseTo / Math.max(1, P0)) * 100)}`,
        action: { type: input.aggressiveType, amount: raiseTo },
        next: {
          kind: 'villain',
          id: `turn_villain_vs_raise_${bet}`,
          actions: [
            { name: 'fold', next: { kind: 'villainFold', pot: P0 + bet, invested: bet } },
            { name: 'call', next: toRiver(raiseTo) },
          ],
        },
      });
    }
    return { kind: 'hero', id: `turn_hero_facing_${bet}`, actions };
  };

  /** 对手面对我方下注：fold / call / raise。 */
  const villainFacing = (bet: number): VillainNode => {
    const raiseTo = raiseToFor(bet);
    const actions: VillainNode['actions'] = [
      { name: 'fold', next: { kind: 'villainFold', pot: P0 + bet, invested: bet } },
      { name: 'call', next: toRiver(bet) },
    ];
    if (raiseTo > bet) {
      actions.push({
        name: `raise_${Math.round((raiseTo / Math.max(1, P0)) * 100)}`,
        next: {
          kind: 'hero',
          id: `turn_hero_vs_raise_${bet}`,
          actions: [
            { name: 'fold', action: { type: 'fold' }, next: { kind: 'heroFold', invested: bet } },
            { name: 'call', action: { type: 'call' }, next: toRiver(raiseTo) },
          ],
        },
      });
    }
    return { kind: 'villain', id: `turn_villain_facing_${bet}`, actions };
  };

  const actions: HeroNode['actions'] = [];
  if (input.toCall > 0) {
    actions.push(
      { name: 'fold', action: { type: 'fold' }, next: { kind: 'heroFold', invested: 0 } },
      { name: 'call', action: { type: 'call' }, next: toRiver(input.toCall) },
    );
    const raiseTo = raiseToFor(input.toCall);
    if (input.canRaise && raiseTo > input.toCall && input.aggressiveType) {
      actions.push({
        name: `raise_${Math.round((raiseTo / Math.max(1, P0)) * 100)}`,
        action: { type: input.aggressiveType, amount: raiseTo },
        next: {
          kind: 'villain',
          id: 'turn_villain_vs_raise_root',
          actions: [
            { name: 'fold', next: { kind: 'villainFold', pot: P0 + input.toCall, invested: input.toCall } },
            { name: 'call', next: toRiver(raiseTo) },
          ],
        },
      });
    }
    return { kind: 'hero', id: 'turn_root', actions };
  }
  if (input.canCheck) {
    const afterCheck: Array<{ name: string; action?: PlayerAction; next: Node }> = [
      { name: 'check', action: { type: 'check' }, next: toRiver(0) },
    ];
    if (input.aggressiveType) {
      for (const amount of sizes) {
        afterCheck.push({
          name: `bet_${Math.round((amount / Math.max(1, P0)) * 100)}`,
          action: { type: input.aggressiveType, amount },
          next: heroFacing(amount),
        });
      }
    }
    actions.push({
      name: 'check',
      action: { type: 'check' },
      next: { kind: 'villain', id: 'turn_villain_after_check', actions: afterCheck as VillainNode['actions'] },
    });
  }
  if (input.canBet && input.aggressiveType) {
    for (const amount of sizes) {
      actions.push({
        name: `bet_${Math.round((amount / Math.max(1, P0)) * 100)}`,
        action: { type: input.aggressiveType, amount },
        next: villainFacing(amount),
      });
    }
  }
  return { kind: 'hero', id: 'turn_root', actions };
}

/* ------------------------------------------------------------------ */
/* 向量化 CFR+                                                         */
/* ------------------------------------------------------------------ */

/** 平均策略矩阵：把 `sum` 按行归一化（评估用，不做遗憾匹配）。 */
function averageMatrix(sum: Float64Array, rows: number, actions: number): Float64Array {
  const out = new Float64Array(rows * actions);
  for (let row = 0; row < rows; row++) {
    const base = row * actions;
    let total = 0;
    for (let action = 0; action < actions; action++) total += Math.max(0, sum[base + action]);
    for (let action = 0; action < actions; action++) {
      out[base + action] =
        total <= 1e-12 ? 1 / actions : Math.max(0, sum[base + action]) / total;
    }
  }
  return out;
}

function strategyMatrix(regret: Float64Array, rows: number, actions: number): Float64Array {
  const out = new Float64Array(rows * actions);
  for (let row = 0; row < rows; row++) {
    const base = row * actions;
    let total = 0;
    for (let action = 0; action < actions; action++) {
      const value = Math.max(0, regret[base + action]);
      out[base + action] = value;
      total += value;
    }
    if (total <= 1e-12) {
      for (let action = 0; action < actions; action++) out[base + action] = 1 / actions;
    } else {
      for (let action = 0; action < actions; action++) out[base + action] /= total;
    }
  }
  return out;
}

function sumOf(values: Float64Array): number {
  let total = 0;
  for (let index = 0; index < values.length; index++) total += values[index];
  return total;
}

/**
 * 河牌分桶：按「牌面影响」打分后等分成 K 组，每组用组内所有牌的摊牌矩阵平均。
 *
 * 打分 = 是否成对(2) + 是否完成同花(2) + 牌力/14。等分保证每桶非空且张数接近。
 */
function buildRiverBuckets(input: {
  board: readonly Card[];
  heroCombos: readonly RangeEntry[];
  villainCombos: readonly RangeEntry[];
  buckets: number;
}): Array<{ weight: number; signs: Float64Array; cards: Card[] }> {
  const used = new Set(input.board.map(cardKey));
  const remaining = createDeck().filter((card) => !used.has(cardKey(card)));
  const boardRanks = new Set(input.board.map((card) => card.rank));
  const suitCount = new Map<string, number>();
  for (const card of input.board) suitCount.set(card.suit, (suitCount.get(card.suit) ?? 0) + 1);
  const rankValue: Record<string, number> = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    T: 10, J: 11, Q: 12, K: 13, A: 14,
  };

  const scored = remaining.map((card) => {
    let score = (rankValue[card.rank] ?? 0) / 14;
    if (boardRanks.has(card.rank)) score += 2;
    if ((suitCount.get(card.suit) ?? 0) >= 2) score += 2;
    return { card, score };
  });
  scored.sort((a, b) => b.score - a.score);

  const bucketCount = Math.max(1, Math.min(input.buckets, scored.length));
  const groups: Card[][] = Array.from({ length: bucketCount }, () => []);
  scored.forEach((entry, index) => {
    const bucket = Math.min(bucketCount - 1, Math.floor((index * bucketCount) / scored.length));
    groups[bucket].push(entry.card);
  });

  const nH = input.heroCombos.length;
  const nV = input.villainCombos.length;
  return groups
    .filter((cards) => cards.length > 0)
    .map((cards) => {
      const signs = new Float64Array(nH * nV);
      const board = input.board;
      for (let h = 0; h < nH; h++) {
        const hero = input.heroCombos[h].combo;
        for (let v = 0; v < nV; v++) {
          const villain = input.villainCombos[v].combo;
          const blocked = new Set([
            cardKey(hero.first),
            cardKey(hero.second),
            cardKey(villain.first),
            cardKey(villain.second),
          ]);
          let total = 0;
          let count = 0;
          for (const card of cards) {
            if (blocked.has(cardKey(card))) continue;
            total += showdownSign(
              [hero.first, hero.second],
              [villain.first, villain.second],
              [...board, card],
            );
            count += 1;
          }
          signs[h * nV + v] = count > 0 ? total / count : 0;
        }
      }
      return { weight: cards.length / scored.length, signs, cards };
    });
}

/**
 * 求解转牌 + 河牌联合子博弈。返回 hero 真实底牌在均衡中的混合策略。
 * 只使用 PlayerView；对手范围由公开动作 + 公共牌推导。
 */
export function solveTurnRiver(
  view: PlayerView,
  options: {
    iterations?: number;
    maxCombos?: number;
    riverBuckets?: number;
    ranges?: Map<number, Range>;
    timeBudgetMs?: number;
  } = {},
): TurnRiverResult | null {
  const startedAt = Date.now();
  const legal = view.legal;
  if (!legal) return null;
  if (view.street !== 'turn') return null;
  const opponents = view.players.filter(
    (player) => player.id !== view.viewerId && (player.status === 'active' || player.status === 'allin'),
  );
  if (opponents.length !== 1) return null;
  const opponent = opponents[0];
  const hero = view.self.holeCards as [Card, Card];
  if (hero.length !== 2) return null;

  const rangeMap = options.ranges ?? buildStreetRanges(view);
  const villainRange = rangeMap.get(opponent.id);
  if (!villainRange) return null;

  const rng = derivedRng('turn-river-cfr', view.seed, view.actions.length, view.street);
  const maxCombos = Math.max(8, Math.floor(options.maxCombos ?? 24));
  const heroRange = buildRangeForPlayer(view, view.viewerId, true);
  const heroKey = comboKey(hero[0], hero[1]);
  normalizeRange(heroRange);
  const heroCombos = sampleRange(heroRange, maxCombos, rng, hero);
  const villainCombos = sampleRange(villainRange, maxCombos, rng);
  const nH = heroCombos.length;
  const nV = villainCombos.length;
  if (nH === 0 || nV === 0) return null;
  const actualHeroIndex = heroCombos.findIndex((entry) => entry.combo.key === heroKey);
  if (actualHeroIndex < 0) return null;

  const branches = buildRiverBuckets({
    board: view.board,
    heroCombos,
    villainCombos,
    buckets: options.riverBuckets ?? 4,
  });
  if (branches.length === 0) return null;

  const effectiveStack = Math.min(view.self.stack, opponent.stack);
  // 单挑翻后：大盲（无位置）先行动。hero 是按钮则 hero 在河牌后行动。
  const heroSeat = view.players.findIndex((player) => player.id === view.viewerId);
  const heroFirstRiver = heroSeat !== view.buttonIndex;

  const tree = buildTurnTree(
    {
      pot: view.pot,
      toCall: legal.callAmount,
      maxTotal: Math.min(effectiveStack, legal.maxRaiseTo - legal.currentBet + legal.callAmount),
      canCheck: legal.canCheck,
      canBet: Boolean(legal.aggressiveType),
      canRaise: legal.canRaise,
      aggressiveType: legal.aggressiveType,
      heroFirstRiver,
    },
    branches,
  );

  const heroRootReach = new Float64Array(nH);
  let heroWeight = 0;
  for (let h = 0; h < nH; h++) {
    heroRootReach[h] = Math.max(0, heroCombos[h].weight);
    heroWeight += heroRootReach[h];
  }
  if (heroWeight <= 0) heroRootReach.fill(1 / nH);
  else for (let h = 0; h < nH; h++) heroRootReach[h] /= heroWeight;

  const villainRootReach = new Float64Array(nV);
  let villainWeight = 0;
  for (let v = 0; v < nV; v++) {
    villainRootReach[v] = Math.max(0, villainCombos[v].weight);
    villainWeight += villainRootReach[v];
  }
  if (villainWeight <= 0) villainRootReach.fill(1 / nV);
  else for (let v = 0; v < nV; v++) villainRootReach[v] /= villainWeight;

  const ensureInfo = (node: HeroNode | VillainNode, rows: number): void => {
    if (node.regret) return;
    node.regret = new Float64Array(rows * node.actions.length);
    node.sum = new Float64Array(rows * node.actions.length);
  };

  const traverse = (
    node: Node,
    heroReach: Float64Array,
    villainReach: Float64Array,
    outHero: Float64Array,
    outVillain: Float64Array,
    weight: number,
    signs: Float64Array,
    evaluateOnly = false,
  ): void => {
    if (node.kind === 'heroFold') {
      outHero.fill(-node.invested * sumOf(villainReach));
      outVillain.fill(node.invested * sumOf(heroReach));
      return;
    }
    if (node.kind === 'villainFold') {
      const win = node.pot - node.invested;
      outHero.fill(win * sumOf(villainReach));
      outVillain.fill(-win * sumOf(heroReach));
      return;
    }
    if (node.kind === 'showdown') {
      const win = node.pot - node.invested;
      const lose = -node.invested;
      const tie = node.pot / 2 - node.invested;
      for (let h = 0; h < nH; h++) {
        const row = h * nV;
        let total = 0;
        for (let v = 0; v < nV; v++) {
          const sign = signs[row + v];
          total += (sign > 0 ? win : sign < 0 ? lose : tie) * villainReach[v];
        }
        outHero[h] = total;
      }
      for (let v = 0; v < nV; v++) {
        let total = 0;
        for (let h = 0; h < nH; h++) {
          const sign = signs[h * nV + v];
          total -= (sign > 0 ? win : sign < 0 ? lose : tie) * heroReach[h];
        }
        outVillain[v] = total;
      }
      return;
    }
    if (node.kind === 'chance') {
      outHero.fill(0);
      outVillain.fill(0);
      const tmpHero = new Float64Array(nH);
      const tmpVillain = new Float64Array(nV);
      for (const branch of node.branches) {
        traverse(branch.next, heroReach, villainReach, tmpHero, tmpVillain, weight, branch.signs, evaluateOnly);
        for (let h = 0; h < nH; h++) outHero[h] += branch.weight * tmpHero[h];
        for (let v = 0; v < nV; v++) outVillain[v] += branch.weight * tmpVillain[v];
      }
      return;
    }

    const rows = node.kind === 'hero' ? nH : nV;
    const actionCount = node.actions.length;
    ensureInfo(node, rows);
    const regret = node.regret!;
    const sum = node.sum!;
    const strategy = evaluateOnly
      ? averageMatrix(sum, rows, actionCount)
      : strategyMatrix(regret, rows, actionCount);
    const ownReach = node.kind === 'hero' ? heroReach : villainReach;
    const childHero: Float64Array[] = [];
    const childVillain: Float64Array[] = [];
    const scaled = new Float64Array(rows);
    for (let action = 0; action < actionCount; action++) {
      const ch = new Float64Array(nH);
      const cv = new Float64Array(nV);
      for (let index = 0; index < rows; index++) scaled[index] = ownReach[index] * strategy[index * actionCount + action];
      if (node.kind === 'hero') {
        traverse(node.actions[action].next, scaled, villainReach, ch, cv, weight, signs, evaluateOnly);
      } else {
        traverse(node.actions[action].next, heroReach, scaled, ch, cv, weight, signs, evaluateOnly);
      }
      childHero.push(ch);
      childVillain.push(cv);
    }
    const isHero = node.kind === 'hero';
    const outOwn = isHero ? outHero : outVillain;
    const outOpp = isHero ? outVillain : outHero;
    const childOwn = isHero ? childHero : childVillain;
    const childOpp = isHero ? childVillain : childHero;
    for (let index = 0; index < rows; index++) {
      const base = index * actionCount;
      let total = 0;
      for (let action = 0; action < actionCount; action++) total += strategy[base + action] * childOwn[action][index];
      outOwn[index] = total;
    }
    const oppSize = isHero ? nV : nH;
    for (let index = 0; index < oppSize; index++) {
      let total = 0;
      for (let action = 0; action < actionCount; action++) total += childOpp[action][index];
      outOpp[index] = total;
    }
    if (evaluateOnly) return;
    for (let index = 0; index < rows; index++) {
      const base = index * actionCount;
      const nodeValue = outOwn[index];
      for (let action = 0; action < actionCount; action++) {
        const slot = base + action;
        regret[slot] = Math.max(0, regret[slot] + childOwn[action][index] - nodeValue);
      }
    }
    if (weight > 0) {
      for (let index = 0; index < rows; index++) {
        const base = index * actionCount;
        const reach = weight * ownReach[index];
        for (let action = 0; action < actionCount; action++) sum[base + action] += reach * strategy[base + action];
      }
    }
  };

  /**
   * 策略评估：用**平均策略**再遍历一次，求根节点的期望收益（英雄视角，单位筹码）。
   *
   * 这是 B 路线（价值网络）的标签来源——没有它就不知道「这个转牌局面对我方值多少」。
   */
  const evaluateRootValue = (): number => {
    const heroOut = new Float64Array(nH);
    const villainOut = new Float64Array(nV);
    traverse(tree, heroRootReach, villainRootReach, heroOut, villainOut, 0, branches[0].signs, true);
    let ev = 0;
    for (let h = 0; h < nH; h++) ev += heroRootReach[h] * heroOut[h];
    return ev;
  };
  const iterations = Math.max(1, Math.floor(options.iterations ?? 200));
  const budget = options.timeBudgetMs ?? 0;
  const outHero = new Float64Array(nH);
  const outVillain = new Float64Array(nV);
  const emptySigns = branches[0].signs;
  let completed = 0;
  for (let iteration = 1; iteration <= iterations; iteration++) {
    const weight = iteration <= iterations * AVERAGE_SKIP ? 0 : iteration;
    traverse(tree, heroRootReach, villainRootReach, outHero, outVillain, weight, emptySigns);
    if (iteration <= REGRET_DISCOUNT_ITERS) {
      const factor = Math.sqrt(iteration) / (Math.sqrt(iteration) + 1);
      const discount = (node: Node): void => {
        if (node.kind === 'hero' || node.kind === 'villain') {
          if (node.regret) for (let index = 0; index < node.regret.length; index++) node.regret[index] *= factor;
          for (const action of node.actions) discount(action.next);
        } else if (node.kind === 'chance') {
          for (const branch of node.branches) discount(branch.next);
        }
      };
      discount(tree);
    }
    completed = iteration;
    if (budget > 0 && iteration >= 40 && Date.now() - startedAt > budget) break;
  }

  // 必须在 CFR 迭代**之后**评估：之前 sum 还是空的，等于用均匀随机策略算价值
  const rootValue = evaluateRootValue();

  const actionCount = (tree as HeroNode).actions.length;
  let strategy: number[];
  if (tree.kind === 'hero' && tree.sum) {
    const base = actualHeroIndex * actionCount;
    const row: number[] = [];
    for (let action = 0; action < actionCount; action++) row.push(tree.sum[base + action]);
    const total = row.reduce((sum, value) => sum + value, 0);
    strategy = total > 1e-12 ? row.map((value) => value / total) : row.map(() => 1 / actionCount);
  } else {
    strategy = Array.from({ length: actionCount }, () => 1 / actionCount);
  }

  const pickRng = derivedRng('turn-river-pick', view.seed, view.actions.length, view.street);
  let bestIndex = 0;
  for (let index = 1; index < strategy.length; index++) {
    if (strategy[index] > strategy[bestIndex]) bestIndex = index;
  }
  let roll = pickRng();
  let picked = bestIndex;
  for (let index = 0; index < strategy.length; index++) {
    roll -= strategy[index];
    if (roll <= 0) {
      picked = index;
      break;
    }
  }
  const actions = (tree as HeroNode).actions;
  const chosen = actions[picked] ?? actions[bestIndex];
  if (!chosen) return null;
  return {
    action: chosen.action,
    actionName: chosen.name,
    frequency: strategy[picked] ?? 0,
    strategy,
    actions: actions.map((action) => action.name),
    iterations: completed,
    combos: nH,
    riverBuckets: branches.length,
    rootValue,
    // 终局记的是「从当前节点往后的投入」，所以 rootValue 本身就是「从现在起还值多少」。
    // （实测：空气牌弃牌 ≈ 0，暗三条面对下注 ≈ +43 筹码）
    rootValueFromNow: rootValue,
    rootValueBB: rootValue / Math.max(1, view.bigBlind),
    elapsedMs: Date.now() - startedAt,
  };
}
