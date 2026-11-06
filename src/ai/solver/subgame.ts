/**
 * 河牌单街子博弈 CFR+（DeepStack continual re-solving / Libratus endgame solving 的轻量实现）。
 *
 * 算法口径直接来自论文，不是“借个名词”：
 *
 * - **DeepStack**（Science 2017，arXiv:1701.01724）附录 S3：
 *   “The algorithm DeepStack uses to solve the augmented game is a hybrid of vanilla CFR and CFR+,
 *   which uses regret matching+ like CFR+, but does uniform weighting and simultaneous updates like
 *   vanilla CFR. When computing the final average strategy and average counterfactual values, we
 *   omit the early iterations of CFR in the averages.” 稀疏树约 1000 次迭代。
 *   → 本文件用「遗憾匹配+ + 线性平均 + 同时更新（不采样）」。
 *
 * - **Brown/Sandholm/Amos, Depth-Limited Solving**（NeurIPS 2018，arXiv:1805.08195）附录 B：
 *   “ignore the first 50% of iterations when determining the average strategy. Moreover, for the
 *   first 30 iterations, we discount the regrets after each iteration by √T/(√T+1)… This reduces
 *   exploitability in the subgame by about a factor of three.” 河牌跑 300–2000 次 CFR+。
 *   → 本文件实现 `AVERAGE_SKIP=0.5` 与 `REGRET_DISCOUNT_ITERS=30`。
 *
 * - **标准 CFR 更新式**见 cpp-cfr（bakanaouji/cpp-cfr）`Trainer.cpp:382-391`：
 *   `R[a] += π_{-i}·(v[a] − v)`、`S[a] += π_i·σ[a]`。
 *
 * ## 相对旧版的关键修正
 *
 * 旧版用**外部采样 MCCFR**：每轮只采一对底牌，只更新那一个 combo 的信息集。
 * 60 个 combo × 300 轮时，每个信息集平均只被更新约 5 次——策略等同随机。
 * 这才是配对消融里「求解器 −20.5 BB/100」的真正原因，而不是“树里没有加注”
 * （加注补上后只从 −20.5 回到 −5）。
 *
 * 现在每轮遍历整棵公共树、**同时更新全部 combo**（把 range 当作向量化维度），
 * 与 DeepStack 的做法一致。同等时间下每个信息集的更新次数提高约两个数量级。
 *
 * ## 已知边界（诚实标注）
 *
 * - 只解**河牌**。翻牌/转牌的单街树会把「check-check」当成立即摊牌，忽略后续街；
 *   要正确解转牌，必须在叶子接一个价值函数（DeepStack 的 counterfactual value network），
 *   本项目没有训练，所以不做。
 * - 属于 **unsafe subgame solving**（没有加 CFR-D gadget 的 opt-out）。
 *   Depth-Limited 论文附录明确：第一次到达第三轮时用 unsafe，之后才用 safe nested；
 *   我们每次只解一次河牌根节点，符合“第一次”的用法。若要连续 re-solve，需要补 gadget。
 * - 摊牌矩阵按 combo 精确计算，不做牌力分桶（DeepStack 用分桶换速度）。
 */
import type { Card, PlayerAction } from '../../game/types';
import type { PlayerView } from '../../game/playerView';
import { derivedRng } from '../../game/cards';
import { comboKey, showdownSign } from './abstraction';
import {
  buildRangeForPlayer,
  buildStreetRanges,
  normalizeRange,
  sampleRange,
  type Range,
  type RangeEntry,
} from './ranges';

/** 平均策略丢弃前 50% 迭代（arXiv:1805.08195 附录 B）。 */
const AVERAGE_SKIP = 0.5;
/** 前 30 轮按 √T/(√T+1) 折减遗憾（arXiv:1805.08195 附录 B）。 */
const REGRET_DISCOUNT_ITERS = 30;

