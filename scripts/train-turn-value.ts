/**
 * 训练转牌价值网络（B3 + B4）。
 *
 * 流程：
 *   1. 随机生成转牌局面（底牌 / 公共牌 / 底池 / 是否面对下注）；
 *   2. 每个局面跑一次精确的转河求解器，取 `rootValueFromNow / pot` 作为标签；
 *   3. 用 12→16→1 的 MLP + SGD 拟合；
 *   4. 报告训练集/留出集 R²，导出权重。
 *
 * 用法：SAMPLES=600 EPOCHS=3000 npx tsx scripts/train-turn-value.ts
 *
 * 说明：样本只能一个个跑求解器（每个约 150ms），所以量做不大。
 * R² 是最关键的判据——如果留出集 R² 很低，说明这套特征根本预测不了转牌价值，
 * 那就不该把它接进翻牌蓝图，而不是硬接。
 */
import { writeFileSync } from 'node:fs';
import { buildPlayerView } from '../src/game/playerView';
import { createDeck, derivedRng, shuffle } from '../src/game/cards';
import { solveTurnRiver } from '../src/ai/solver/subgameTurn';
import { turnValueFeatures, TURN_VALUE_FEATURES, TURN_VALUE_HIDDEN, zeroWeights } from '../src/ai/solver/turnValue';
import { CC, makeHand, playSequence, playToStreet } from '../src/tests/helpers';
import type { Card, PlayerView } from '../src/game/types';

const SAMPLES = Number(process.env.SAMPLES ?? 600);
const EPOCHS = Number(process.env.EPOCHS ?? 3000);
const LR = Number(process.env.LR ?? 0.02);
const SOLVER_ITERATIONS = Number(process.env.SOLVER_ITERATIONS ?? 120);
const SOLVER_COMBOS = Number(process.env.SOLVER_COMBOS ?? 16);
const OUT_FILE = process.env.OUT ?? 'src/ai/data/turn-value.json';

const rng = derivedRng('turn-value-train');
const pick = <T>(list: readonly T[]): T => list[Math.floor(rng() * list.length)];

