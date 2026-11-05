/**
 * 河牌 endgame 求解（方案 B2，Libratus/DeepStack endgame 的轻量版）：
 * 给定河牌公共牌、我方底牌与对手范围，抽取双方范围 combo，在该单街子博弈上跑 CFR：
 * 我方（或对手）可选过牌 / 半池 / 满池下注，响应方可选弃牌 / 跟注；过牌后直接摊牌。
 * 返回我方实际底牌在均衡中的行动频率（下注频率 / 跟注频率），供挑战 AI 混合。
 * 只使用 PlayerView 公开信息（公共牌、行动/范围模型、自己的底牌）。
 */
import type { Card } from '../game/types';
import type { PlayerView } from '../game/playerView';
import { createDeck, derivedRng, shuffle } from '../game/cards';
import { compareHands, evaluate7 } from '../game/handEvaluator';
import { madeHandStrength } from './rangeModel';
import { buildChallengeRanges } from './challenge';

export interface RiverSolverResult {
  mode: 'bet' | 'call';
  /** 我方 combo 在均衡中的行动频率。 */
  frequencies: Record<string, number>;
  iterations: number;
  heroCombos: number;
  villainCombos: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function regretMatching(regrets: readonly number[]): number[] {
  const positive = regrets.map((value) => Math.max(0, value));
  const sum = positive.reduce((total, value) => total + value, 0);
  if (sum <= 1e-12) return positive.map(() => 1 / positive.length);
  return positive.map((value) => value / sum);
}

function cardsKey(card: Card): string {
  return `${card.rank}${card.suit}`;
}

/** 从可用牌中枚举/采样 combo。 */
function combosFrom(deck: readonly Card[], limit: number): Array<[Card, Card]> {
  const result: Array<[Card, Card]> = [];
  for (let i = 0; i < deck.length && result.length < limit; i++) {
    for (let j = i + 1; j < deck.length && result.length < limit; j++) {
      result.push([deck[i], deck[j]]);
    }
  }
  return result;
}

function showdownSign(hero: readonly [Card, Card], villain: readonly [Card, Card], board: readonly Card[]): number {
  const result = compareHands(
    evaluate7([hero[0], hero[1], ...board]),
    evaluate7([villain[0], villain[1], ...board]),
  );
  return result > 0 ? 1 : result < 0 ? -1 : 0;
}

/**
 * 求解河牌单街子博弈。
 * @param mode bet = 我方先行动（过牌/下注）；call = 对手先行动，我方面对下注（弃牌/跟注）。
 */
export function solveRiverEndgame(
  view: PlayerView,
  options: { mode?: 'bet' | 'call'; iterations?: number; maxCombos?: number } = {},
): RiverSolverResult | null {
  if (view.board.length !== 5) return null;
  const mode = options.mode ?? 'bet';
  const iterations = Math.max(50, Math.floor(options.iterations ?? 400));
  const maxCombos = Math.max(6, Math.floor(options.maxCombos ?? 16));
  const board = view.board;
  const heroHole = view.self.holeCards as [Card, Card];
  if (heroHole.length !== 2) return null;
  const used = new Set([...board.map(cardsKey), ...heroHole.map(cardsKey)]);
  const deck = createDeck().filter((card) => !used.has(cardsKey(card)));
  const rng = derivedRng('river-endgame', view.seed, view.actions.length, mode === 'bet' ? 1 : 2);

  // 我方范围：与当前底牌「河牌强度」接近的 combo（含自己），保证有类似牌力的混合组合。
  const heroStrength = madeHandStrength(view.self.holeCards, board);
  const heroCandidates = combosFrom(deck, 120);
  const heroRange = [...heroCandidates].sort(
    (a, b) =>
      Math.abs(madeHandStrength(a, board) - heroStrength) -
      Math.abs(madeHandStrength(b, board) - heroStrength),
  );
  const heroCombos = heroRange.slice(0, maxCombos);
  // 对手范围：用挑战模式的公开范围模型做拒绝采样，取前 maxCombos 个。
  const rangeMap = buildChallengeRanges(view);
  const opponentId = view.players.find(
    (player) => player.id !== view.viewerId && (player.status === 'active' || player.status === 'allin'),
  )?.id;
  const rangeWeight = opponentId !== undefined ? rangeMap.get(opponentId) : undefined;
  const villainPool = shuffle(deck, rng).slice(0, 120);
  const villainCombos: Array<[Card, Card]> = [];
  for (const combo of combosFrom(villainPool, 160)) {
    if (villainCombos.length >= maxCombos) break;
    const weight = rangeWeight ? rangeWeight(combo[0], combo[1]) : 0.5;
    if (weight > 0.08 || rng() < 0.05) villainCombos.push(combo);
  }
  if (villainCombos.length === 0 || heroCombos.length === 0) return null;

  const pot = Math.max(1, view.pot);
  const betSizes = [0.5, 1];
  // 摊牌结果矩阵：1 = 我方赢，-1 = 输，0 = 平。
  const signs = heroCombos.map((hero) => villainCombos.map((villain) => showdownSign(hero, villain, board)));
  const equityOf = (heroIndex: number): number =>
    (signs[heroIndex].reduce((sum, sign) => sum + (sign > 0 ? 1 : sign === 0 ? 0.5 : 0), 0) /
      villainCombos.length) || 0.5;

  // CFR：行为策略按 info set（combo）维护。我方动作 [check, bet0.5, bet1]；对手 [fold, call]。
  const heroRegret = heroCombos.map(() => [0, 0, 0]);
  const heroSum = heroCombos.map(() => [0, 0, 0]);
  const villainRegret = villainCombos.map(() => [0, 0]);
  const villainSum = villainCombos.map(() => [0, 0]);

  for (let iteration = 1; iteration <= iterations; iteration++) {
    const heroStrategy = heroRegret.map((regrets) => regretMatching(regrets));
    const villainStrategy = villainRegret.map((regrets) => regretMatching(regrets));
    for (let heroIndex = 0; heroIndex < heroCombos.length; heroIndex++) {
      const signRow = signs[heroIndex];
      const heroActions = [0, 0, 0]; // check / bet0.5 / bet1 的 EV（对我方）
      // check：直接摊牌。
      heroActions[0] = equityOf(heroIndex) * pot;
      for (let sizeIndex = 0; sizeIndex < betSizes.length; sizeIndex++) {
        const bet = pot * betSizes[sizeIndex];
        let ev = 0;
        for (let villainIndex = 0; villainIndex < villainCombos.length; villainIndex++) {
          const call = villainStrategy[villainIndex][1];
          const win = signRow[villainIndex] > 0 ? 1 : signRow[villainIndex] === 0 ? 0.5 : 0;
          const showdownEv = win * (pot + 2 * bet) - bet;
          ev += call * showdownEv + (1 - call) * pot;
        }
        heroActions[sizeIndex + 1] = ev / villainCombos.length;
      }
      const heroEv = heroStrategy[heroIndex].reduce((sum, probability, action) => sum + probability * heroActions[action], 0);
      for (let action = 0; action < 3; action++) {
        heroRegret[heroIndex][action] = Math.max(0, heroRegret[heroIndex][action] + (heroActions[action] - heroEv));
        heroSum[heroIndex][action] += heroStrategy[heroIndex][action];
      }
    }
    for (let villainIndex = 0; villainIndex < villainCombos.length; villainIndex++) {
      const foldEv = 0;
      let callEv = 0;
      let weight = 0;
      for (let heroIndex = 0; heroIndex < heroCombos.length; heroIndex++) {
        const betProbability = heroStrategy[heroIndex][1] + heroStrategy[heroIndex][2];
        weight += betProbability;
        const sign = signs[heroIndex][villainIndex];
        const win = sign < 0 ? 1 : sign === 0 ? 0.5 : 0; // 对手视角
        const bet = pot * 0.5;
        callEv += betProbability * (win * (pot + 2 * bet) - bet);
      }
      callEv = weight > 0 ? callEv / weight : -pot * 0.25;
      const villainValue = villainStrategy[villainIndex][0] * foldEv + villainStrategy[villainIndex][1] * callEv;
      villainRegret[villainIndex][0] = Math.max(0, villainRegret[villainIndex][0] + (foldEv - villainValue));
      villainRegret[villainIndex][1] = Math.max(0, villainRegret[villainIndex][1] + (callEv - villainValue));
      villainSum[villainIndex][0] += iteration * villainStrategy[villainIndex][0];
      villainSum[villainIndex][1] += iteration * villainStrategy[villainIndex][1];
    }
  }

  const heroAverage = heroSum.map((sums) => {
    const total = sums.reduce((sum, value) => sum + value, 0);
    return total > 0 ? sums.map((value) => value / total) : [1 / 3, 1 / 3, 1 / 3];
  });
  const actualHeroIndex = heroCombos.findIndex(
    (combo) => (combo[0].rank === heroHole[0].rank && combo[0].suit === heroHole[0].suit && combo[1].rank === heroHole[1].rank && combo[1].suit === heroHole[1].suit) ||
      (combo[1].rank === heroHole[0].rank && combo[1].suit === heroHole[0].suit && combo[0].rank === heroHole[1].rank && combo[0].suit === heroHole[1].suit),
  );
  const strategy = heroAverage[actualHeroIndex >= 0 ? actualHeroIndex : 0] ?? [1 / 3, 1 / 3, 1 / 3];
  if (mode === 'bet') {
    return {
      mode,
      frequencies: {
        check: clamp01(strategy[0]),
        betHalf: clamp01(strategy[1]),
        betPot: clamp01(strategy[2]),
      },
      iterations,
      heroCombos: heroCombos.length,
      villainCombos: villainCombos.length,
    };
  }
  // 面对下注：用对手（先行动方）的平均跟注频率作为我方跟注参考（简化镜像）。
  const callFrequency =
    villainSum.reduce((sum, sums) => sum + sums[1], 0) /
    Math.max(1, villainSum.reduce((sum, sums) => sum + sums[0] + sums[1], 0));
  return {
    mode,
    frequencies: { call: clamp01(callFrequency), fold: clamp01(1 - callFrequency) },
    iterations,
    heroCombos: heroCombos.length,
    villainCombos: villainCombos.length,
  };
}