export interface SubgameResult {
  action: PlayerAction;
  actionName: string;
  frequency: number;
  strategy: number[];
  actions: string[];
  iterations: number;
  villainCombos: number;
  rangeSize: number;
  /** 实际耗时（毫秒），用于性能回归与降载判断。 */
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

type Node = HeroNode | VillainNode | Terminal;

function clampBet(amount: number, maxAmount: number): number {
  if (!Number.isFinite(amount) || maxAmount <= 0) return 0;
  return Math.max(1, Math.min(maxAmount, Math.round(amount)));
}

/**
 * 构造单街子博弈树。
 * 无人下注：check / bet 33%、50%、100%；
 * 面对下注：fold / call / raise。
 *
 * 底池记账口径：`P0` 是本街开始前的死钱，`invested` 是双方在本街各自已投入的等额筹码。
 * 摊牌净收益 = (P0 + 2·invested) − invested = P0 + invested（赢）/ −invested（输）/ P0/2（平）。
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
  // view.pot 已包含本轮下注；减掉 toCall 还原本街死钱。
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
      { name: 'fold', action: { type: 'fold' }, next: { kind: 'heroFold', invested: 0 } },
      { name: 'call', action: { type: 'call' }, next: { kind: 'showdown', pot: P0 + 2 * bet, invested: bet } },
    ];
    if (input.canRaise && raiseTo > bet && input.aggressiveType) {
      actions.push({
        name: `raise_${Math.round((raiseTo / Math.max(1, P0)) * 100)}`,
        action: { type: input.aggressiveType, amount: raiseTo },
        next: {
          kind: 'villain',
          id: `villain_vs_raise_${bet}_${raiseTo}`,
          actions: [
            { name: 'fold', next: { kind: 'villainFold', pot: P0 + bet, invested: 0 } },
            { name: 'call', next: { kind: 'showdown', pot: P0 + 2 * raiseTo, invested: raiseTo } },
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
      { name: 'fold', next: { kind: 'villainFold', pot: P0 + bet, invested: bet } },
      { name: 'call', next: { kind: 'showdown', pot: P0 + 2 * bet, invested: bet } },
    ];
    if (raiseTo > bet) {
      actions.push({
        name: `raise_${Math.round((raiseTo / Math.max(1, P0)) * 100)}`,
        next: {
          kind: 'hero',
          id: `hero_vs_raise_${bet}_${raiseTo}`,
          actions: [
            { name: 'fold', action: { type: 'fold' }, next: { kind: 'heroFold', invested: bet } },
            { name: 'call', action: { type: 'call' }, next: { kind: 'showdown', pot: P0 + 2 * raiseTo, invested: raiseTo } },
          ],
        },
      });
    }
    return { kind: 'villain', id: `villain_vs_bet_${bet}`, actions };
  };

  const actions: HeroNode['actions'] = [];
  if (input.toCall > 0) {
    actions.push(
      { name: 'fold', action: { type: 'fold' }, next: { kind: 'heroFold', invested: 0 } },
      { name: 'call', action: { type: 'call' }, next: { kind: 'showdown', pot: P0 + 2 * input.toCall, invested: input.toCall } },
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

/** 把一组遗憾按「每行一手牌」做遗憾匹配+，返回扁平 nRows×nActions 策略矩阵。 */
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
 * 求解当前街子博弈。返回 hero 真实底牌在均衡中的混合策略。
 * 只使用 PlayerView；对手范围由公开动作 + 公共牌推导。
 */
export function solveStreetSubgame(
  view: PlayerView,
  options: {
    iterations?: number;
    maxCombos?: number;
    ranges?: Map<number, Range>;
    /** 时间预算（毫秒）；超预算时提前停迭代，已积累的平均策略仍然有效。 */
    timeBudgetMs?: number;
  } = {},
): SubgameResult | null {
  const startedAt = Date.now();
  const legal = view.legal;
  if (!legal) return null;
  // 只解河牌：转牌/翻牌的单街树会把 check-check 当成立即摊牌，需要价值函数才正确。
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
  const rng = derivedRng('subgame-cfr', view.seed, view.actions.length, view.street);
  const maxCombos = Math.max(8, Math.floor(options.maxCombos ?? 40));

  // 双边范围：英雄也有范围（含自己的底牌）。
  const heroRange = buildRangeForPlayer(view, view.viewerId, true);
  const heroKey = comboKey(hero[0], hero[1]);
  // 不要再把真实底牌的权重抬到 0.5：那会让「我方范围」几乎退化成单手牌，
  // 对手的最佳回应随之完全错位。sampleRange 已负责强制包含真实底牌。
  normalizeRange(heroRange);
  const heroCombos: RangeEntry[] = sampleRange(heroRange, maxCombos, rng, hero);
  const villainCombos: RangeEntry[] = sampleRange(villainRange, maxCombos, rng);
  const nH = heroCombos.length;
  const nV = villainCombos.length;
  if (nH === 0 || nV === 0) return null;
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

  // 摊牌矩阵：signs[h*nV+v] ∈ {+1,0,-1}，只算一次。
  const signs = new Float64Array(nH * nV);
  for (let h = 0; h < nH; h++) {
    for (let v = 0; v < nV; v++) {
      signs[h * nV + v] = showdownSign(
        [heroCombos[h].combo.first, heroCombos[h].combo.second],
        [villainCombos[v].combo.first, villainCombos[v].combo.second],
        view.board,
      );
    }
  }

  // 初始 reach = 归一化后的范围权重（chance 已包含在权重里）。
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

  /**
   * 全树遍历，同时计算双方的反事实价值（按手牌）。
   * outHero[h] / outVillain[v] 会被**覆盖写入**。
   *
   * 关键性质：hero 的反事实价值不依赖 heroReach（CFR 的定义），
   * 所以把 heroReach 按 σ 缩放只影响对手的价值，不影响自己的遗憾。
   */
  const traverse = (
    node: Node,
    heroReach: Float64Array,
    villainReach: Float64Array,
    outHero: Float64Array,
    outVillain: Float64Array,
    averageWeight: number,
  ): void => {
    if (node.kind === 'heroFold') {
      const totalVillain = sumOf(villainReach);
      outHero.fill(-node.invested * totalVillain);
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
          const payoff = sign > 0 ? win : sign < 0 ? lose : tie;
          total += payoff * villainReach[v];
        }
        outHero[h] = total;
      }
      for (let v = 0; v < nV; v++) {
        let total = 0;
        for (let h = 0; h < nH; h++) {
          const sign = signs[h * nV + v];
          const payoff = sign > 0 ? win : sign < 0 ? lose : tie;
          total -= payoff * heroReach[h];
        }
        outVillain[v] = total;
      }
      return;
    }

