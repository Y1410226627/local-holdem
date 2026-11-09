/**
 * 翻前蓝图的**离线验收器**：把一份蓝图放回抽象博弈里，算出它自己的可利用度。
 *
 * 为什么单独成文件：
 * - `preflop.ts` 的可利用度是在求解函数内部算的，只能验「刚解出来的那份」；
 *   要验「仓库里躺着的 JSON」，或者验「按 100BB 训的策略放进 50BB 的树」，
 *   需要一个能吃任意蓝图的独立评估器。
 * - 叶节点估值、树结构、真实胜率桶全部复用 `preflop.ts` 的同一份实现，
 *   只有「最佳回应怎么走」是这里重写的。两者等价性由测试锁住：
 *   `solvePreflopBlueprint()` 自报的可利用度必须等于本模块重算的结果。
 *
 * 口径提醒：可利用度是**抽象博弈内**的指标，不是对真人的期望收益。
 * 它可以用来比「同一棵树上两份策略谁更接近均衡」，
 * **不能**用来比「两棵不同的树哪棵更强」——树一改，最优值就变了。
 */
import {
  buildBucketEquityMatrix,
  buildPreflopTree,
  preflopTerminalEv,
} from './preflop';
import type {
  PreflopBlueprint,
  PreflopNode,
  PreflopTerminal,
  PreflopThreeBet,
} from './preflop';
import { PREFLOP_BUCKETS } from './abstraction';
import {
  DEFAULT_REALIZATION_IP,
  DEFAULT_REALIZATION_OOP,
} from './preflop';

export interface BlueprintEvaluation {
  stackBB: number;
  /** 双方都打平均策略时的 SB 期望收益（BB/手）。 */
  value: number;
  /** SB 最佳回应的收益（SB 视角）。 */
  bestResponseSb: number;
  /** BB 最佳回应后 SB 的收益（SB 视角，越小说明 BB 越能压）。 */
  bestResponseBb: number;
  /** 双向可利用度之和（BB/手）。 */
  exploitability: number;
}

export interface BlueprintEvalOptions {
  /** 有效筹码（BB）。默认取蓝图自己记录的 `stackBB`。 */
  stackBB?: number;
  realizationIp?: number;
  realizationOop?: number;
  /**
   * 3-bet 几何。`'min'`（默认，= 运行时实际执行的最小加注）与
   * `buildPreflopTree` 的默认值一致；`'x3'` 只用于对照旧抽象。
   */
  threeBet?: PreflopThreeBet;
  /**
   * 全下之后的应对映射。
   * - `'correct'`（默认）：BB 全下 → `sb_vs_allin_*`。
   * - `'legacy'`：复刻 P0 修复前的 bug（全下被当成普通加注，SB 拿到 3-bet 防守策略）。
   *   只用于量化「这个 bug 值多少钱」，不要在验收里用。
   */
  jamMapping?: 'correct' | 'legacy';
}

let equityCache: number[][] | null = null;

function equityMatrix(): number[][] {
  if (!equityCache) equityCache = buildBucketEquityMatrix();
  return equityCache;
}

type StrategyBook = Map<string, number[]>;

function buildStrategyBook(blueprint: PreflopBlueprint): StrategyBook {
  const book: StrategyBook = new Map();
  for (const entry of blueprint.entries) {
    book.set(`${entry.node}|${entry.bucket}`, entry.strategy);
  }
  return book;
}

/**
 * 按 `stackBB` 重建抽象树并评估 `blueprint`。
 *
 * 蓝图里 `sb_root` 带 `call`（跛入）时才会把跛入分支建进树里；
 * 树外的节点（比如蓝图缺某条线）一律按均匀策略兜底，不会静默改成别的策略。
 */
