/**
 * 训练转牌价值网络（B 路线）。
 *
 * 流程：
 *   1. 随机生成转牌局面（底牌 / 牌面 / 底池 / 是否面对下注）；
 *   2. 每个局面跑一次精确的转河求解器，取 `rootValueFromNow / pot` 作为标签；
 *   3. 用 24→48→1 的 MLP + 带动量的小批量 SGD + L2 拟合；
 *   4. 按**留出集 R²** 做早停，导出最优权重。
 *
 * 用法：SAMPLES=2500 COMBOS=32 ITERS=250 npx tsx scripts/train-turn-value.ts
 *
 * 为什么这一版才可能达标：
 *   上一版 1200 样本 / 16 组合 / 120 迭代，标签本身的噪声就大于信号
 *   （同样的特征在 300 样本 + 40 组合时 R² 有 0.554，1200 样本 + 16 组合反而掉到 0.378
 *   ——样本更多但标签更差，说明瓶颈是**标签质量**，不是样本量）。
 *   所以这一版优先提高求解器精度，其次才是加样本。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { buildPlayerView } from '../src/game/playerView';
import { createDeck, derivedRng, shuffle } from '../src/game/cards';
import { solveTurnRiver } from '../src/ai/solver/subgameTurn';
import {
  turnValueFeatures,
  TURN_VALUE_FEATURES,
  TURN_VALUE_HIDDEN,
  zeroWeights,
} from '../src/ai/solver/turnValue';
import { CC, makeHand, playSequence, playToStreet } from '../src/tests/helpers';
import type { Card, PlayerView } from '../src/game/types';

const SAMPLES = Number(process.env.SAMPLES ?? 2500);
const EPOCHS = Number(process.env.EPOCHS ?? 400);
const LR = Number(process.env.LR ?? 0.01);
const L2 = Number(process.env.L2 ?? 1e-4);
const BATCH = Number(process.env.BATCH ?? 32);
const SOLVER_ITERATIONS = Number(process.env.ITERS ?? 250);
const SOLVER_COMBOS = Number(process.env.COMBOS ?? 32);
const SOLVER_RIVER_BUCKETS = Number(process.env.RIVER_BUCKETS ?? 4);
/** 面对下注的样本比例。翻牌蓝图的叶子是「转牌起点、无人下注」，所以别全给下注局面。 */
const BET_RATIO = Number(process.env.BET_RATIO ?? 0.45);
const OUT_FILE = process.env.OUT ?? 'src/ai/data/turn-value.json';
const CACHE_FILE = process.env.CACHE ?? '.turn-value-samples.json';

const rng = derivedRng('turn-value-train-v2');
const RANK_TEXT: Record<number, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};
const label = (card: Card) => `${RANK_TEXT[card.rank] ?? String(card.rank)}${card.suit}`;
const holeText = (cards: Card[]) => cards.map(label).join(' ');

/** 造一个随机的转牌局面。 */
function randomTurnView(seed: string): PlayerView | null {
  const deck = shuffle(createDeck(), rng);
  const hero: Card[] = [deck[0], deck[1]];
  const villain: Card[] = [deck[2], deck[3]];
  const board = [deck[4], deck[5], deck[6], deck[7]]; // 4 张 = 转牌

  let hand = playToStreet(
    makeHand({
      stacks: [1000, 1000],
      buttonIndex: 0,
      seed,
      holeCards: [CC(holeText(hero)), CC(holeText(villain))],
      board: CC([...board, deck[8]].map(label).join(' ')),
    }),
    'turn',
  );
  const betSize = Math.round((30 + rng() * 170) / 10) * 10;
  const shouldBet = rng() < BET_RATIO;
  if (shouldBet) {
    hand = hand.actingIndex === 0
      ? playSequence(hand, [[0, { type: 'check' }], [1, { type: 'bet', amount: betSize }]])
      : playSequence(hand, [[1, { type: 'bet', amount: betSize }]]);
  } else if (hand.actingIndex === 1) {
    hand = playSequence(hand, [[1, { type: 'check' }]]);
  }
  const view = buildPlayerView(hand, 0, seed);
  return view.legal ? view : null;
}

interface SampleSet {
  features: number[][];
  labels: number[];
}