    if (node.kind === 'hero') {
      const actionCount = node.actions.length;
      ensureInfo(node, nH);
      const regret = node.regret!;
      const sum = node.sum!;
      const strategy = strategyMatrix(regret, nH, actionCount);
      const childHero: Float64Array[] = [];
      const childVillain: Float64Array[] = [];
      const scaled = new Float64Array(nH);
      for (let action = 0; action < actionCount; action++) {
        const ch = new Float64Array(nH);
        const cv = new Float64Array(nV);
        for (let h = 0; h < nH; h++) scaled[h] = heroReach[h] * strategy[h * actionCount + action];
        traverse(node.actions[action].next, scaled, villainReach, ch, cv, averageWeight);
        childHero.push(ch);
        childVillain.push(cv);
      }
      for (let h = 0; h < nH; h++) {
        const base = h * actionCount;
        let total = 0;
        for (let action = 0; action < actionCount; action++) {
          total += strategy[base + action] * childHero[action][h];
        }
        outHero[h] = total;
      }
      for (let v = 0; v < nV; v++) {
        let total = 0;
        for (let action = 0; action < actionCount; action++) total += childVillain[action][v];
        outVillain[v] = total;
      }
      for (let h = 0; h < nH; h++) {
        const base = h * actionCount;
        const nodeValue = outHero[h];
        for (let action = 0; action < actionCount; action++) {
          const index = base + action;
          regret[index] = Math.max(0, regret[index] + childHero[action][h] - nodeValue);
        }
      }
      if (averageWeight > 0) {
        for (let h = 0; h < nH; h++) {
          const base = h * actionCount;
          const reach = averageWeight * heroReach[h];
          for (let action = 0; action < actionCount; action++) {
            sum[base + action] += reach * strategy[base + action];
          }
        }
      }
      return;
    }

