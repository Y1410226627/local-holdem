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
import type { RangeWeight } from '../equity';
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
  /**
   * 抽象游戏内的最佳回应可利用度（BB/手）。
   *
   * **以 `scripts/audit-preflop-blueprint.ts` 重算的结果为准。**
   * 这个字段是训练时写下的，代码一改它就过期（v0.25 那份产物写 0.0167，
   * 同策略用当时最新代码重算是 0.0470）。验收脚本会重算并与它比对，
   * 差得太多就直接报「产物与代码不一致，请重新生成」。
   */
  exploitability: number;
  /** 训练时的 3-bet 几何（老产物没有这个字段，视为 `'x3'`）。 */
  threeBet?: PreflopThreeBet;
  /** 训练时是否允许跛入（老产物没有这个字段）。 */
  allowLimp?: boolean;
  nodes: Record<string, { player: 'sb' | 'bb'; actions: PreflopActionName[] }>;
  entries: PreflopBlueprintEntry[];
}

/**
 * 默认有效筹码（BB）。
 *
 * 必须和实战桌况一致：`DEFAULT_CONFIG` 是 1000 筹码 / 20 大盲 = **50BB**，
 * 测量台 `head2head.ts` / `hlb-bots.ts` 也是 STACK=1000，每手都以 50BB 开局。
 * 旧值 100 让整棵树的 all-in 分支（唯一对深度敏感的地方）建在 2 倍深度上：
 * 把「按 100BB 训出来的策略」放进 50BB 的同一抽象里评估，可利用度是
 * **1.15 BB/手**；按 50BB 重训（20 万次迭代）后是 **0.005 BB/手**，
 * 同一棵树、同一套动作、同一个评估器，可直接比。
 */
const STACK_BB = 50;
const SMALL_RAISE = 2.5;
const BIG_RAISE = 3.5;
/**
 * 3-bet 尺度口径。
 *
 * - `'min'`（默认）：和运行时**实际能执行**的动作一致。`preflopActionOf` 把
 *   `raise_big` 一律折算成 3.5BB，而面对 2.5BB 开池时最小加注正好是 3.5BB、
 *   面对 3.5BB 开池时会被 `Math.max(legal.minRaiseTo, …)` 抬到 4.5BB——
 *   两种情况都等于 **open + 1BB**，也就是一个最小加注。
 * - `'x3'`：抽象原样（open × 3 = 7.5 / 10.5BB）。运行时做不到这个尺度，
 *   所以只保留给对照诊断用。
 *
 * 抽象必须只包含「真的能执行」的动作（Libratus 的抽象也是这么定的）：
 * 树里按 3× 求出来的 3-bet 防守范围，运行时却用最小加注打出去，
 * 等于拿「面对 7.5BB 3-bet」的弃牌率去应对一个 3.5BB 的加注。
 */
