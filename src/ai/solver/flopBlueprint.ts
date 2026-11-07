/**
 * 离线翻牌蓝图（A 路线）。
 *
 * 目标：给翻牌一条**可查表的均衡策略**，替掉现在「胜率过阈值就下注」的启发式。
 *
 * 做法（Libratus blueprint 的缩小版）：
 *   1. 把 1755 种本质不同的翻牌按纹理分桶（成对 / 同花度 / 高牌段 / 连接度）；
 *   2. 给定翻牌，把每手牌按「成牌强度 + 听牌」分成 10 桶；
 *   3. 在「BB 先行动」的单加注底池树上跑 CFR+（遗憾匹配+、线性平均）；
 *   4. 导出策略表，运行时按（纹理桶, 手牌桶, 节点）查表。
 *
 * 规模：纹理桶约 40 × 10 × 10 手牌对 × 约 40 个节点，单机几分钟可解完，产物几百 KB。
 *
 * 诚实限制（写在最前面，避免又被包装成「不可战胜」）：
 *   - 树的叶子是**转牌**，这里用「权益 × 底池 × 权益实现率」估终局价值，
 *     等价于假设后面两条街按固定实现率打完。这正是 v0.16 翻前蓝图踩过的坑：
 *     蓝图假设的翻后打法和实际引擎不一致时，蓝图会**更差**。
 *   - 所以这个蓝图默认**不启用**，必须先跑配对消融证明它不是负贡献。
 *   - 树上只有 3 个下注尺度、没有转牌加注树、没有多人底池。
 */
import type { Card } from '../../game/types';
import { analyzePostflop } from '../rangeModel';
import { accumulateStrategy, averageStrategy, regretMatchingPlus } from './cfr';
import flopBlueprintRaw from '../data/flop-blueprint.json';

export const FLOP_HAND_BUCKETS = 16;

/* ------------------------------------------------------------------ */
/* 1) 翻牌纹理抽象                                                     */
/* ------------------------------------------------------------------ */