/** 生成样本（带磁盘缓存，避免重跑几十分钟的求解器）。 */
function collect(): SampleSet {
  const cached = (() => {
    try {
      const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
      if (
        raw.features === TURN_VALUE_FEATURES &&
        raw.combos === SOLVER_COMBOS &&
        raw.iters === SOLVER_ITERATIONS &&
        Array.isArray(raw.featuresList) &&
        raw.featuresList.length >= SAMPLES
      ) {
        return raw as { featuresList: number[][]; labels: number[] };
      }
    } catch {
      /* 无缓存 */
    }
    return null;
  })();
  if (cached) {
    console.log(`复用缓存 ${CACHE_FILE}（${cached.featuresList.length} 个样本）`);
    return { features: cached.featuresList.slice(0, SAMPLES), labels: cached.labels.slice(0, SAMPLES) };
  }

  console.log(`生成 ${SAMPLES} 个样本（组合 ${SOLVER_COMBOS} / 迭代 ${SOLVER_ITERATIONS}）…`);
  const features: number[][] = [];
  const labels: number[] = [];
  const started = Date.now();
  for (let index = 0; index < SAMPLES; index++) {
    const view = randomTurnView(`tv2-${index}`);
    if (!view) continue;
    const solved = solveTurnRiver(view, {
      iterations: SOLVER_ITERATIONS,
      maxCombos: SOLVER_COMBOS,
      riverBuckets: SOLVER_RIVER_BUCKETS,
    });
    if (!solved) continue;
    const pot = Math.max(1, view.pot);
    features.push(turnValueFeatures(view));
    labels.push(solved.rootValueFromNow / pot);
    if ((index + 1) % 100 === 0) {
      const spent = (Date.now() - started) / 1000;
      console.log(`  ${index + 1}/${SAMPLES}（${spent.toFixed(0)}s，预计还需 ${((spent / (index + 1)) * (SAMPLES - index - 1)).toFixed(0)}s）`);
    }
  }
  console.log(`样本 ${features.length} 个，用时 ${((Date.now() - started) / 1000).toFixed(0)}s`);
  try {
    writeFileSync(
      CACHE_FILE,
      JSON.stringify({ features: TURN_VALUE_FEATURES, combos: SOLVER_COMBOS, iters: SOLVER_ITERATIONS, featuresList: features, labels }),
      'utf8',
    );
    console.log(`缓存写入 ${CACHE_FILE}`);
  } catch {
    /* 缓存失败不影响训练 */
  }
  return { features, labels };
}

const { features, labels } = collect();

/* 标准化标签 */
const meanLabel = labels.reduce((a, b) => a + b, 0) / labels.length;
const stdLabel =
  Math.sqrt(labels.reduce((a, b) => a + (b - meanLabel) ** 2, 0) / labels.length) || 1;
const normalized = labels.map((value) => (value - meanLabel) / stdLabel);
console.log(
  `标签：均值 ${meanLabel.toFixed(3)}，标准差 ${stdLabel.toFixed(3)}，` +
  `范围 [${Math.min(...labels).toFixed(2)}, ${Math.max(...labels).toFixed(2)}]`,
);

/* 划分训练 / 留出 */
const order = features.map((_, index) => index);
for (let i = order.length - 1; i > 0; i--) {
  const j = Math.floor(rng() * (i + 1));
  [order[i], order[j]] = [order[j], order[i]];
}
const splitAt = Math.floor(order.length * 0.8);
const trainIdx = order.slice(0, splitAt);
const testIdx = order.slice(splitAt);

/* 初始化 */
const weights = zeroWeights();
for (let h = 0; h < TURN_VALUE_HIDDEN; h++) {
  for (let f = 0; f < TURN_VALUE_FEATURES; f++) weights.w1[h][f] = (rng() * 2 - 1) * 0.25;
  weights.w2[h] = (rng() * 2 - 1) * 0.25;
}
const mW1 = weights.w1.map((row) => row.map(() => 0));
const mB1 = new Array(TURN_VALUE_HIDDEN).fill(0);
const mW2 = new Array(TURN_VALUE_HIDDEN).fill(0);
let mB2 = 0;
const MOMENTUM = 0.9;

function forward(x: number[]): { hidden: number[]; out: number } {
  const hidden: number[] = [];
  let out = weights.b2;
  for (let h = 0; h < TURN_VALUE_HIDDEN; h++) {
    let sum = weights.b1[h];
    for (let f = 0; f < TURN_VALUE_FEATURES; f++) sum += weights.w1[h][f] * x[f];
    const act = sum > 0 ? sum : 0;
    hidden.push(act);
    out += weights.w2[h] * act;
  }
  return { hidden, out };
}

function r2(indices: number[]): { r2: number; mae: number } {
  const preds = indices.map((index) => forward(features[index]).out);
  const truth = indices.map((index) => normalized[index]);
  const mean = truth.reduce((a, b) => a + b, 0) / truth.length;
  let ssRes = 0;
  let ssTot = 0;
  let mae = 0;
  for (let i = 0; i < preds.length; i++) {
    ssRes += (truth[i] - preds[i]) ** 2;
    ssTot += (truth[i] - mean) ** 2;
    mae += Math.abs(truth[i] - preds[i]);
  }
  return { r2: ssTot > 1e-9 ? 1 - ssRes / ssTot : 0, mae: mae / preds.length };
}

