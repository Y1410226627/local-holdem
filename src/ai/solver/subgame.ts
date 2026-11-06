/**
 * 翻后单街子博弈 CFR+（DeepStack / Libratus endgame solving 的轻量实现）。
 *
 * 与旧 `riverSolver.ts` 的区别：
 * - 真实底牌一定在求解范围内（旧实现把 hero 底牌从牌堆移除，`actualHeroIndex` 恒为 -1）；
 * - 对手范围来自按街贝叶斯更新（旧实现河牌还在用翻前强度）；
 * - 对手的每个 combo 有独立信息集，且能看到我方下注尺度；
 * - 终局收益按「底池 / 投入」严格记账，不再把半池写死；
 * - 输出的是 hero 真实手牌在均衡中的混合策略，而不是别人的频率。
 *
 * 树：无人下注时 check / bet 33% / 50% / 100%；面对下注时 fold / call。
 * 暂不包含翻后加注（加注的底池记账需要另一套路径，先保证正确性）。
 */
import type { Card, PlayerAction } from '../../game/types';
import type { PlayerView } from '../../game/playerView';
import { derivedRng } from '../../game/cards';
import { comboKey, showdownSign } from './abstraction';
import { accumulateStrategy, averageStrategy, regretMatchingPlus } from './cfr';
import {
  buildRangeForPlayer,
  buildStreetRanges,
  normalizeRange,
  sampleRange,
  type Range,
  type RangeEntry,
} from './ranges';

export interface SubgameResult {
  action: PlayerAction;
  actionName: string;
  frequency: number;
  strategy: number[];
  actions: string[];
  iterations: number;
  villainCombos: number;
  rangeSize: number;
}

type Terminal =
  | { kind: 'heroFold'; invested: number }
  | { kind: 'showdown'; pot: number; invested: number }
  | { kind: 'villainFold'; pot: number; invested: number };

interface HeroNode {
  kind: 'hero';
  id: string;
  actions: Array<{ name: string; action: PlayerAction; next: Node }>;
}

interface VillainNode {
  kind: 'villain';
  id: string;
  actions: Array<{ name: string; next: Node }>;
}

type Node = HeroNode | VillainNode | Terminal;

function isHero(node: Node): node is HeroNode {
  return node.kind === 'hero';
}

function isVillain(node: Node): node is VillainNode {
  return node.kind === 'villain';
}

function terminalForSign(terminal: Terminal, sign: number): number {
  if (terminal.kind === 'heroFold') return -terminal.invested;
  if (terminal.kind === 'villainFold') return terminal.pot - terminal.invested;
  if (sign > 0) return terminal.pot - terminal.invested;
  if (sign < 0) return -terminal.invested;
  return terminal.pot / 2 - terminal.invested;
}

function clampBet(amount: number, maxAmount: number): number {
  if (!Number.isFinite(amount) || maxAmount <= 0) return 0;
  return Math.max(1, Math.min(maxAmount, Math.round(amount)));
}

/**
 * 构造单街子博弈树。
 * 无人下注：check / bet 33%、50%、100%；
 * 面对下注：fold / call（不做加注，避免底池记账错误）。
 */
