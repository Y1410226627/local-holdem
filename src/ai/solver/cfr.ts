/**
 * CFR+ 基础原语（Libratus / DeepStack / Pluribus 共用的核心）。
 *
 * 实现要点：
 * - 遗憾匹配+（Regret Matching+）：每轮把负遗憾截断到 0；
 * - 线性加权平均：第 t 轮的策略按 t 加权，收敛更快；
 * - 可利用度计算：用于测试与离线验收，不进入运行时决策。
 *
 * 这里不绑定具体扑克树；`preflop.ts` 与 `subgame.ts` 复用这些原语。
 */

export function regretMatchingPlus(regrets: readonly number[]): number[] {
  const positive = regrets.map((value) => Math.max(0, value));
  const sum = positive.reduce((total, value) => total + value, 0);
  if (sum <= 1e-12) return positive.map(() => 1 / Math.max(1, positive.length));
  return positive.map((value) => value / sum);
}

/** CFR+ 遗憾更新：R_{t+1} = max(0, R_t + v(a) - v(node))。 */
export function updateRegretPlus(
  regrets: number[],
  actionValues: readonly number[],
  nodeValue: number,
): void {
  for (let index = 0; index < regrets.length; index++) {
    regrets[index] = Math.max(0, regrets[index] + (actionValues[index] ?? 0) - nodeValue);
  }
}

/** 线性加权策略累加：第 t 轮权重为 t。 */
export function accumulateStrategy(
  strategySum: number[],
  strategy: readonly number[],
  weight: number,
): void {
  for (let index = 0; index < strategySum.length; index++) {
    strategySum[index] += (strategy[index] ?? 0) * weight;
  }
}

export function averageStrategy(strategySum: readonly number[]): number[] {
  const total = strategySum.reduce((sum, value) => sum + value, 0);
  if (total <= 1e-12) return strategySum.map(() => 1 / Math.max(1, strategySum.length));
  return strategySum.map((value) => value / total);
}

export interface MatrixGameSolution {
  row: number[];
  col: number[];
  value: number;
  /** 双方偏离收益之和（BB/手或筹码单位）。 */
  exploitability: number;
  iterations: number;
}

/**
 * 零和矩阵博弈 CFR+（用于测试 CFR 原语与短码 push/fold 的对照）。
 * payoff[row][col] 是行玩家的收益。
 */
export function solveMatrixGame(
  payoff: readonly (readonly number[])[],
  iterations = 2000,
): MatrixGameSolution {
  const rows = payoff.length;
  const cols = payoff[0]?.length ?? 0;
  if (rows === 0 || cols === 0) {
    return { row: [], col: [], value: 0, exploitability: 0, iterations: 0 };
  }
  const rowRegret = new Array<number>(rows).fill(0);
  const colRegret = new Array<number>(cols).fill(0);
  const rowSum = new Array<number>(rows).fill(0);
  const colSum = new Array<number>(cols).fill(0);
  let value = 0;

  for (let iteration = 1; iteration <= iterations; iteration++) {
    const rowStrategy = regretMatchingPlus(rowRegret);
    const colStrategy = regretMatchingPlus(colRegret);
    const rowValues = new Array<number>(rows).fill(0);
    for (let row = 0; row < rows; row++) {
      let total = 0;
      for (let col = 0; col < cols; col++) total += payoff[row][col] * colStrategy[col];
      rowValues[row] = total;
    }
    const rowValue = rowValues.reduce(
      (sum, entry, index) => sum + entry * rowStrategy[index],
      0,
    );
    value = rowValue;
    for (let row = 0; row < rows; row++) {
      rowRegret[row] = Math.max(0, rowRegret[row] + rowValues[row] - rowValue);
      rowSum[row] += rowStrategy[row] * iteration;
    }
    const colValues = new Array<number>(cols).fill(0);
    for (let col = 0; col < cols; col++) {
      let total = 0;
      for (let row = 0; row < rows; row++) total += -payoff[row][col] * rowStrategy[row];
      colValues[col] = total;
    }
    const colValue = -rowValue;
    for (let col = 0; col < cols; col++) {
      colRegret[col] = Math.max(0, colRegret[col] + colValues[col] - colValue);
      colSum[col] += colStrategy[col] * iteration;
    }
  }

  const row = averageStrategy(rowSum);
  const col = averageStrategy(colSum);
  let bestRow = -Infinity;
  for (let r = 0; r < rows; r++) {
    let total = 0;
    for (let c = 0; c < cols; c++) total += payoff[r][c] * col[c];
    bestRow = Math.max(bestRow, total);
  }
  let bestCol = -Infinity;
  for (let c = 0; c < cols; c++) {
    let total = 0;
    for (let r = 0; r < rows; r++) total += -payoff[r][c] * row[r];
    bestCol = Math.max(bestCol, total);
  }
  const valueOf = (rowMix: readonly number[], colMix: readonly number[]): number => {
    let total = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) total += rowMix[r] * colMix[c] * payoff[r][c];
    }
    return total;
  };
  const mixedValue = valueOf(row, col);
  const exploitability = Math.max(0, bestRow - mixedValue) + Math.max(0, bestCol + mixedValue);
  return { row, col, value, exploitability, iterations };
}