/** 造一个随机的转牌局面。 */
function randomTurnView(seed: string): PlayerView | null {
  const deck = shuffle(createDeck(), rng);
  const hero: Card[] = [deck[0], deck[1]];
  const villain: Card[] = [deck[2], deck[3]];
  const board = [deck[4], deck[5], deck[6], deck[7]]; // 4 张 = 转牌
  const RANK_TEXT: Record<number, string> = {
    2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
    10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
  };
  const label = (card: Card) => `${RANK_TEXT[card.rank] ?? String(card.rank)}${card.suit}`;
  const holeText = (cards: Card[]) => cards.map(label).join(' ');

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
  // 一半局面让对手下注（0.5~1 池），一半过牌
  const betSize = Math.round((40 + rng() * 160) / 10) * 10;
  const shouldBet = rng() < 0.6;
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

console.log(`生成 ${SAMPLES} 个样本（每个跑一次求解器）…`);
const features: number[][] = [];
const labels: number[] = [];
const started = Date.now();
for (let index = 0; index < SAMPLES; index++) {
  const view = randomTurnView(`tv-${index}`);
  if (!view) continue;
  const solved = solveTurnRiver(view, {
    iterations: SOLVER_ITERATIONS,
    maxCombos: SOLVER_COMBOS,
    riverBuckets: 3,
  });
  if (!solved) continue;
  const pot = Math.max(1, view.pot);
  features.push(turnValueFeatures(view));
  labels.push(solved.rootValueFromNow / pot);
  if ((index + 1) % 100 === 0) {
    console.log(`  ${index + 1}/${SAMPLES}（${((Date.now() - started) / 1000).toFixed(0)}s）`);
  }
}
console.log(`样本 ${features.length} 个，用时 ${((Date.now() - started) / 1000).toFixed(0)}s`);

/* 标准化标签，便于训练 */
const meanLabel = labels.reduce((a, b) => a + b, 0) / labels.length;
const stdLabel =
  Math.sqrt(labels.reduce((a, b) => a + (b - meanLabel) ** 2, 0) / labels.length) || 1;
const normalized = labels.map((value) => (value - meanLabel) / stdLabel);
console.log(`标签：均值 ${meanLabel.toFixed(3)}，标准差 ${stdLabel.toFixed(3)}，范围 [${Math.min(...labels).toFixed(2)}, ${Math.max(...labels).toFixed(2)}]`);

/* 划分训练 / 留出 */
const order = features.map((_, index) => index);
for (let i = order.length - 1; i > 0; i--) {
  const j = Math.floor(rng() * (i + 1));
  [order[i], order[j]] = [order[j], order[i]];
}
const splitAt = Math.floor(order.length * 0.8);
const trainIdx = order.slice(0, splitAt);
const testIdx = order.slice(splitAt);

/* 训练 MLP */
const weights = zeroWeights();
for (let h = 0; h < TURN_VALUE_HIDDEN; h++) {
  for (let f = 0; f < TURN_VALUE_FEATURES; f++) weights.w1[h][f] = (rng() * 2 - 1) * 0.3;
  weights.w2[h] = (rng() * 2 - 1) * 0.3;
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

for (let epoch = 0; epoch < EPOCHS; epoch++) {
  let loss = 0;
  for (const index of trainIdx) {
    const x = features[index];
    const target = normalized[index];
    const { hidden, out } = forward(x);
    const error = out - target;
    loss += error * error;
    // 反向传播
    const gradOut = 2 * error;
    mB2 = MOMENTUM * mB2 - LR * gradOut;
    weights.b2 += mB2;
    for (let h = 0; h < TURN_VALUE_HIDDEN; h++) {
      const gradHidden = gradOut * weights.w2[h] * (hidden[h] > 0 ? 1 : 0);
      mW2[h] = MOMENTUM * mW2[h] - LR * gradOut * hidden[h];
      weights.w2[h] += mW2[h];
      mB1[h] = MOMENTUM * mB1[h] - LR * gradHidden;
      weights.b1[h] += mB1[h];
      for (let f = 0; f < TURN_VALUE_FEATURES; f++) {
        mW1[h][f] = MOMENTUM * mW1[h][f] - LR * gradHidden * x[f];
        weights.w1[h][f] += mW1[h][f];
      }
    }
  }
  if ((epoch + 1) % 500 === 0) {
    console.log(`  epoch ${epoch + 1}: 训练 MSE ${(loss / trainIdx.length).toFixed(4)}`);
  }
}

/* 评估 R² */
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

const trainScore = r2(trainIdx);
const testScore = r2(testIdx);
console.log(`\n训练集 R² = ${trainScore.r2.toFixed(3)}（MAE ${trainScore.mae.toFixed(3)} 个标准差）`);
console.log(`留出集 R² = ${testScore.r2.toFixed(3)}（MAE ${testScore.mae.toFixed(3)} 个标准差）`);
console.log(`留出集 MAE 折算：${(testScore.mae * stdLabel).toFixed(3)} 个底池`);

const verdict = testScore.r2 >= 0.3 ? '可用' : '不可用';
console.log(`\n判定：留出集 R² ${testScore.r2.toFixed(3)} → ${verdict}（门槛 0.3）`);

/* 导出 */
const payload = {
  generatedAt: new Date().toISOString(),
  description:
    '转牌价值网络：12 维特征 → 16 单元 ReLU → 1 个标量（EV/底池）。' +
    '标签来自精确的转河 CFR+ 求解器 rootValueFromNow。',
  samples: features.length,
  trainR2: Number(trainScore.r2.toFixed(3)),
  testR2: Number(testScore.r2.toFixed(3)),
  labelMean: meanLabel,
  labelStd: stdLabel,
  features: TURN_VALUE_FEATURES,
  hidden: TURN_VALUE_HIDDEN,
  weights,
};
writeFileSync(OUT_FILE, JSON.stringify(payload), 'utf8');
console.log(`已写入 ${OUT_FILE}`);