function buildTree(input: {
  pot: number;
  toCall: number;
  effectiveStack: number;
  canCheck: boolean;
  canBet: boolean;
  canRaise: boolean;
  aggressiveType: 'bet' | 'raise' | null;
  maxRaiseTo: number;
  currentBet: number;
}): HeroNode {
  // P0 = 本街开始时的底池（view.pot 已包含本轮下注；减掉 toCall 还原）。
  const P0 = Math.max(1, input.pot - input.toCall);
  const maxTotal = Math.max(
    0,
    Math.min(input.effectiveStack, input.maxRaiseTo - input.currentBet + input.toCall),
  );
  const sizes = [0.33, 0.5, 1]
    .map((fraction) => clampBet(P0 * fraction, maxTotal))
    .filter((amount, index, list) => amount > 0 && list.indexOf(amount) === index);
  const raiseToFor = (bet: number): number =>
    Math.min(maxTotal, Math.max(bet * 2, Math.round(bet * 2.5)));

  /** 我方面对下注 b：fold / call / raise。 */
  const heroFacingBet = (bet: number): HeroNode => {
    const raiseTo = raiseToFor(bet);
    const actions: HeroNode['actions'] = [
      {
        name: 'fold',
        action: { type: 'fold' },
        next: { kind: 'heroFold', invested: 0 },
      },
      {
        name: 'call',
        action: { type: 'call' },
        next: { kind: 'showdown', pot: P0 + 2 * bet, invested: bet },
      },
    ];
    if (input.canRaise && raiseTo > bet && input.aggressiveType) {
      actions.push({
        name: `raise_${Math.round((raiseTo / Math.max(1, P0)) * 100)}`,
        action: { type: input.aggressiveType, amount: raiseTo },
        next: {
          kind: 'villain',
          id: `villain_vs_raise_${bet}_${raiseTo}`,
          actions: [
            {
              name: 'fold',
              next: { kind: 'villainFold', pot: P0 + bet, invested: 0 },
            },
            {
              name: 'call',
              next: { kind: 'showdown', pot: P0 + 2 * raiseTo, invested: raiseTo },
            },
          ],
        },
      });
    }
    return { kind: 'hero', id: `hero_vs_bet_${bet}`, actions };
  };

  /** 对手面对我方下注 b：fold / call / raise。 */
  const villainFacingBet = (bet: number): VillainNode => {
    const raiseTo = raiseToFor(bet);
    const actions: VillainNode['actions'] = [
      {
        name: 'fold',
        next: { kind: 'villainFold', pot: P0 + bet, invested: bet },
      },
      {
        name: 'call',
        next: { kind: 'showdown', pot: P0 + 2 * bet, invested: bet },
      },
    ];
    if (raiseTo > bet) {
      actions.push({
        name: `raise_${Math.round((raiseTo / Math.max(1, P0)) * 100)}`,
        next: {
          kind: 'hero',
          id: `hero_vs_raise_${bet}_${raiseTo}`,
          actions: [
            {
              name: 'fold',
              action: { type: 'fold' } as PlayerAction,
              next: { kind: 'heroFold' as const, invested: bet },
            },
            {
              name: 'call',
              action: { type: 'call' } as PlayerAction,
              next: { kind: 'showdown' as const, pot: P0 + 2 * raiseTo, invested: raiseTo },
            },
          ],
        },
      });
    }
    return { kind: 'villain', id: `villain_vs_bet_${bet}`, actions };
  };

  const actions: HeroNode['actions'] = [];
  if (input.toCall > 0) {
    // 面对下注：fold / call / raise。
    actions.push(
      {
        name: 'fold',
        action: { type: 'fold' },
        next: { kind: 'heroFold', invested: 0 },
      },
      {
        name: 'call',
        action: { type: 'call' },
        next: { kind: 'showdown', pot: P0 + 2 * input.toCall, invested: input.toCall },
      },
    );
    const raiseTo = raiseToFor(input.toCall);
    if (input.canRaise && raiseTo > input.toCall && input.aggressiveType) {
      actions.push({
        name: `raise_${Math.round((raiseTo / Math.max(1, P0)) * 100)}`,
        action: { type: input.aggressiveType, amount: raiseTo },
        next: {
          kind: 'villain',
          id: `villain_vs_raise_${input.toCall}_${raiseTo}`,
          actions: [
            { name: 'fold', next: { kind: 'villainFold', pot: P0 + input.toCall, invested: 0 } },
            { name: 'call', next: { kind: 'showdown', pot: P0 + 2 * raiseTo, invested: raiseTo } },
          ],
        },
      });
    }
    return { kind: 'hero', id: 'hero_root', actions };
  }
  if (input.canCheck) {
    actions.push({
      name: 'check',
      action: { type: 'check' },
      next: {
        kind: 'villain',
        id: 'villain_after_check',
        actions: [
          { name: 'check', next: { kind: 'showdown', pot: P0, invested: 0 } },
          ...sizes.map((amount) => ({
            name: `bet_${Math.round((amount / Math.max(1, P0)) * 100)}`,
            next: heroFacingBet(amount),
          })),
        ],
      },
    });
  }
  if (input.canBet && input.aggressiveType) {
    for (const amount of sizes) {
      actions.push({
        name: `bet_${Math.round((amount / Math.max(1, P0)) * 100)}`,
        action: { type: input.aggressiveType, amount },
        next: villainFacingBet(amount),
      });
    }
  }
  return { kind: 'hero', id: 'hero_root', actions };
}

