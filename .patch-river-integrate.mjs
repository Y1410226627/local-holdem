import fs from 'node:fs';

const path = 'D:/德州扑克/src/ai/aiPlayer.ts';
let src = fs.readFileSync(path, 'utf8');
function rep(oldText, newText) {
  const count = src.split(oldText).length - 1;
  if (count !== 1) throw new Error('count=' + count + '\n' + oldText.slice(0, 200));
  src = src.replace(oldText, () => newText);
}

rep(
  "import { depthLimitedSearch, estimateActionEv } from './search';",
  "import { depthLimitedSearch, estimateActionEv } from './search';\nimport { solveRiverEndgame } from './riverSolver';",
);

rep(
  `  // 体验随机：风格触发的合法小幅变化（尺度 / 慢玩 / 边缘牌随机化）；挑战模式用自身随机化。
  if (!isPreflop && !challenge) {`,
  `  // B2：河牌子博弈求解（Libratus/DeepStack endgame 轻量版）：按均衡频率混合下注 / 跟注。
  if (challenge && !isPreflop && view.street === 'river' && ctx.closeness >= 0.5) {
    const solver = solveRiverEndgame(view, {
      mode: legal.canCheck ? 'bet' : 'call',
      iterations: 160,
      maxCombos: 8,
    });
    if (solver && rng() < ctx.closeness) {
      if (solver.mode === 'bet' && legal.canCheck) {
        const betHalf = solver.frequencies.betHalf ?? 0;
        const betPot = solver.frequencies.betPot ?? 0;
        const roll = rng();
        const fraction = roll < betHalf ? 0.5 : roll < betHalf + betPot ? 1 : null;
        if (fraction !== null && legal.aggressiveType) {
          const bet = buildAggressive(legal, targetFromFraction(view, legal, fraction)) as PlayerAction | null;
          if (bet) {
            action = bet;
            reasoning = reasoning + \`（河牌子博弈求解：${Math.round((fraction === 0.5 ? betHalf : betPot) * 100)}% 下注频率）\`;
          }
        } else if (fraction === null && legal.canCheck) {
          action = { type: 'check' };
          reasoning = reasoning + \`（河牌子博弈求解：过牌频率 ${Math.round((solver.frequencies.check ?? 0) * 100)}%）\`;
        }
      } else if (legal.canCall) {
        const callFrequency = solver.frequencies.call ?? 0.5;
        if (rng() < callFrequency) {
          action = { type: 'call' };
          reasoning = reasoning + \`（河牌子博弈求解：跟注频率 ${Math.round(callFrequency * 100)}%）\`;
        } else if (legal.canFold) {
          action = { type: 'fold' };
          reasoning = reasoning + \`（河牌子博弈求解：弃牌频率 ${Math.round((1 - callFrequency) * 100)}%）\`;
        }
      }
    }
  }

  // 体验随机：风格触发的合法小幅变化（尺度 / 慢玩 / 边缘牌随机化）；挑战模式用自身随机化。
  if (!isPreflop && !challenge) {`,
);

fs.writeFileSync(path, src, 'utf8');
console.log('patched aiPlayer river endgame OK');
