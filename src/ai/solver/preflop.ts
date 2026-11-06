/**
 * 单挑翻前 CFR+ 蓝图（Libratus 的 blueprint 思路，缩小到可离线求解的规模）。
 *
 * 游戏：HU，有效筹码 100BB（可扩展到 4–100BB），盲注 0.5/1BB。
 * 抽象：169 类起手牌按真实胜率分成 10 个桶；每个桶是一个信息集。
 * 动作：SB fold / limp / raise 2.5BB / raise 3.5BB / all-in；
 *       BB check / raise / 3-bet / all-in；SB 面对 3-bet fold/call/all-in。
 * 叶节点：fold（固定收益）或 call（桶间胜率 × 底池 + 未来街 continuation）。
 *
 * 这不是完整 NLHE 解，但它是一个真正的 CFR+ 均衡近似：
 * - 桶按真实胜率而不是 Chen 分数；
 * - 桶间胜率用桶内随机组合采样，不用单张代表牌；
 * - 有明确的动作树、遗憾匹配+、线性平均与最佳回应可利用度报告。
 */
import type { Card, PlayerAction } from '../../game/types';
import type { PlayerView } from '../../game/playerView';
import { createDeck, derivedRng, shuffle } from '../../game/cards';
import {
  PREFLOP_BUCKETS,
  bucketOfCards,
  cardKey,
  preflopBucketTable,
  showdownSign,
} from './abstraction';
import {
  accumulateStrategy,
  averageStrategy,
  regretMatchingPlus,
} from './cfr';

export type PreflopActionName = 'fold' | 'check' | 'call' | 'raise_small' | 'raise_big' | 'allin';

export interface PreflopNode {
  id: string;
  player: 'sb' | 'bb';
  actions: Array<{ name: PreflopActionName; next: PreflopNode | PreflopTerminal }>;
}

export type PreflopTerminal =
  | { kind: 'fold'; payoffSb: number }
  | {
      kind: 'showdown';
      pot: number;
      investSb: number;
      /** 叶节点后剩余有效筹码（BB）；all-in 为 0。 */
      remaining: number;
      allin: boolean;
    };

export interface PreflopBlueprintEntry {
  bucket: number;
  node: string;
  /** 与 node.actions 对齐的平均策略。 */
  strategy: number[];
}

export interface PreflopBlueprint {
  generatedAt: string;
  description: string;
  stackBB: number;
  buckets: number;
  iterations: number;
  /** 抽象游戏内的最佳回应可利用度（BB/手）。 */
  exploitability: number;
  nodes: Record<string, { player: 'sb' | 'bb'; actions: PreflopActionName[] }>;
  entries: PreflopBlueprintEntry[];
}

const STACK_BB = 100;
const SMALL_RAISE = 2.5;
const BIG_RAISE = 3.5;
const THREE_BET_MULT = 3;
const LIMP_RAISE = 3;

function terminalFold(payoffSb: number): PreflopTerminal {
  return { kind: 'fold', payoffSb };
}

function terminalShowdown(pot: number, investSb: number, remaining: number, allin = false): PreflopTerminal {
  return { kind: 'showdown', pot, investSb, remaining, allin };
}

/**
 * 构造翻前抽象树。收益统一以 BB 为单位，从 SB 视角计算。
 * 所有 raise 都是「加到」的总额；call 的投入由路径决定。
 */