/**
 * 求解当前街子博弈。返回 hero 真实底牌在均衡中的混合策略。
 * 只使用 PlayerView；对手范围由公开动作 + 公共牌推导。
 */
export function solveStreetSubgame(
  view: PlayerView,
  options: { iterations?: number; maxCombos?: number; ranges?: Map<number, Range> } = {},
): SubgameResult | null {
  const legal = view.legal;
  if (!legal) return null;
  // 单街子博弈只在河牌启用：转牌/翻牌的单街树会把「check-check」当成立即摊牌，
  // 忽略后续街，反而比启发式差（已用配对消融验证）。
  if (view.street !== 'river') return null;
  const opponents = view.players.filter(
    (player) => player.id !== view.viewerId && (player.status === 'active' || player.status === 'allin'),
  );
  if (opponents.length !== 1) return null; // 多人底池不走单挑子博弈
  const opponent = opponents[0];
  const hero = view.self.holeCards as [Card, Card];
  if (hero.length !== 2) return null;

  const rangeMap = options.ranges ?? buildStreetRanges(view);
  const villainRange = rangeMap.get(opponent.id);
  if (!villainRange) return null;
  const rng = derivedRng('subgame-mccfr', view.seed, view.actions.length, view.street);
  const maxCombos = Math.max(8, Math.floor(options.maxCombos ?? 80));

  // 双边范围：英雄也有范围（含自己的底牌），不再是「单手牌 vs 固定范围」。
  const heroRange = buildRangeForPlayer(view, view.viewerId, true);
  const heroKey = comboKey(hero[0], hero[1]);
  heroRange.set(heroKey, Math.max(heroRange.get(heroKey) ?? 0, 0.5));
  normalizeRange(heroRange);
  const heroCombos: RangeEntry[] = sampleRange(heroRange, maxCombos, rng, hero);
  const villainCombos: RangeEntry[] = sampleRange(villainRange, maxCombos, rng);
  if (heroCombos.length === 0 || villainCombos.length === 0) return null;
  const actualHeroIndex = heroCombos.findIndex((entry) => entry.combo.key === heroKey);
  if (actualHeroIndex < 0) return null;

  const effectiveStack = Math.min(view.self.stack, opponent.stack);
  const tree = buildTree({
    pot: view.pot,
    toCall: legal.callAmount,
    effectiveStack,
    canCheck: legal.canCheck,
    canBet: Boolean(legal.aggressiveType),
    canRaise: legal.canRaise,
    aggressiveType: legal.aggressiveType,
    maxRaiseTo: legal.maxRaiseTo,
    currentBet: legal.currentBet,
  });
  if (tree.actions.length === 0) return null;

  // 摊牌矩阵：signs[heroIndex][villainIndex]
  const signs: number[][] = heroCombos.map((heroEntry) =>
    villainCombos.map((villainEntry) =>
      showdownSign(
        [heroEntry.combo.first, heroEntry.combo.second],
        [villainEntry.combo.first, villainEntry.combo.second],
        view.board,
      ),
    ),
  );

  const heroRegret = new Map<string, number[]>();
  const heroSum = new Map<string, number[]>();
  const villainRegret = new Map<string, number[]>();
  const villainSum = new Map<string, number[]>();

  const getInfo = (
    regretMap: Map<string, number[]>,
    sumMap: Map<string, number[]>,
    key: string,
    count: number,
  ): { regret: number[]; sum: number[] } => {
    let regret = regretMap.get(key);
    if (!regret) {
      regret = new Array(count).fill(0);
      regretMap.set(key, regret);
      sumMap.set(key, new Array(count).fill(0));
    }
    return { regret, sum: sumMap.get(key)! };
  };

  const sampleWeighted = (entries: readonly RangeEntry[]): number => {
    const total = entries.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
    if (total <= 0) return Math.floor(rng() * entries.length);
    let roll = rng() * total;
    for (let index = 0; index < entries.length; index++) {
      roll -= Math.max(0, entries[index].weight);
      if (roll <= 0) return index;
    }
    return entries.length - 1;
  };

  const sampleAction = (strategy: readonly number[]): number => {
    let roll = rng();
    for (let index = 0; index < strategy.length; index++) {
      roll -= strategy[index];
      if (roll <= 0) return index;
    }
    return strategy.length - 1;
  };

  /**
   * 外部采样 MCCFR：
   * - traverser 的所有动作都展开并更新遗憾；
   * - 对手按当前策略采样一个动作；
   * - 只更新被采样到的 combo 的信息集。
   */
  const traverse = (
    node: Node,
    heroIndex: number,
    villainIndex: number,
    traverser: 'hero' | 'villain',
    iteration: number,
  ): number => {
    if (!isHero(node) && !isVillain(node)) {
      return terminalForSign(node, signs[heroIndex]?.[villainIndex] ?? 0);
    }
    if (isHero(node)) {
      const key = `${node.id}|${heroCombos[heroIndex].combo.key}`;
      const info = getInfo(heroRegret, heroSum, key, node.actions.length);
      const strategy = regretMatchingPlus(info.regret);
      if (traverser === 'hero') {
        const values: number[] = [];
        for (const action of node.actions) {
          values.push(traverse(action.next, heroIndex, villainIndex, 'hero', iteration));
        }
        let nodeValue = 0;
        for (let index = 0; index < values.length; index++) nodeValue += strategy[index] * values[index];
        for (let index = 0; index < values.length; index++) {
          info.regret[index] = Math.max(0, info.regret[index] + values[index] - nodeValue);
        }
        if (heroIndex === actualHeroIndex) {
          accumulateStrategy(info.sum, strategy, iteration);
        }
        return nodeValue;
      }
      const actionIndex = sampleAction(strategy);
      return traverse(node.actions[actionIndex].next, heroIndex, villainIndex, 'hero', iteration);
    }
    const key = `${node.id}|${villainCombos[villainIndex].combo.key}`;
    const info = getInfo(villainRegret, villainSum, key, node.actions.length);
    const strategy = regretMatchingPlus(info.regret);
    if (traverser === 'villain') {
      const values: number[] = [];
      for (const action of node.actions) {
        values.push(traverse(action.next, heroIndex, villainIndex, 'villain', iteration));
      }
      let nodeValue = 0;
      for (let index = 0; index < values.length; index++) nodeValue += strategy[index] * values[index];
      for (let index = 0; index < values.length; index++) {
        info.regret[index] = Math.max(0, info.regret[index] + values[index] - nodeValue);
      }
      accumulateStrategy(info.sum, strategy, iteration);
      return nodeValue;
    }
    const actionIndex = sampleAction(strategy);
    return traverse(node.actions[actionIndex].next, heroIndex, villainIndex, 'villain', iteration);
  };

  const iterations = Math.max(40, Math.floor(options.iterations ?? 300));
  for (let iteration = 1; iteration <= iterations; iteration++) {
    // 50% 强制采样真实底牌，保证它的策略有足够样本；其余按范围权重采样。
    const heroIndex = rng() < 0.5 ? actualHeroIndex : sampleWeighted(heroCombos);
    const villainIndex = sampleWeighted(villainCombos);
    traverse(tree, heroIndex, villainIndex, 'hero', iteration);
    traverse(tree, heroIndex, villainIndex, 'villain', iteration);
  }

  const rootKey = `${tree.id}|${heroKey}`;
  const sums = heroSum.get(rootKey);
  const strategy = sums ? averageStrategy(sums) : tree.actions.map(() => 1 / tree.actions.length);
  let bestIndex = 0;
  for (let index = 1; index < strategy.length; index++) {
    if (strategy[index] > strategy[bestIndex]) bestIndex = index;
  }
  const picked = sampleAction(strategy);
  const chosen = tree.actions[picked] ?? tree.actions[bestIndex];
  if (!chosen) return null;
  return {
    action: chosen.action,
    actionName: chosen.name,
    frequency: strategy[picked] ?? 0,
    strategy,
    actions: tree.actions.map((action) => action.name),
    iterations,
    villainCombos: villainCombos.length,
    rangeSize: villainRange.size,
  };
}