const RANK_TEXT = ['', '', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

/**
 * 翻牌纹理键：成对 / 同花度 / 高牌段 / 连接度。
 *
 * 四类特征覆盖了翻牌策略差异的主要来源（Libratus 用聚类，这里用规则分桶，
 * 好处是**可解释、可复现**，坏处是粒度粗）。
 */
export function flopTextureKey(board: readonly Card[]): string {
  const ranks = board.slice(0, 3).map((card) => card.rank).sort((a, b) => b - a);
  const suits = board.slice(0, 3).map((card) => card.suit);

  const paired = ranks[0] === ranks[1] || ranks[1] === ranks[2] || ranks[0] === ranks[2];
  const suitCount = new Map<string, number>();
  for (const suit of suits) suitCount.set(suit, (suitCount.get(suit) ?? 0) + 1);
  const maxSuit = Math.max(...suitCount.values());
  const suitedness = maxSuit === 3 ? 'mono' : maxSuit === 2 ? 'two' : 'rainbow';

  // 高牌段：A / K / Q / J-T / 9-8 / 低
  const high = ranks[0];
  const highBand =
    high >= 14 ? 'A' : high === 13 ? 'K' : high === 12 ? 'Q' : high >= 11 ? 'JT' : high >= 9 ? '98' : 'low';

  // 连接度：最大相邻间隔
  const gap = Math.min(
    ranks[0] - ranks[1],
    ranks[1] - ranks[2],
    ranks[0] - ranks[2],
  );
  const connBand = gap <= 1 ? 'conn' : gap <= 2 ? 'semi' : gap <= 4 ? 'loose' : 'dry';

  return `${paired ? 'P' : 'U'}|${suitedness}|${highBand}|${connBand}`;
}

/** 预计算：169 个手牌类 × 每个纹理桶的代表翻牌，用于离线求解时的权益矩阵。 */
export interface FlopBucketTable {
  /** 纹理键 → 桶下标。 */
  keyToBucket: Map<string, number>;
  /** 桶下标 → 代表翻牌（该桶里第一个遇到的翻牌）。 */
  bucketBoards: Card[][];
  /** 桶下标 → 该桶覆盖的翻牌数（用于加权）。 */
  bucketWeights: number[];
}

/* ------------------------------------------------------------------ */
/* 2) 手牌抽象（给定翻牌）                                             */
/* ------------------------------------------------------------------ */

/**
 * 给定翻牌，把一手牌分到 0..9 桶（9 最强）。
 *
 * 用的是 `analyzePostflop` 的成牌强度，再加听牌加成——
 * 比「只按成牌强度」好，但仍然不是「对对手范围的权益」分桶，这是已知的粗化。
 */
export function flopHandBucket(hole: readonly Card[], board: readonly Card[]): number {
  const analysis = analyzePostflop(hole, board);
  let score = analysis.madeStrength;
  if (analysis.draw.hasDraw) score += 0.18;
  if (analysis.draw.flushDraw) score += 0.1;
  const bucket = Math.floor(Math.max(0, Math.min(0.999, score)) * FLOP_HAND_BUCKETS);
  return bucket;
}

/* ------------------------------------------------------------------ */
/* 3) 翻牌树（HU 单加注底池，BB 先行动）                               */
/* ------------------------------------------------------------------ */

export type FlopActionName =
  | 'check'
  | 'bet_33'
  | 'bet_66'
  | 'bet_100'
  | 'call'
  | 'raise'
  | 'fold';

export interface FlopNode {
  id: string;
  player: 'bb' | 'sb';
  actions: Array<{ name: FlopActionName; next: FlopNode | FlopTerminal }>;
}

export interface FlopTerminal {
  kind: 'showdown' | 'fold';
  /** 摊牌时的底池（含本街投入）。 */
  pot: number;
  /** BB 本街投入。 */
  investBb: number;
  /** SB 本街投入。 */
  investSb: number;
  /** fold 时谁弃牌。 */
  folder?: 'bb' | 'sb';
}

const BETS = [0.33, 0.66, 1] as const;

function betName(fraction: number): FlopActionName {
  return fraction === 0.33 ? 'bet_33' : fraction === 0.66 ? 'bet_66' : 'bet_100';
}

/**
 * 建树：底池 P0，双方剩余 S。
 *
 * BB 先行动（单挑翻牌后大盲先说话）。加注统一用 2.5 倍下注额。
 */
export function buildFlopTree(P0: number, S: number): FlopNode {
  const terminalShowdown = (iBb: number, iSb: number): FlopTerminal => ({
    kind: 'showdown',
    pot: P0 + iBb + iSb,
    investBb: iBb,
    investSb: iSb,
  });
  const terminalFold = (folder: 'bb' | 'sb', iBb: number, iSb: number): FlopTerminal => ({
    kind: 'fold',
    pot: P0 + iBb + iSb,
    investBb: iBb,
    investSb: iSb,
    folder,
  });

  /** SB 面对 BB 的下注 b：弃 / 跟 / 加注。 */
  const sbVsBet = (bet: number, id: string): FlopNode => {
    const raiseTo = Math.min(S, Math.round(bet * 2.5));
    const actions: FlopNode['actions'] = [
      { name: 'fold', next: terminalFold('sb', bet, 0) },
      { name: 'call', next: terminalShowdown(bet, bet) },
    ];
    if (raiseTo > bet) {
      actions.push({
        name: 'raise',
        next: {
          kind: 'bb',
          id: `${id}_bb_vs_raise`,
          player: 'bb',
          actions: [
            { name: 'fold', next: terminalFold('bb', bet, raiseTo) },
            { name: 'call', next: terminalShowdown(raiseTo, raiseTo) },
          ],
        } as FlopNode,
      });
    }
    return { id, player: 'sb', actions };
  };

  /** BB 面对 SB 的下注 b。 */
  const bbVsBet = (bet: number, id: string): FlopNode => {
    const raiseTo = Math.min(S, Math.round(bet * 2.5));
    const actions: FlopNode['actions'] = [
      { name: 'fold', next: terminalFold('bb', 0, bet) },
      { name: 'call', next: terminalShowdown(bet, bet) },
    ];
    if (raiseTo > bet) {
      actions.push({
        name: 'raise',
        next: {
          kind: 'sb',
          id: `${id}_sb_vs_raise`,
          player: 'sb',
          actions: [
            { name: 'fold', next: terminalFold('sb', raiseTo, bet) },
            { name: 'call', next: terminalShowdown(raiseTo, raiseTo) },
          ],
        } as FlopNode,
      });
    }
    return { id, player: 'bb', actions };
  };

  // SB 在 BB 过牌后行动
  const sbAfterCheck: FlopNode = {
    id: 'sb_after_check',
    player: 'sb',
    actions: [
      { name: 'check', next: terminalShowdown(0, 0) },
      ...BETS.map((fraction) => {
        const amount = Math.max(1, Math.round(P0 * fraction));
        return { name: betName(fraction), next: bbVsBet(amount, `bb_vs_${betName(fraction)}`) };
      }),
    ],
  };

  // BB 根节点：过牌或下注
  return {
    id: 'bb_root',
    player: 'bb',
    actions: [
      { name: 'check', next: sbAfterCheck },
      ...BETS.map((fraction) => {
        const amount = Math.max(1, Math.round(P0 * fraction));
        return { name: betName(fraction), next: sbVsBet(amount, `sb_vs_${betName(fraction)}`) };
      }),
    ],
  };
}

/* ------------------------------------------------------------------ */
/* 4) CFR+ 求解                                                        */
/* ------------------------------------------------------------------ */

interface InfoSet {
  regret: number[];
  sum: number[];
  actions: FlopActionName[];
}

/** 权益实现率：BB 无位置、SB 有位置（单挑翻牌后 SB 是按钮，最后行动）。 */
const REALIZATION_BB = 0.92;
const REALIZATION_SB = 1.08;

/**
 * 终局价值（**SB 视角**，相对本街开始）。
 *
 * 摊牌用「份额归一化」保证双方份额加起来正好是整个底池：
 *   sbWeight = eq × 实现率_SB，bbWeight = (1−eq) × 实现率_BB，share = sbWeight / (sbWeight+bbWeight)
 */
export function flopTerminalEv(terminal: FlopTerminal, sbEquity: number): number {
  if (terminal.kind === 'fold') {
    if (terminal.folder === 'sb') return -terminal.investSb;
    return terminal.pot - terminal.investSb;
  }
  const sbWeight = Math.max(1e-9, sbEquity * REALIZATION_SB);
  const bbWeight = Math.max(1e-9, (1 - sbEquity) * REALIZATION_BB);
  const share = sbWeight / (sbWeight + bbWeight);
  return share * terminal.pot - terminal.investSb;
}

export interface FlopBlueprint {
  /** 纹理键 → 桶下标 */
  textureKeys: string[];
  /** 桶下标 → 该桶的代表翻牌（用于运行时算手牌桶） */
  bucketBoards: Card[][];
  /** 节点 id → 动作名 */
  nodes: Record<string, FlopActionName[]>;
  /** 条目：node + 纹理桶 + 手牌桶 → 平均策略 */
  entries: Array<{ node: string; flop: number; hand: number; strategy: number[] }>;
  /** 抽象游戏内的可利用度（BB/手） */
  exploitability: number;
  iterations: number;
}

export interface FlopSolveInput {
  /** 纹理桶的代表翻牌列表 */
  bucketBoards: Card[][];
  /** 每个桶的权益矩阵：[flop][sbBucket][bbBucket] = SB 权益 */
  equity: number[][][];
  iterations?: number;
  potBB?: number;
  stackBB?: number;
  /**
   * 叶子估值（SB 视角，单位筹码）。给了就用它替代「权益 × 底池 × 固定实现率」。
   * B 路线（价值网络）就是从这里接进来的。
   */
  leafEv?: (input: {
    flop: number;
    sbHand: number;
    bbHand: number;
    terminal: FlopTerminal;
  }) => number;
}

export function solveFlopBlueprint(input: FlopSolveInput): FlopBlueprint {
  const iterations = Math.max(50, Math.floor(input.iterations ?? 400));
  const potBB = input.potBB ?? 6.5; // SB 加注 3BB + BB 跟注 + 0.5 盲注
  const stackBB = input.stackBB ?? 97;
  const tree = buildFlopTree(potBB, stackBB);
  const infos = new Map<string, InfoSet>();
  const nodeSpec: Record<string, FlopActionName[]> = {};

  const getInfo = (node: FlopNode, flop: number, hand: number): InfoSet => {
    const key = `${node.id}|${node.player}|${flop}|${hand}`;
    let info = infos.get(key);
    if (!info) {
      info = {
        regret: new Array(node.actions.length).fill(0),
        sum: new Array(node.actions.length).fill(0),
        actions: node.actions.map((action) => action.name),
      };
      infos.set(key, info);
      nodeSpec[node.id] = info.actions;
    }
    return info;
  };

  /** 返回 SB 视角的 EV；BB 节点的遗憾取负号（双方价值之和为常数底池，不影响策略）。 */
  const traverse = (
    node: FlopNode | FlopTerminal,
    flop: number,
    sbHand: number,
    bbHand: number,
    reachSb: number,
    reachBb: number,
    iteration: number,
  ): number => {
    if (!('player' in node)) {
      if (input.leafEv) {
        return input.leafEv({ flop, sbHand, bbHand, terminal: node });
      }
      return flopTerminalEv(node, input.equity[flop][sbHand][bbHand]);
    }
    const hand = node.player === 'sb' ? sbHand : bbHand;
    const info = getInfo(node, flop, hand);
    const strategy = regretMatchingPlus(info.regret);
    const values: number[] = [];
    for (let index = 0; index < node.actions.length; index++) {
      const probability = strategy[index];
      values.push(
        traverse(
          node.actions[index].next,
          flop,
          sbHand,
          bbHand,
          node.player === 'sb' ? reachSb * probability : reachSb,
          node.player === 'bb' ? reachBb * probability : reachBb,
          iteration,
        ),
      );
    }
    let nodeValue = 0;
    for (let index = 0; index < values.length; index++) nodeValue += strategy[index] * values[index];
    const sign = node.player === 'sb' ? 1 : -1;
    const ownReach = node.player === 'sb' ? reachSb : reachBb;
    for (let index = 0; index < values.length; index++) {
      info.regret[index] = Math.max(0, info.regret[index] + sign * ownReach * (values[index] - nodeValue));
    }
    accumulateStrategy(info.sum, strategy, ownReach * iteration);
    return nodeValue;
  };

  const flopCount = input.bucketBoards.length;
  for (let iteration = 1; iteration <= iterations; iteration++) {
    for (let flop = 0; flop < flopCount; flop++) {
      for (let sbHand = 0; sbHand < FLOP_HAND_BUCKETS; sbHand++) {
        for (let bbHand = 0; bbHand < FLOP_HAND_BUCKETS; bbHand++) {
          traverse(tree, flop, sbHand, bbHand, 1, 1, iteration);
        }
      }
    }
  }

  const entries: FlopBlueprint['entries'] = [];
  for (const [key, info] of infos) {
    const [node, , flopText, handText] = key.split('|');
    entries.push({
      node,
      flop: Number(flopText),
      hand: Number(handText),
      strategy: averageStrategy(info.sum),
    });
  }

  return {
    textureKeys: [],
    bucketBoards: input.bucketBoards,
    nodes: nodeSpec,
    entries,
    // 可利用度需要另一套最佳回应计算，这里先给 0 并在生成脚本里单独报告
    exploitability: 0,
    iterations,
  };
}

/* ------------------------------------------------------------------ */
/* 5) 运行时查表                                                       */
/* ------------------------------------------------------------------ */

interface BlueprintFile {
  /** 生成时的手牌桶数；与运行时不一致说明数据过期，必须拒绝使用。 */
  handBuckets?: number;
  /** 策略值的量化倍数（100 = 存的是 0~100 的整数）；缺省 1 表示原始浮点。 */
  strategyScale?: number;
  textureKeys: string[];
  bucketBoards: string[][];
  nodes: Record<string, FlopActionName[]>;
  entries: Array<{ node: string; flop: number; hand: number; strategy: number[] }>;
}

let loaded: {
  keyToBucket: Map<string, number>;
  /** 退化匹配：去掉「连接度」后的键 → 桶 */
  coarseToBucket: Map<string, number>;
  /** 再退化：只保留「成对 + 同花度」 */
  roughestToBucket: Map<string, number>;
  nodes: Record<string, FlopActionName[]>;
  strategy: Map<string, number[]>;
} | null = null;

function loadBlueprint(): typeof loaded {
  if (loaded !== null) return loaded;
  try {
    // 静态导入：打包时内联，浏览器端没有 require
    const raw = flopBlueprintRaw as unknown as BlueprintFile;
    // 手牌桶数变了而数据没重生成 → 桶下标含义完全不同，必须拒绝使用，
    // 否则会拿「第 3 桶」的策略去套「另一个第 3 桶」的手牌，比不用还糟。
    if (raw.handBuckets !== FLOP_HAND_BUCKETS) {
      loaded = null;
      return null;
    }
    const keyToBucket = new Map<string, number>();
    const coarseToBucket = new Map<string, number>();
    const roughestToBucket = new Map<string, number>();
    raw.textureKeys.forEach((key, index) => {
      keyToBucket.set(key, index);
      const parts = key.split('|');
      const coarse = `${parts[0]}|${parts[1]}|${parts[2]}`;
      const roughest = `${parts[0]}|${parts[1]}`;
      if (!coarseToBucket.has(coarse)) coarseToBucket.set(coarse, index);
      if (!roughestToBucket.has(roughest)) roughestToBucket.set(roughest, index);
    });
    const scale = raw.strategyScale ?? 1;
    const strategy = new Map<string, number[]>();
    for (const entry of raw.entries) {
      strategy.set(
        `${entry.node}|${entry.flop}|${entry.hand}`,
        scale === 1 ? entry.strategy : entry.strategy.map((value) => value / scale),
      );
    }
    loaded = { keyToBucket, coarseToBucket, roughestToBucket, nodes: raw.nodes, strategy };
    return loaded;
  } catch {
    loaded = null;
    return null;
  }
}

/** 把本街已发生的动作序列映射回树上的节点 id。 */
export function flopNodeFromActions(
  actions: readonly { action: { type: string; amount?: number } }[],
): { node: string; actor: 'bb' | 'sb' } | null {
  // 树的形状固定：BB 先动
  let node = 'bb_root';
  let actor: 'bb' | 'sb' = 'bb';
  for (const record of actions) {
    const type = record.action.type;
    if (node === 'bb_root') {
      if (type === 'check') { node = 'sb_after_check'; actor = 'sb'; continue; }
      if (type === 'bet' || type === 'allin') { node = 'sb_vs_bet'; actor = 'sb'; continue; }
      return null;
    }
    if (node === 'sb_after_check') {
      if (type === 'check') return null; // 本街结束
      if (type === 'bet' || type === 'allin') { node = 'bb_vs_bet'; actor = 'bb'; continue; }
      return null;
    }
    if (node === 'sb_vs_bet' || node === 'bb_vs_bet') {
      if (type === 'fold' || type === 'call') return null; // 本街结束
      if (type === 'raise' || type === 'allin') {
        node = node === 'sb_vs_bet' ? 'bb_vs_raise' : 'sb_vs_raise';
        actor = node === 'bb_vs_raise' ? 'bb' : 'sb';
        continue;
      }
      return null;
    }
    return null; // 加注后再有动作 → 本街结束
  }
  return { node, actor };
}

export interface FlopAdvice {
  node: string;
  actor: 'bb' | 'sb';
  flopBucket: number;
  handBucket: number;
  actions: FlopActionName[];
  strategy: number[];
}

/**
 * 蓝图只对一个特定底池求解：**SB 开池 2.5~3.5BB、BB 跟注、无第三人**的单加注底池。
 *
 * 旧实现完全没校验这一点：只要翻牌纹理命中就套用，于是跛入池、3-bet 池、
 * 甚至翻前打光的边池都会被喂进「单加注底池的均衡策略」。这是 v0.23 里
 * 翻牌蓝图 −19 BB/100 的首要嫌疑——不是策略错，是**用错了地方**。
 *
 * 返回 false 时调用方必须回退启发式。
 */
export function flopSpotMatches(
  preflopActions: readonly { action: { type: string; amount?: number } }[],
  bigBlind: number,
): boolean {
  if (preflopActions.length !== 2) return false;
  const [first, second] = preflopActions;
  const isRaise = first.action.type === 'raise';
  if (!isRaise) return false; // 跛入 / 全下开池都不在蓝图覆盖内
  if (second.action.type !== 'call') return false; // BB 必须跟注（弃牌则没翻牌）
  const openTo = (first.action.amount ?? 0) / Math.max(1, bigBlind);
  return openTo >= 2.2 && openTo <= 4;
}

/**
 * 查表：给定翻牌、我方底牌、本街动作序列，返回均衡混合策略。
 *
 * 返回 null 表示「这个局面不在蓝图覆盖范围内」（纹理桶没命中 / 多人底池 / 非单加注底池），
 * 调用方应回退到启发式——**不要**用一个不相关的策略硬套。
 */
export function flopAdvice(
  board: readonly Card[],
  hole: readonly Card[],
  streetActions: readonly { action: { type: string; amount?: number } }[],
): FlopAdvice | null {
  if (board.length !== 3) return null;
  const data = loadBlueprint();
  if (!data) return null;
  const key = flopTextureKey(board);
  const parts = key.split('|');
  // 三级匹配：精确 → 去掉连接度 → 只保留成对/同花度。
  // 桶数有限（48 个），低频纹理（如 K 高牌干燥面）不会单独成桶；
  // 用近似桶比直接放弃更合理，但要在 debug 里标出来。
  const flopBucket =
    data.keyToBucket.get(key) ??
    data.coarseToBucket.get(`${parts[0]}|${parts[1]}|${parts[2]}`) ??
    data.roughestToBucket.get(`${parts[0]}|${parts[1]}`);
  if (flopBucket === undefined) return null;
  const position = flopNodeFromActions(streetActions);
  if (!position) return null;
  const handBucket = flopHandBucket(hole, board);
  const strategy = data.strategy.get(`${position.node}|${flopBucket}|${handBucket}`);
  if (!strategy) return null;
  const actions = data.nodes[position.node];
  if (!actions || actions.length !== strategy.length) return null;
  return { node: position.node, actor: position.actor, flopBucket, handBucket, actions, strategy };
}