export function buildPreflopTree(stackBB = STACK_BB): PreflopNode {
  const S = Math.max(2, stackBB);
  const raiseSmall = Math.min(S, SMALL_RAISE);
  const raiseBig = Math.min(S, BIG_RAISE);

  const sbVs3Bet = (open: number): PreflopNode => {
    const threeBet = Math.min(S, open * THREE_BET_MULT);
    const potIfCall = threeBet * 2;
    return {
      id: `sb_vs_3bet_${open}`,
      player: 'sb',
      actions: [
        { name: 'fold', next: terminalFold(-open) },
        { name: 'call', next: terminalShowdown(potIfCall, threeBet, Math.max(0, S - threeBet)) },
        {
          name: 'allin',
          next: {
            id: `bb_vs_4bet_${open}`,
            player: 'bb',
            actions: [
              { name: 'fold', next: terminalFold(threeBet) },
              { name: 'call', next: terminalShowdown(2 * S, S, 0, true) },
            ],
          },
        },
      ],
    };
  };

  const bbVsOpen = (open: number): PreflopNode => {
    const threeBet = Math.min(S, open * THREE_BET_MULT);
    return {
      id: `bb_vs_open_${open}`,
      player: 'bb',
      actions: [
        { name: 'fold', next: terminalFold(1) },
        { name: 'call', next: terminalShowdown(open * 2, open, Math.max(0, S - open)) },
        { name: 'raise_big', next: sbVs3Bet(open) },
        {
          name: 'allin',
          next: {
            id: `sb_vs_allin_${open}`,
            player: 'sb',
            actions: [
              { name: 'fold', next: terminalFold(-open) },
              { name: 'call', next: terminalShowdown(2 * S, S, 0, true) },
            ],
          },
        },
      ],
    };
  };

  const bbVsLimp: PreflopNode = {
    id: 'bb_vs_limp',
    player: 'bb',
    actions: [
      { name: 'check', next: terminalShowdown(2, 1, Math.max(0, S - 1)) },
      {
        name: 'raise_small',
        next: {
          id: 'sb_vs_limp_raise',
          player: 'sb',
          actions: [
            { name: 'fold', next: terminalFold(-0.5) },
            { name: 'call', next: terminalShowdown(LIMP_RAISE * 2, LIMP_RAISE, Math.max(0, S - LIMP_RAISE)) },
            {
              name: 'allin',
              next: {
                id: 'bb_vs_limp_4bet',
                player: 'bb',
                actions: [
                  { name: 'fold', next: terminalFold(LIMP_RAISE) },
                  { name: 'call', next: terminalShowdown(2 * S, S, 0, true) },
                ],
              },
            },
          ],
        },
      },
      {
        name: 'allin',
        next: {
          id: 'sb_vs_limp_allin',
          player: 'sb',
          actions: [
            { name: 'fold', next: terminalFold(-0.5) },
            { name: 'call', next: terminalShowdown(2 * S, S, 0, true) },
          ],
        },
      },
    ],
  };

  return {
    id: 'sb_root',
    player: 'sb',
    actions: [
      { name: 'fold', next: terminalFold(-0.5) },
      { name: 'call', next: bbVsLimp },
      { name: 'raise_small', next: bbVsOpen(raiseSmall) },
      { name: 'raise_big', next: bbVsOpen(raiseBig) },
    ],
  };
}

interface InfoSet {
  regret: number[];
  sum: number[];
  actions: PreflopActionName[];
}

function buildInfoKey(player: 'sb' | 'bb', node: string, bucket: number): string {
  return `${player}|${node}|${bucket}`;
}

const RANK_MAP: Record<string, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  '10': 10, T: 10, J: 11, Q: 12, K: 13, A: 14,
};

function comboOfClass(key: string): [Card, Card] {
  const match = /^(10|[2-9TJQKA])(10|[2-9TJQKA])([so]?)$/.exec(key);
  if (!match) throw new Error('bad class ' + key);
  const high = RANK_MAP[match[1]] as Card['rank'];
  const low = RANK_MAP[match[2]] as Card['rank'];
  const suffix = match[3];
  if (high === low) return [{ rank: high, suit: 's' }, { rank: low, suit: 'h' }];
  if (suffix === 's') return [{ rank: high, suit: 's' }, { rank: low, suit: 's' }];
  return [{ rank: high, suit: 's' }, { rank: low, suit: 'h' }];
}