export function evaluatePreflopBlueprint(
  blueprint: PreflopBlueprint,
  options: BlueprintEvalOptions = {},
): BlueprintEvaluation {
  const stackBB = options.stackBB ?? blueprint.stackBB ?? 50;
  const ip = options.realizationIp ?? DEFAULT_REALIZATION_IP;
  const oop = options.realizationOop ?? DEFAULT_REALIZATION_OOP;
  const threeBet = options.threeBet ?? 'min';
  const jamMapping = options.jamMapping ?? 'correct';
  const rootSpec = blueprint.nodes.sb_root;
  const allowLimp = Boolean(rootSpec && rootSpec.actions.includes('call'));
  const tree = buildPreflopTree(stackBB, allowLimp, threeBet);
  const eq = equityMatrix();
  const book = buildStrategyBook(blueprint);

  const strategyOf = (node: PreflopNode, bucket: number): number[] => {
    // P0 修复前的运行时：BB 全下之后 SB 拿到的是 sb_vs_3bet_* 的防守策略。
    if (jamMapping === 'legacy' && node.id.startsWith('sb_vs_allin_')) {
      const suffix = node.id.slice(node.id.lastIndexOf('_') + 1);
      const legacy = book.get(`sb_vs_3bet_${suffix}|${bucket}`);
      if (legacy) {
        const pair = [legacy[0] ?? 0, legacy[1] ?? 0]; // fold / call
        const total = pair[0] + pair[1];
        if (total > 1e-12) return pair.map((value) => value / total);
      }
    }
    const found = book.get(`${node.id}|${bucket}`);
    if (found && found.length === node.actions.length) return found;
    return new Array<number>(node.actions.length).fill(1 / node.actions.length);
  };
  const valueAtTerminal = (terminal: PreflopTerminal, sb: number, bb: number): number =>
    preflopTerminalEv(terminal, eq[sb][bb], ip, oop);

  /** 双方都按蓝图的平均策略行动时，SB 的期望收益。 */
  const valueOf = (
    node: PreflopNode | PreflopTerminal,
    sbBucket: number,
    bbBucket: number,
  ): number => {
    if (!('player' in node)) return valueAtTerminal(node, sbBucket, bbBucket);
    const strategy = strategyOf(node, node.player === 'sb' ? sbBucket : bbBucket);
    let value = 0;
    for (let index = 0; index < node.actions.length; index++) {
      value += strategy[index] * valueOf(node.actions[index].next, sbBucket, bbBucket);
    }
    return value;
  };

  /**
   * 最佳回应：回应方只看得到自己的桶，对手每个桶的到达概率作为向量往下传，
   * 在回应方的节点先对对手桶加权求和，再对动作取 max/min（SB 视角收益）。
   */
  const bestResponse = (
    node: PreflopNode | PreflopTerminal,
    brPlayer: 'sb' | 'bb',
    brBucket: number,
    oppReach: readonly number[],
  ): number => {
    if (!('player' in node)) {
      let total = 0;
      for (let other = 0; other < PREFLOP_BUCKETS; other++) {
        const weight = oppReach[other];
        if (!(weight > 0)) continue;
        total +=
          weight * valueAtTerminal(node, brPlayer === 'sb' ? brBucket : other, brPlayer === 'bb' ? brBucket : other);
      }
      return total;
    }
    if (node.player === brPlayer) {
      let best = brPlayer === 'sb' ? -Infinity : Infinity;
      for (const action of node.actions) {
        const value = bestResponse(action.next, brPlayer, brBucket, oppReach);
        best = brPlayer === 'sb' ? Math.max(best, value) : Math.min(best, value);
      }
      return best;
    }
    let value = 0;
    for (let index = 0; index < node.actions.length; index++) {
      const next = new Array<number>(PREFLOP_BUCKETS).fill(0);
      for (let other = 0; other < PREFLOP_BUCKETS; other++) {
        if (!(oppReach[other] > 0)) continue;
        next[other] = oppReach[other] * strategyOf(node, other)[index];
      }
      value += bestResponse(node.actions[index].next, brPlayer, brBucket, next);
    }
    return value;
  };

  const uniform = new Array<number>(PREFLOP_BUCKETS).fill(1 / PREFLOP_BUCKETS);
  let value = 0;
  for (let sb = 0; sb < PREFLOP_BUCKETS; sb++) {
    for (let bb = 0; bb < PREFLOP_BUCKETS; bb++) value += valueOf(tree, sb, bb);
  }
  value /= PREFLOP_BUCKETS * PREFLOP_BUCKETS;

  let brSb = 0;
  let brBb = 0;
  for (let bucket = 0; bucket < PREFLOP_BUCKETS; bucket++) {
    brSb += bestResponse(tree, 'sb', bucket, uniform);
    brBb += bestResponse(tree, 'bb', bucket, uniform);
  }
  brSb /= PREFLOP_BUCKETS;
  brBb /= PREFLOP_BUCKETS;

  return {
    stackBB,
    value,
    bestResponseSb: brSb,
    bestResponseBb: brBb,
    exploitability: Math.max(0, brSb - value) + Math.max(0, value - brBb),
  };
}
