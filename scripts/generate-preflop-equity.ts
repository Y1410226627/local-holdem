/**
 * 生成翻前 169 类起手牌的「对随机手牌」真实胜率表。
 *
 * 为什么需要它：
 * - 原来的 `preflopStrength` 用 Chen 公式排序，再按组合数取百分位；
 *   Chen 分数会把 76s 排在 22 前面，和真实全下胜率不一致。
 * - CFR 的桶抽象必须按真实胜率分桶，否则桶内代表牌会严重偏差
 *   （例如最强桶的代表是 KQs 而不是 AA）。
 *
 * 运行：npx tsx scripts/generate-preflop-equity.ts
 * 输出：src/ai/data/preflop-equity.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeck, derivedRng, shuffle } from '../src/game/cards';
import { compareHands, evaluate7 } from '../src/game/handEvaluator';
import { preflopClasses } from '../src/ai/rangeModel';
import type { Card } from '../src/game/types';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src/ai/data/preflop-equity.json');
const SAMPLES = 600;

function cardKey(card: Card): string {
  return `${card.rank}${card.suit}`;
}

/** 为一个起手牌分类构造代表组合（对子 6 个、同花 4 个、非同花 12 个，最多取 6 个）。 */
function combosForClass(key: string): Array<[Card, Card]> {
  const match = /^(10|[2-9TJQKA])(10|[2-9TJQKA])([so]?)$/.exec(key);
  if (!match) throw new Error('bad key ' + key);
  const rankMap: Record<string, number> = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    '10': 10, T: 10, J: 11, Q: 12, K: 13, A: 14,
  };
  const high = rankMap[match[1]];
  const low = rankMap[match[2]];
  const suffix = match[3];
  const suits: Array<'s' | 'h' | 'd' | 'c'> = ['s', 'h', 'd', 'c'];
  const out: Array<[Card, Card]> = [];
  if (high === low) {
    for (let i = 0; i < suits.length; i++) {
      for (let j = i + 1; j < suits.length; j++) {
        out.push([{ rank: high as Card['rank'], suit: suits[i] }, { rank: low as Card['rank'], suit: suits[j] }]);
      }
    }
    return out;
  }
  if (suffix === 's') {
    for (const suit of suits) {
      out.push([{ rank: high as Card['rank'], suit }, { rank: low as Card['rank'], suit }]);
    }
    return out;
  }
  for (const a of suits) {
    for (const b of suits) {
      if (a === b) continue;
      out.push([{ rank: high as Card['rank'], suit: a }, { rank: low as Card['rank'], suit: b }]);
    }
  }
  return out;
}

function equityVsRandom(hole: [Card, Card], rng: () => number): number {
  const used = new Set([cardKey(hole[0]), cardKey(hole[1])]);
  const deck = createDeck().filter((card) => !used.has(cardKey(card)));
  let score = 0;
  for (let sample = 0; sample < SAMPLES; sample++) {
    const drawn = shuffle(deck, rng).slice(0, 7); // 对手 2 张 + 公共牌 5 张
    const board = drawn.slice(2, 7);
    const villain: [Card, Card] = [drawn[0], drawn[1]];
    const heroHand = evaluate7([hole[0], hole[1], ...board]);
    const villainHand = evaluate7([villain[0], villain[1], ...board]);
    const result = compareHands(heroHand, villainHand);
    score += result > 0 ? 1 : result === 0 ? 0.5 : 0;
  }
  return score / SAMPLES;
}

const rng = derivedRng('preflop-equity-v1');
const classes = preflopClasses();
const entries: Record<string, { equity: number; combos: number; chen: number }> = {};

for (const info of classes) {
  const combos = combosForClass(info.key);
  let total = 0;
  for (const combo of combos) total += equityVsRandom(combo, rng);
  entries[info.key] = {
    equity: Number((total / combos.length).toFixed(5)),
    combos: info.weight,
    chen: info.chen,
  };
  process.stdout.write(`\r${info.key} ${entries[info.key].equity.toFixed(3)}   `);
}

const table = {
  generatedAt: new Date().toISOString(),
  description: '169 类起手牌对随机手牌的真实胜率（蒙特卡洛，样本 ' + SAMPLES + '）',
  samples: SAMPLES,
  entries,
};
fs.writeFileSync(OUT, JSON.stringify(table, null, 1) + '\n', 'utf8');
console.log(`\nwrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