/** 桶间胜率矩阵：每个桶随机采样组合，避免“单张代表牌”偏差。 */
export function buildBucketEquityMatrix(samplesPerPair = 240): number[][] {
  const table = preflopBucketTable();
  const matrix = Array.from({ length: PREFLOP_BUCKETS }, () =>
    new Array<number>(PREFLOP_BUCKETS).fill(0.5),
  );
  const rng = derivedRng('preflop-bucket-equity-v2');
  for (let i = 0; i < PREFLOP_BUCKETS; i++) {
    for (let j = i; j < PREFLOP_BUCKETS; j++) {
      let score = 0;
      let total = 0;
      for (let sample = 0; sample < samplesPerPair; sample++) {
        const listI = table.classesOfBucket[i];
        const listJ = table.classesOfBucket[j];
        const hero = comboOfClass(listI[Math.floor(rng() * listI.length)] ?? '72o');
        const villain = comboOfClass(listJ[Math.floor(rng() * listJ.length)] ?? '72o');
        const used = new Set([...hero, ...villain].map(cardKey));
        const deck = createDeck().filter((card) => !used.has(cardKey(card)));
        const board = shuffle(deck, rng).slice(0, 5);
        const sign = showdownSign(hero, villain, board);
        score += sign > 0 ? 1 : sign === 0 ? 0.5 : 0;
        total += 1;
      }
      const equity = total > 0 ? score / total : 0.5;
      matrix[i][j] = equity;
      matrix[j][i] = 1 - equity;
    }
  }
  return matrix;
}

function terminalEv(terminal: PreflopTerminal, equity: number): number {
  if (terminal.kind === 'fold') return terminal.payoffSb;
  const showdown = equity * terminal.pot - terminal.investSb;
  if (terminal.allin || terminal.remaining <= 0) return showdown;
  const edge = equity - 0.5;
  const future = edge * terminal.pot * 0.15 * Math.min(1, terminal.remaining / Math.max(1, terminal.pot));
  return showdown + future;
}

/**
 * 用 CFR+ 求解翻前抽象游戏。
 * 每个桶一个信息集；对 10×10 个桶对做全枚举 CFR（chance 节点均匀）。
 */