    // villain 节点：结构对称，策略按对手自己的手牌索引。
    const actionCount = node.actions.length;
    ensureInfo(node, nV);
    const regret = node.regret!;
    const sum = node.sum!;
    const strategy = strategyMatrix(regret, nV, actionCount);
    const childHero: Float64Array[] = [];
    const childVillain: Float64Array[] = [];
    const scaled = new Float64Array(nV);
    for (let action = 0; action < actionCount; action++) {
      const ch = new Float64Array(nH);
      const cv = new Float64Array(nV);
      for (let v = 0; v < nV; v++) scaled[v] = villainReach[v] * strategy[v * actionCount + action];
      traverse(node.actions[action].next, heroReach, scaled, ch, cv, averageWeight);
      childHero.push(ch);
      childVillain.push(cv);
    }
    for (let v = 0; v < nV; v++) {
      const base = v * actionCount;
      let total = 0;
      for (let action = 0; action < actionCount; action++) {
        total += strategy[base + action] * childVillain[action][v];
      }
      outVillain[v] = total;
    }
    for (let h = 0; h < nH; h++) {
      let total = 0;
      for (let action = 0; action < actionCount; action++) total += childHero[action][h];
      outHero[h] = total;
    }
    for (let v = 0; v < nV; v++) {
      const base = v * actionCount;
      const nodeValue = outVillain[v];
      for (let action = 0; action < actionCount; action++) {
        const index = base + action;
        regret[index] = Math.max(0, regret[index] + childVillain[action][v] - nodeValue);
      }
    }
    if (averageWeight > 0) {
      for (let v = 0; v < nV; v++) {
        const base = v * actionCount;
        const reach = averageWeight * villainReach[v];
        for (let action = 0; action < actionCount; action++) {
          sum[base + action] += reach * strategy[base + action];
        }
      }
    }
  };

  const iterations = Math.max(1, Math.floor(options.iterations ?? 400));
  const budget = options.timeBudgetMs ?? 0;
  const outHero = new Float64Array(nH);
  const outVillain = new Float64Array(nV);
  let completed = 0;
  for (let iteration = 1; iteration <= iterations; iteration++) {
    // 丢弃前 50% 迭代再求平均（arXiv:1805.08195）。
    const averageWeight = iteration <= iterations * AVERAGE_SKIP ? 0 : iteration;
    traverse(tree, heroRootReach, villainRootReach, outHero, outVillain, averageWeight);
    // 前 30 轮按 √T/(√T+1) 折减遗憾。
    if (iteration <= REGRET_DISCOUNT_ITERS) {
      const factor = Math.sqrt(iteration) / (Math.sqrt(iteration) + 1);
      const discount = (node: HeroNode | VillainNode): void => {
        if (node.regret) for (let index = 0; index < node.regret.length; index++) node.regret[index] *= factor;
        for (const action of node.actions) {
          const next = action.next;
          if (next.kind === 'hero' || next.kind === 'villain') discount(next);
        }
      };
      discount(tree);
    }
    completed = iteration;
    if (budget > 0 && iteration >= 50 && Date.now() - startedAt > budget) break;
  }

  // 根节点平均策略里取真实底牌那一行。
  const rootInfo = tree.regret && tree.sum ? tree : null;
  const actionCount = tree.actions.length;
  let strategy: number[];
  if (rootInfo) {
    const base = actualHeroIndex * actionCount;
    const row: number[] = [];
    for (let action = 0; action < actionCount; action++) row.push(rootInfo.sum![base + action]);
    const total = row.reduce((acc, value) => acc + value, 0);
    strategy = total > 1e-12 ? row.map((value) => value / total) : row.map(() => 1 / actionCount);
  } else {
    strategy = tree.actions.map(() => 1 / actionCount);
  }

  const rngPick = derivedRng('subgame-pick', view.seed, view.actions.length, view.street);
  let bestIndex = 0;
  for (let index = 1; index < strategy.length; index++) {
    if (strategy[index] > strategy[bestIndex]) bestIndex = index;
  }
  let roll = rngPick();
  let picked = bestIndex;
  for (let index = 0; index < strategy.length; index++) {
    roll -= strategy[index];
    if (roll <= 0) {
      picked = index;
      break;
    }
  }
  const chosen = tree.actions[picked] ?? tree.actions[bestIndex];
  if (!chosen) return null;
  return {
    action: chosen.action,
    actionName: chosen.name,
    frequency: strategy[picked] ?? 0,
    strategy,
    actions: tree.actions.map((action) => action.name),
    iterations: completed,
    villainCombos: nV,
    rangeSize: villainRange.size,
    elapsedMs: Date.now() - startedAt,
  };
}