const snapshot = (): typeof weights => JSON.parse(JSON.stringify(weights));
let bestWeights = snapshot();
let bestTest = -Infinity;
let bestEpoch = 0;

const shuffled = [...trainIdx];
for (let epoch = 0; epoch < EPOCHS; epoch++) {
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const lr = LR * (1 - (epoch / EPOCHS) * 0.85);
  let loss = 0;
  for (let start = 0; start < shuffled.length; start += BATCH) {
    const batch = shuffled.slice(start, start + BATCH);
    // 累积梯度后统一更新（真正的 mini-batch）
    const gW1 = weights.w1.map((row) => row.map(() => 0));
    const gB1 = new Array(TURN_VALUE_HIDDEN).fill(0);
    const gW2 = new Array(TURN_VALUE_HIDDEN).fill(0);
    let gB2 = 0;
    for (const index of batch) {
      const x = features[index];
      const target = normalized[index];
      const { hidden, out } = forward(x);
      const error = out - target;
      loss += error * error;
      const gradOut = (2 * error) / batch.length;
      gB2 += gradOut;
      for (let h = 0; h < TURN_VALUE_HIDDEN; h++) {
        const gradHidden = gradOut * weights.w2[h] * (hidden[h] > 0 ? 1 : 0);
        gW2[h] += gradOut * hidden[h];
        gB1[h] += gradHidden;
        for (let f = 0; f < TURN_VALUE_FEATURES; f++) gW1[h][f] += gradHidden * x[f];
      }
    }
    mB2 = MOMENTUM * mB2 - lr * gB2;
    weights.b2 += mB2;
    for (let h = 0; h < TURN_VALUE_HIDDEN; h++) {
      mW2[h] = MOMENTUM * mW2[h] - lr * gW2[h];
      weights.w2[h] += mW2[h];
      mB1[h] = MOMENTUM * mB1[h] - lr * gB1[h];
      weights.b1[h] += mB1[h];
      for (let f = 0; f < TURN_VALUE_FEATURES; f++) {
        mW1[h][f] = MOMENTUM * mW1[h][f] - lr * (gW1[h][f] + L2 * weights.w1[h][f]);
        weights.w1[h][f] += mW1[h][f];
      }
    }
  }
  if ((epoch + 1) % 20 === 0) {
    const test = r2(testIdx);
    if (test.r2 > bestTest) {
      bestTest = test.r2;
      bestEpoch = epoch + 1;
      bestWeights = snapshot();
    }
    console.log(
      `  epoch ${epoch + 1}: 训练 MSE ${(loss / shuffled.length).toFixed(4)}，` +
      `留出 R² ${test.r2.toFixed(3)}（最优 ${bestTest.toFixed(3)} @ ${bestEpoch}）`,
    );
  }
}

/* 用最优权重评估 */
const saved = JSON.parse(JSON.stringify(weights));
Object.assign(weights, bestWeights);
const trainScore = r2(trainIdx);
const testScore = r2(testIdx);
Object.assign(weights, saved);

console.log(`\n训练集 R² = ${trainScore.r2.toFixed(3)}（MAE ${trainScore.mae.toFixed(3)} 个标准差）`);
console.log(`留出集 R² = ${testScore.r2.toFixed(3)}（MAE ${testScore.mae.toFixed(3)} 个标准差）`);
console.log(`留出集 MAE 折算：${(testScore.mae * stdLabel).toFixed(3)} 个底池`);
console.log(`\n判定：留出集 R² ${testScore.r2.toFixed(3)} → ${testScore.r2 >= 0.3 ? '可用' : '不可用'}（门槛 0.3）`);

const payload = {
  generatedAt: new Date().toISOString(),
  description:
    `转牌价值网络：${TURN_VALUE_FEATURES} 维特征 → ${TURN_VALUE_HIDDEN} 单元 ReLU → 1 个标量（EV/底池）。` +
    '标签来自精确的转河 CFR+ 求解器 rootValueFromNow。',
  samples: features.length,
  solverCombos: SOLVER_COMBOS,
  solverIterations: SOLVER_ITERATIONS,
  trainR2: Number(trainScore.r2.toFixed(3)),
  testR2: Number(testScore.r2.toFixed(3)),
  bestEpoch,
  labelMean: meanLabel,
  labelStd: stdLabel,
  features: TURN_VALUE_FEATURES,
  hidden: TURN_VALUE_HIDDEN,
  weights: bestWeights,
};
writeFileSync(OUT_FILE, JSON.stringify(payload), 'utf8');
console.log(`已写入 ${OUT_FILE}`);