export function solvePreflopBlueprint(options: { iterations?: number; stackBB?: number } = {}): PreflopBlueprint {
  const iterations = Math.max(100, Math.floor(options.iterations ?? 6000));
  const stackBB = options.stackBB ?? STACK_BB;
  const tree = buildPreflopTree(stackBB);
  const equityMatrix = buildBucketEquityMatrix();
  const infos = new Map<string, InfoSet>();
  const nodeSpec: Record<string, { player: 'sb' | 'bb'; actions: PreflopActionName[] }> = {};

  const getInfo = (player: 'sb' | 'bb', node: PreflopNode, bucket: number): InfoSet => {
    const key = buildInfoKey(player, node.id, bucket);
    let info = infos.get(key);
    if (!info) {
      info = {
        regret: new Array(node.actions.length).fill(0),
        sum: new Array(node.actions.length).fill(0),
        actions: node.actions.map((a) => a.name),
      };
      infos.set(key, info);
      nodeSpec[node.id] = { player, actions: info.actions };
    }
    return info;
  };

  /**
   * 返回「SB 视角」的 EV。BB 节点的遗憾更新取负号：
   * BB 的动作价值 = -SB 的动作价值，节点价值 = -SB 的节点价值。
   */
  const traverse = (
    node: PreflopNode | PreflopTerminal,
    sbBucket: number,
    bbBucket: number,
    reachSb: number,
    reachBb: number,
    iteration: number,
  ): number => {
    if (!('player' in node)) {
      return terminalEv(node, equityMatrix[sbBucket][bbBucket]);
    }
    const bucket = node.player === 'sb' ? sbBucket : bbBucket;
    const info = getInfo(node.player, node, bucket);
    const strategy = regretMatchingPlus(info.regret);
    const values: number[] = [];
    for (let index = 0; index < node.actions.length; index++) {
      const probability = strategy[index];
      values.push(
        traverse(
          node.actions[index].next,
          sbBucket,
          bbBucket,
          node.player === 'sb' ? reachSb * probability : reachSb,
          node.player === 'bb' ? reachBb * probability : reachBb,
          iteration,
        ),
      );
    }
    let nodeValue = 0;
    for (let index = 0; index < values.length; index++) nodeValue += strategy[index] * values[index];
    const sign = node.player === 'sb' ? 1 : -1;
    const oppReach = node.player === 'sb' ? reachBb : reachSb;
    const ownReach = node.player === 'sb' ? reachSb : reachBb;
    for (let index = 0; index < values.length; index++) {
      info.regret[index] = Math.max(
        0,
        info.regret[index] + sign * oppReach * (values[index] - nodeValue),
      );
    }
    accumulateStrategy(info.sum, strategy, ownReach * iteration);
    return nodeValue;
  };

  const chance = 1 / (PREFLOP_BUCKETS * PREFLOP_BUCKETS);
  let totalValue = 0;
  for (let iteration = 1; iteration <= iterations; iteration++) {
    let value = 0;
    for (let sb = 0; sb < PREFLOP_BUCKETS; sb++) {
      for (let bb = 0; bb < PREFLOP_BUCKETS; bb++) {
        value += traverse(tree, sb, bb, 1, 1, iteration) * chance;
      }
    }
    totalValue = value;
  }

  const average = new Map<string, number[]>();
  for (const [key, info] of infos) average.set(key, averageStrategy(info.sum));

  /** 最佳回应：在 brPlayer 的节点取 max，在对手节点用平均策略。 */
  const bestResponse = (
    node: PreflopNode | PreflopTerminal,
    sbBucket: number,
    bbBucket: number,
    brPlayer: 'sb' | 'bb',
    mode: 'max' | 'min',
  ): number => {
    if (!('player' in node)) return terminalEv(node, equityMatrix[sbBucket][bbBucket]);
    const bucket = node.player === 'sb' ? sbBucket : bbBucket;
    if (node.player === brPlayer) {
      let best = mode === 'max' ? -Infinity : Infinity;
      for (const action of node.actions) {
        const value = bestResponse(action.next, sbBucket, bbBucket, brPlayer, mode);
        best = mode === 'max' ? Math.max(best, value) : Math.min(best, value);
      }
      return best;
    }
    const strategy = average.get(buildInfoKey(node.player, node.id, bucket)) ??
      regretMatchingPlus(new Array(node.actions.length).fill(0));
    let value = 0;
    for (let index = 0; index < node.actions.length; index++) {
      value += strategy[index] * bestResponse(node.actions[index].next, sbBucket, bbBucket, brPlayer, mode);
    }
    return value;
  };

  const bestResponseValue = (player: 'sb' | 'bb'): number => {
    let total = 0;
    for (let bucket = 0; bucket < PREFLOP_BUCKETS; bucket++) {
      let bucketTotal = 0;
      for (let other = 0; other < PREFLOP_BUCKETS; other++) {
        const sbBucket = player === 'sb' ? bucket : other;
        const bbBucket = player === 'bb' ? bucket : other;
        bucketTotal += bestResponse(tree, sbBucket, bbBucket, player, player === 'sb' ? 'max' : 'min');
      }
      total += bucketTotal / PREFLOP_BUCKETS;
    }
    return total / PREFLOP_BUCKETS;
  };
  const sbBest = bestResponseValue('sb');
  const bbMin = bestResponseValue('bb');
  const exploitability = Math.max(0, sbBest - totalValue) + Math.max(0, totalValue - bbMin);

  const entries: PreflopBlueprintEntry[] = [];
  for (const [key, info] of infos) {
    const [, node, bucketText] = key.split('|');
    entries.push({
      bucket: Number(bucketText),
      node,
      strategy: averageStrategy(info.sum),
    });
  }
  entries.sort((a, b) => a.node.localeCompare(b.node) || a.bucket - b.bucket);

  return {
    generatedAt: new Date().toISOString(),
    description: `单挑翻前 CFR+ 蓝图（${PREFLOP_BUCKETS} 个真实胜率桶，${iterations} 次迭代）`,
    stackBB,
    buckets: PREFLOP_BUCKETS,
    iterations,
    exploitability: Number(exploitability.toFixed(4)),
    nodes: nodeSpec,
    entries,
  };
}

/* ------------------------------------------------------------------ */
/* 运行时查表                                                          */
/* ------------------------------------------------------------------ */

export interface PreflopAdvice {
  action: PreflopActionName;
  /** 该动作在均衡策略中的频率。 */
  frequency: number;
  bucket: number;
  node: string;
  /** 完整策略，供调试 / 混合。 */
  strategy: number[];
  actions: PreflopActionName[];
}

