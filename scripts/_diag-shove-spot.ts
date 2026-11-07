/**
 * 定点诊断：BB 面对 SB 的 100BB 全下（底池 30，需跟 980）。
 * 穷举 169 类手牌，对比「引擎估的范围」与「真实 100% 范围」下的权益和决策。
 */
import { createDeck } from '../src/game/cards';
import { evaluatePreflop } from '../src/ai/preflopEv';
import { equityVsTopRange, estimateRaiserRange } from '../src/ai/preflopCall';
import { mulberry32 } from '../src/game/cards';
import type { Card } from '../src/game/types';

const RANK_TEXT: Record<number, string> = { 10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const text = (r: number) => RANK_TEXT[r] ?? String(r);

function keyOf(a: Card, b: Card): string {
  const hi = a.rank >= b.rank ? a : b;
  const lo = a.rank >= b.rank ? b : a;
  return `${text(hi.rank)}${text(lo.rank)}${hi.suit === lo.suit ? 's' : 'o'}`;
}

const PFR = Number(process.env.PFR ?? 1.0);
const RATIO = Number(process.env.RATIO ?? 20);
const COMMIT = Number(process.env.COMMIT ?? 0.98);

const range = estimateRaiserRange({ commitFraction: COMMIT, avgPfr: PFR, raiseCount: 1, raiseToPotRatio: RATIO });
console.log(`estimateRaiserRange(pfr=${PFR}, ratio=${RATIO}, commit=${COMMIT}) = ${range.toFixed(3)}`);

const deck = createDeck();
const seen = new Set<string>();
const rows: string[] = [];
let callCount = 0, foldCount = 0;
const rng = mulberry32(12345);

for (let i = 0; i < deck.length; i++) {
  for (let j = i + 1; j < deck.length; j++) {
    const hero: [Card, Card] = [deck[i], deck[j]];
    const key = keyOf(hero[0], hero[1]);
    if (seen.has(key)) continue;
    seen.add(key);
    const ev = evaluatePreflop({
      hero,
      pot: 1030,
      callAmount: 980,
      stack: 980,
      committed: 20,
      minRaiseTo: 2000,
      maxRaiseTo: 1000,
      canCheck: false,
      canCall: true,
      canRaise: false,
      raiseTo: 0,
      raiserRange: range,
      raiseCount: 1,
      opponentCount: 1,
      foldToBet: null,
      position: 'blinds',
      allowLimp: true,
      riskPremium: 0.03,
      rng,
      samples: 400,
    });
    const trueEq = equityVsTopRange(hero, 1.0, rng, 400);
    const need = 980 / 2010;
    const best = ev.best.kind;
    if (best === 'call') callCount++; else foldCount++;
    rows.push(
      `${key.padEnd(4)} est=${(ev.equity * 100).toFixed(1)}% true=${(trueEq * 100).toFixed(1)}% ` +
      `real=${ev.realization.toFixed(2)} evCall=${(ev.options.find((o) => o.kind === 'call')?.ev ?? 0).toFixed(0)} ` +
      `-> ${best}`,
    );
  }
}

rows.sort((a, b) => {
  const ea = Number(/est=([\d.]+)/.exec(a)?.[1] ?? 0);
  const eb = Number(/est=([\d.]+)/.exec(b)?.[1] ?? 0);
  return ea - eb;
});
console.log(rows.join('\n'));
console.log(`\ncall=${callCount} fold=${foldCount} need=${((980 / 2010) * 100).toFixed(1)}%`);