export type PreflopThreeBet = 'min' | 'x3';
const THREE_BET_MODE: PreflopThreeBet = 'min';
const LIMP_RAISE = 3;
/** SB 跛入后的总投入（0.5 盲注 + 0.5 补齐）。跛入后再弃牌亏的是这个数，不是 0.5。 */
const LIMP_INVEST = 1;

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
export function buildPreflopTree(
  stackBB = STACK_BB,
  allowLimp = true,
  threeBet: PreflopThreeBet = THREE_BET_MODE,
): PreflopNode {
  const S = Math.max(2, stackBB);
  const raiseSmall = Math.min(S, SMALL_RAISE);
  const raiseBig = Math.min(S, BIG_RAISE);
  /** 3-bet 加到多少：最小加注（运行时实际）或 open×3（旧抽象）。 */
  const threeBetTo = (open: number): number =>
    Math.min(S, threeBet === 'min' ? open + 1 : open * 3);

  const sbVs3Bet = (open: number): PreflopNode => {
    const threeBet = threeBetTo(open);
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
      { name: 'check', next: terminalShowdown(2, LIMP_INVEST, Math.max(0, S - LIMP_INVEST)) },
      {
        name: 'raise_small',
        next: {
          id: 'sb_vs_limp_raise',
          player: 'sb',
          actions: [
            // 已跛入 1BB，弃牌亏 1BB。旧实现写 -0.5，把跛入成本砍半，
            // 这是「SB 99% 跛入」的直接原因。
            { name: 'fold', next: terminalFold(-LIMP_INVEST) },
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
            { name: 'fold', next: terminalFold(-LIMP_INVEST) },
            { name: 'call', next: terminalShowdown(2 * S, S, 0, true) },
          ],
        },
      },
    ],
  };

  /**
   * BB 面对「开池即全下」。
   *
   * 旧树里 SB 从根节点只能 fold / 开池，所以「对手开池全下」这种局面没有节点，
   * `preflopNodeForView` 只能把它按开池尺度塞进 `bb_vs_open_3.5`——那是按
   * 3.5BB 开池解出来的防守范围（弃 40.5% / 跟 44.7%），拿它去接 50BB 全下
   * 明显太松（同深度的 `sb_vs_allin` 是弃 86.6%）。
   *
   * 加一个专节点后，SB 也顺带学会了「能不能开池全下」；如果均衡给出病态的
   * 大比例开池全下，说明是翻后模型太粗把全下美化过头了，应改回「该场合不用蓝图」。
   */
  const bbVsAllin: PreflopNode = {
    id: 'bb_vs_allin',
    player: 'bb',
    actions: [
      { name: 'fold', next: terminalFold(1) },
      { name: 'call', next: terminalShowdown(2 * S, S, 0, true) },
    ],
  };

  return {
    id: 'sb_root',
    player: 'sb',
    actions: [
      { name: 'fold', next: terminalFold(-0.5) },
      // 允许跛入时把 limp 放进树里。禁用后 SB 只能「加注或弃牌」，
      // 策略不再依赖翻后技术（我们的翻后是启发式，跛入会很吃亏）。
      ...(allowLimp ? [{ name: 'call' as const, next: bbVsLimp }] : []),
      { name: 'raise_small', next: bbVsOpen(raiseSmall) },
      { name: 'raise_big', next: bbVsOpen(raiseBig) },
      { name: 'allin', next: bbVsAllin },
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

/**
 * 权益实现率（equity realization）：原始胜率能兑现成多少底池份额。
 *
 * 翻前解只与「它假设的翻后打法」一致。旧实现用 `equity × pot`（等价于假设后续街全部过牌），
 * 完全忽略位置，这是抽象失真的主要来源。这里显式建模：
 * - 有位置（单挑 SB / 按钮）翻后能多兑现一些（可以免费看牌、控制底池、按需下注）；
 * - 无位置（BB）兑现少于原始胜率（被迫先行动、容易被压榨）；
 * - SPR 越低，位置越不重要（全下之后就没有位置可言）。
 *
 * 份额用归一化形式保证零和：SB 拿 share、BB 拿 1−share，两者之和恒等于底池。
 */
/**
 * 权益实现率默认值，导出给离线验收（`blueprintEval.ts`）复用，
 * 避免评估器和求解器各写一份常量、悄悄漂移。
 */
export const DEFAULT_REALIZATION_IP = 1.05;
export const DEFAULT_REALIZATION_OOP = 0.95;

let realizationIp = DEFAULT_REALIZATION_IP;
let realizationOop = DEFAULT_REALIZATION_OOP;

function realizationFactor(
  remaining: number,
  pot: number,
  inPosition: boolean,
  ip = realizationIp,
  oop = realizationOop,
): number {
  const spr = pot > 0 ? remaining / pot : 0;
  const positionalWeight = Math.min(1, spr / 4);
  const base = inPosition ? ip : oop;
  return 1 + (base - 1) * positionalWeight;
}

/**
 * 叶节点估值。导出是为了让离线验收（`blueprintEval.ts`）用**同一份**模型重算，
 * 而不是各写一份常量悄悄漂移。默认取求解器当前的实现率。
 */
export function preflopTerminalEv(
  terminal: PreflopTerminal,
  equity: number,
  ip = realizationIp,
  oop = realizationOop,
): number {
  if (terminal.kind === 'fold') return terminal.payoffSb;
  // 全下：没有后续街，直接按原始胜率结算。
  if (terminal.allin || terminal.remaining <= 0) return equity * terminal.pot - terminal.investSb;
  const sbFactor = realizationFactor(terminal.remaining, terminal.pot, true, ip, oop);
  const bbFactor = realizationFactor(terminal.remaining, terminal.pot, false, ip, oop);
  const sbWeight = Math.max(1e-9, equity * sbFactor);
  const bbWeight = Math.max(1e-9, (1 - equity) * bbFactor);
  const share = sbWeight / (sbWeight + bbWeight);
  return share * terminal.pot - terminal.investSb;
}

/**
 * 用 CFR+ 求解翻前抽象游戏。
 * 每个桶一个信息集；对 N×N 个桶对做全枚举 CFR（chance 节点均匀）。
 */
export function solvePreflopBlueprint(
  options: {
    iterations?: number;
    stackBB?: number;
    /** 有位置的权益实现率（默认 1.05）。 */
    realizationIp?: number;
    /** 无位置的权益实现率（默认 0.95）。 */
    realizationOop?: number;
    /** SB 是否允许跛入（默认 true；关掉后 SB 只能加注或弃牌）。 */
    allowLimp?: boolean;
    /** 3-bet 几何（默认 'min'，= 运行时实际能执行的最小加注）。 */
    threeBet?: PreflopThreeBet;
  } = {},
): PreflopBlueprint {
  const iterations = Math.max(100, Math.floor(options.iterations ?? 6000));
  const stackBB = options.stackBB ?? STACK_BB;
  const allowLimp = options.allowLimp ?? true;
  const threeBet = options.threeBet ?? THREE_BET_MODE;
  realizationIp = options.realizationIp ?? DEFAULT_REALIZATION_IP;
  realizationOop = options.realizationOop ?? DEFAULT_REALIZATION_OOP;
  const tree = buildPreflopTree(stackBB, allowLimp, threeBet);
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
      return preflopTerminalEv(node, equityMatrix[sbBucket][bbBucket]);
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

  /**
   * 真正的最佳回应（best response）。
   *
   * 关键点：最佳回应方**只能看到自己的桶**，不能看到对手的桶。
   * 旧实现按 (sbBucket, bbBucket) 组合分别取 max，等价于让回应方看穿对手手牌——
   * 那是「开了天眼的假 BR」，会把可利用度算到 3.3 BB/手并永远不下降。
   *
   * 正确做法：把对手每个桶的 reach 作为一个向量往下传，
   * 在回应方的节点先对对手桶加权求和，再对动作取 max/min。
   */
  const brTraverse = (
    node: PreflopNode | PreflopTerminal,
    brPlayer: 'sb' | 'bb',
    brBucket: number,
    oppReach: number[],
  ): number => {
    if (!('player' in node)) {
      let total = 0;
      for (let other = 0; other < PREFLOP_BUCKETS; other++) {
        const weight = oppReach[other];
        if (weight <= 0) continue;
        const sbBucket = brPlayer === 'sb' ? brBucket : other;
        const bbBucket = brPlayer === 'bb' ? brBucket : other;
        total += weight * preflopTerminalEv(node, equityMatrix[sbBucket][bbBucket]);
      }
      return total;
    }
    if (node.player === brPlayer) {
      let best = brPlayer === 'sb' ? -Infinity : Infinity;
      for (const action of node.actions) {
        const value = brTraverse(action.next, brPlayer, brBucket, oppReach);
        best = brPlayer === 'sb' ? Math.max(best, value) : Math.min(best, value);
      }
      return best;
    }
    let value = 0;
    for (let index = 0; index < node.actions.length; index++) {
      const next = new Array<number>(PREFLOP_BUCKETS).fill(0);
      let any = false;
      for (let other = 0; other < PREFLOP_BUCKETS; other++) {
        if (oppReach[other] <= 0) continue;
        const strategy =
          average.get(buildInfoKey(node.player, node.id, other)) ??
          regretMatchingPlus(new Array(node.actions.length).fill(0));
        next[other] = oppReach[other] * strategy[index];
        any = true;
      }
      if (any) value += brTraverse(node.actions[index].next, brPlayer, brBucket, next);
    }
    return value;
  };

  /** 对 brPlayer 的每个桶算 BR 值，再对桶均匀平均（chance 均匀）。 */
  const bestResponseValue = (player: 'sb' | 'bb'): number => {
    const uniform = new Array<number>(PREFLOP_BUCKETS).fill(1 / PREFLOP_BUCKETS);
    let total = 0;
    for (let bucket = 0; bucket < PREFLOP_BUCKETS; bucket++) {
      total += brTraverse(tree, player, bucket, uniform);
    }
    return total / PREFLOP_BUCKETS;
  };

  /**
   * 双方都按**平均策略**行动时的期望价值。
   *
   * 旧实现用 `totalValue`（最后一次迭代的**当前策略**价值）作为基准去减最佳回应，
   * 但最佳回应是对平均策略算的——两个策略组合不是同一个，减出来的差值不是可利用度。
   * 这就是旧版可利用度卡在 3.3 BB/手、加迭代也不下降的原因。
   */
  const valueOfAverage = (
    node: PreflopNode | PreflopTerminal,
    sbBucket: number,
    bbBucket: number,
  ): number => {
    if (!('player' in node)) return preflopTerminalEv(node, equityMatrix[sbBucket][bbBucket]);
    const bucket = node.player === 'sb' ? sbBucket : bbBucket;
    const strategy =
      average.get(buildInfoKey(node.player, node.id, bucket)) ??
      regretMatchingPlus(new Array(node.actions.length).fill(0));
    let value = 0;
    for (let index = 0; index < node.actions.length; index++) {
      value += strategy[index] * valueOfAverage(node.actions[index].next, sbBucket, bbBucket);
    }
    return value;
  };
  let averageValue = 0;
  for (let sb = 0; sb < PREFLOP_BUCKETS; sb++) {
    for (let bb = 0; bb < PREFLOP_BUCKETS; bb++) {
      averageValue += valueOfAverage(tree, sb, bb);
    }
  }
  averageValue /= PREFLOP_BUCKETS * PREFLOP_BUCKETS;

  const sbBest = bestResponseValue('sb');
  const bbMin = bestResponseValue('bb');
  const exploitability =
    Math.max(0, sbBest - averageValue) + Math.max(0, averageValue - bbMin);
  void totalValue;

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
    description:
      `单挑翻前 CFR+ 蓝图（${PREFLOP_BUCKETS} 个真实胜率桶，${iterations} 次迭代，` +
      `${stackBB}BB，3-bet=${threeBet}，跛入=${allowLimp ? '开' : '关'}）。` +
      `exploitability 为训练时自报值，验收以 scripts/audit-preflop-blueprint.ts 重算为准。`,
    stackBB,
    buckets: PREFLOP_BUCKETS,
    iterations,
    exploitability: Number(exploitability.toFixed(4)),
    threeBet,
    allowLimp,
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

/**
 * 蓝图的可信深度区间（有效筹码 BB）。
 *
 * 蓝图是按**固定深度**（`STACK_BB` = 50BB）求解的：整棵树只有 all-in 分支对深度
 * 敏感，而 15BB 和 50BB 下「全下要冒多少风险」差三倍多。所以深度一旦偏离，
 * 表里的跟注/全下频率就系统性错掉。
 *
 * 依据：同一份 50BB 蓝图放进不同深度的同一套抽象里评估（`STACKS=... npx tsx
 * scripts/audit-preflop-blueprint.ts`），得到失配可利用度
 * 15BB 1.297 / 20BB 0.919 / 25BB 0.648 / 30BB 0.449 / 35BB 0.271 /
 * **40BB 0.129 / 50BB 0.005 / 60BB 0.032 / 70BB 0.065** / 80BB 0.098 / 100BB 0.165。
 *
 * 判据用「蓝图自己在 BB 侧带来的边际收益」（配对消融 +16.5 BB/100 ≈ 0.165 BB/手）：
 * - 下界 40BB：失配 0.129 仍小于这笔收益，到 35BB 就变成 0.271 反超 → 闸掉；
 * - 上界 70BB：失配 0.065 小于收益的一半，80BB 起 0.098 就不划算了。
 * 曲线左右不对称（短码侧陡得多），所以不用对称区间。
 */
export const BLUEPRINT_STACK_MIN_BB = 40;
export const BLUEPRINT_STACK_MAX_BB = 70;

/** 有效筹码（BB）= 双方剩余筹码+本手已投入 的较小者 / 大盲。 */
export function effectiveStackBB(view: PlayerView): number {
  const active = view.players.filter((p) => p.status === 'active' || p.status === 'allin');
  if (active.length === 0) return 0;
  const smallest = Math.min(...active.map((p) => p.stack + p.totalCommitted));
  return smallest / Math.max(1, view.bigBlind);
}

/** 当前局面是否落在蓝图可信深度内（闸门关闭时调用方直接跳过这个判断）。 */
export function preflopBlueprintInRange(
  view: PlayerView,
  minBB = BLUEPRINT_STACK_MIN_BB,
  maxBB = BLUEPRINT_STACK_MAX_BB,
): boolean {
  const stackBB = effectiveStackBB(view);
  return stackBB >= minBB && stackBB <= maxBB;
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
    if (isSb) return null;
    // 开池即全下：有专节点，不能按开池尺度塞进 bb_vs_open_*。
    if (firstRaise.action.type === 'allin') return { node: 'bb_vs_allin', player: 'bb' };
    return { node: open === 'raise_small' ? 'bb_vs_open_2.5' : 'bb_vs_open_3.5', player: 'bb' };
  }
  if (raises.length === 2) {
    if (!isSb) return null;
    const suffix = open === 'raise_small' ? '2.5' : '3.5';
    /**
     * 第二次加注如果是**全下**，这里必须给全下应对节点（fold / call），
     * 不能给 3-bet 防守节点。
     *
     * 旧实现只数「加注次数」，把全下也算成一次普通加注，于是 SB 面对 50BB 全下时
     * 拿到的是 `sb_vs_3bet_*`——那是按 7.5BB 的 3-bet 解出来的防守范围（弃 53.7%），
     * 结果 AI 面对全下在跟注 46%，而 `sb_vs_allin_*` 里现成的策略是弃 88.7%。
     * 离线量化：这一条让抽象内可利用度多出 +0.74 BB/手（老产物 +1.42）。
     */
    if (raises[1].action.type === 'allin') {
      return { node: `sb_vs_allin_${suffix}`, player: 'sb' };
    }
    return { node: `sb_vs_3bet_${suffix}`, player: 'sb' };
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

/* ------------------------------------------------------------------ */
/* 用蓝图构造翻后范围（策略一致的贝叶斯先验）                          */
/* ------------------------------------------------------------------ */

/**
 * 由翻前蓝图的**动作频率**构造每个对手的翻后范围权重。
 *
 * 这是 ReBeL / Libratus 里 belief 的简化版：对手拿到某手牌时，
 * 走这条翻前动作线的概率 = 沿途每个动作在其信息集策略里的概率之积。
 * 旧实现（`buildChallengeRanges`）用的是「翻前强度 + 加注次数」的启发式，
 * 与对手实际会怎么打无关；这里换成「对手真的会这样打吗」。
 *
 * 只处理单挑；多人或没有蓝图时返回 null，调用方回退到旧模型。
 *
 * `includeViewer`：把**自己**也放进返回的 Map（默认 false，行为与旧版逐位相同）。
 * 范围优势层需要「双方来自同一套信念」的对比：两侧若用不同估计器，
 * edge 里会混进「模型宽度差」这个与牌面无关的系统偏差。
 */
export function buildBlueprintRangeWeights(
  view: PlayerView,
  options: { includeViewer?: boolean } = {},
): Map<number, RangeWeight> | null {
  const blueprint = blueprintCache;
  if (!blueprint) return null;
  if (view.street === 'preflop') return null;
  if (view.players.length !== 2) return null;
  const preflopActions = view.actions.filter((record) => record.street === 'preflop');
  if (preflopActions.length === 0) return null;

  const tree = buildPreflopTree(blueprint.stackBB, true);
  const bigBlind = Math.max(1, view.bigBlind);
  const buttonId = view.players[view.buttonIndex]?.id;

  const mapAction = (record: (typeof preflopActions)[number]): PreflopActionName | null => {
    switch (record.action.type) {
      case 'fold':
        return 'fold';
      case 'check':
        return 'check';
      case 'allin':
        return 'allin';
      case 'call':
        return 'call';
      case 'bet':
      case 'raise':
        return record.toAmount / bigBlind <= 3 ? 'raise_small' : 'raise_big';
      default:
        return null;
    }
  };

  /** 某个桶走完整条翻前动作线的概率。 */
  const lineProbability = (seat: 'sb' | 'bb', bucket: number): number => {
    let probability = 1;
    let node: PreflopNode | PreflopTerminal = tree;
    for (const record of preflopActions) {
      if (!('player' in node)) break;
      const mapped = mapAction(record);
      if (!mapped) return 0;
      const index = node.actions.findIndex((action) => action.name === mapped);
      if (index < 0) return 0;
      if (node.player === seat) {
        const entry = blueprint.entries.find(
          (item) => item.node === (node as PreflopNode).id && item.bucket === bucket,
        );
        probability *= entry?.strategy[index] ?? 0;
        if (probability <= 0) return 0;
      }
      node = node.actions[index].next;
    }
    return probability;
  };

  const out = new Map<number, RangeWeight>();
  for (const player of view.players) {
    if (player.id === view.viewerId && options.includeViewer !== true) continue;
    const seat: 'sb' | 'bb' = player.id === buttonId ? 'sb' : 'bb';
    const perBucket: number[] = [];
    for (let bucket = 0; bucket < PREFLOP_BUCKETS; bucket++) {
      perBucket.push(lineProbability(seat, bucket));
    }
    const total = perBucket.reduce((sum, value) => sum + value, 0);
    // 整条线在抽象里概率为 0（例如对手用了抽象外的尺度）：放弃，让调用方回退。
    if (total <= 1e-9) return null;
    out.set(player.id, (first, second) => {
      const bucket = bucketOfCards(first, second);
      return perBucket[bucket] ?? 0;
    });
  }
  return out.size > 0 ? out : null;
}