let blueprintCache: PreflopBlueprint | null = null;

export function setPreflopBlueprint(blueprint: PreflopBlueprint | null): void {
  blueprintCache = blueprint;
}

export function getPreflopBlueprint(): PreflopBlueprint | null {
  return blueprintCache;
}

/** 把当前视图映射到翻前节点。 */
export function preflopNodeForView(view: PlayerView): { node: string; player: 'sb' | 'bb' } | null {
  if (view.street !== 'preflop') return null;
  const active = view.players.filter((p) => p.status === 'active' || p.status === 'allin');
  if (active.length !== 2) return null;
  const selfIndex = view.players.findIndex((p) => p.id === view.viewerId);
  const isSb = selfIndex === view.buttonIndex;
  const preflopActions = view.actions.filter((record) => record.street === 'preflop');
  const raises = preflopActions.filter(
    (record) => record.action.type === 'raise' || record.action.type === 'allin',
  );
  const hasLimp = preflopActions.some((record) => record.action.type === 'call');
  if (raises.length === 0) {
    return isSb ? { node: 'sb_root', player: 'sb' } : null;
  }
  const firstRaise = raises[0];
  const raiseTo = firstRaise.toAmount / Math.max(1, view.bigBlind);
  const open = raiseTo <= 3 ? 'raise_small' : 'raise_big';
  if (raises.length === 1) {
    if (hasLimp && !isSb) return { node: 'bb_vs_limp', player: 'bb' };
    return isSb ? null : { node: open === 'raise_small' ? 'bb_vs_open_2.5' : 'bb_vs_open_3.5', player: 'bb' };
  }
  if (raises.length === 2) {
    return isSb
      ? { node: open === 'raise_small' ? 'sb_vs_3bet_2.5' : 'sb_vs_3bet_3.5', player: 'sb' }
      : null;
  }
  return null;
}

/** 查询蓝图；没有蓝图或节点不匹配返回 null。 */
export function preflopAdvice(view: PlayerView): PreflopAdvice | null {
  const blueprint = blueprintCache;
  if (!blueprint) return null;
  const mapped = preflopNodeForView(view);
  if (!mapped) return null;
  const bucket = bucketOfCards(view.self.holeCards[0], view.self.holeCards[1]);
  const entry = blueprint.entries.find((item) => item.node === mapped.node && item.bucket === bucket);
  if (!entry) return null;
  const spec = blueprint.nodes[mapped.node];
  if (!spec) return null;
  let bestIndex = 0;
  for (let index = 1; index < entry.strategy.length; index++) {
    if (entry.strategy[index] > entry.strategy[bestIndex]) bestIndex = index;
  }
  return {
    action: spec.actions[bestIndex] ?? 'fold',
    frequency: entry.strategy[bestIndex] ?? 0,
    bucket,
    node: mapped.node,
    strategy: entry.strategy,
    actions: spec.actions,
  };
}

/** 把蓝图动作转成引擎动作；调用方负责合法性校验。 */
export function preflopActionOf(
  advice: PreflopAdvice,
  view: PlayerView,
): PlayerAction | null {
  const legal = view.legal;
  if (!legal) return null;
  switch (advice.action) {
    case 'fold':
      return legal.canFold ? { type: 'fold' } : legal.canCheck ? { type: 'check' } : null;
    case 'check':
      return legal.canCheck ? { type: 'check' } : null;
    case 'call':
      return legal.canCall ? { type: 'call' } : legal.canCheck ? { type: 'check' } : null;
    case 'allin':
      return legal.canAllIn ? { type: 'allin' } : legal.canCall ? { type: 'call' } : null;
    case 'raise_small':
    case 'raise_big': {
      if (!legal.aggressiveType) return legal.canCall ? { type: 'call' } : null;
      const target =
        advice.action === 'raise_small'
          ? Math.round(view.bigBlind * SMALL_RAISE)
          : Math.round(view.bigBlind * BIG_RAISE);
      const amount = Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, target));
      return { type: legal.aggressiveType, amount };
    }
    default:
      return null;
  }
}
