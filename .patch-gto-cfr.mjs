import fs from 'node:fs';

const path = 'D:/德州扑克/src/ai/gto.ts';
let src = fs.readFileSync(path, 'utf8');

function rep(oldText, newText) {
  const count = src.split(oldText).length - 1;
  if (count !== 1) throw new Error('count=' + count + '\n' + oldText.slice(0, 240));
  src = src.replace(oldText, () => newText);
}

rep(
`  for (let iteration = 0; iteration < iterations; iteration++) {
    for (let i = 0; i < buckets; i++) {
      const sbStrategy = regretMatching(sbRegret[i]);
      for (let j = 0; j < buckets; j++) {
        const bbStrategy = regretMatching(bbRegret[j]);
        const callPayoff = stackBB * (2 * equity[i][j] - 1); // SB 全下被跟注后的收益
        const evFold = -0.5;
        const evPush = bbStrategy[1] * callPayoff + bbStrategy[0] * 1;
        const sbEv = [evFold, evPush];
        const sbEvSum = sbStrategy[0] * sbEv[0] + sbStrategy[1] * sbEv[1];
        for (let action = 0; action < 2; action++) {
          sbRegret[i][action] += sbEv[action] - sbEvSum;
          sbStrategySum[i][action] += sbStrategy[action];
        }
        const bbEv = [-1, -callPayoff];
        const bbEvSum = bbStrategy[0] * bbEv[0] + bbStrategy[1] * bbEv[1];
        const reach = sbStrategy[1];
        for (let action = 0; action < 2; action++) {
          bbRegret[j][action] += reach * (bbEv[action] - bbEvSum);
          bbStrategySum[j][action] += reach * bbStrategy[action];
        }
      }
    }
  }`,
`  // CFR+：遗憾值裁剪到 0、线性加权平均、SB / BB 交替更新。
  for (let iteration = 1; iteration <= iterations; iteration++) {
    const weight = iteration;
    const sbStrategies: number[][] = [];
    const bbStrategies: number[][] = [];
    for (let i = 0; i < buckets; i++) {
      sbStrategies.push(regretMatching(sbRegret[i]));
      bbStrategies.push(regretMatching(bbRegret[i]));
    }
    // SB 更新：对每个桶 i，对手桶 j 等概率，BB 采用当前平均策略。
    for (let i = 0; i < buckets; i++) {
      const sbStrategy = sbStrategies[i];
      const evFold = -0.5;
      let evPush = 0;
      for (let j = 0; j < buckets; j++) {
        const callPayoff = stackBB * (2 * equity[i][j] - 1);
        const bbStrategy = bbStrategies[j];
        evPush += bbStrategy[1] * callPayoff + bbStrategy[0] * 1;
      }
      evPush /= buckets;
      const sbEv = [evFold, evPush];
      const sbEvSum = sbStrategy[0] * sbEv[0] + sbStrategy[1] * sbEv[1];
      for (let action = 0; action < 2; action++) {
        sbRegret[i][action] = Math.max(0, sbRegret[i][action] + sbEv[action] - sbEvSum);
        sbStrategySum[i][action] += weight * sbStrategy[action];
      }
    }
    // BB 更新：对每个桶 j，SB 桶 i 等概率，SB 采用当前平均策略的 push 概率。
    for (let j = 0; j < buckets; j++) {
      const bbStrategy = bbStrategies[j];
      const evFold = -1;
      let evCall = 0;
      for (let i = 0; i < buckets; i++) {
        const callPayoff = stackBB * (2 * equity[i][j] - 1);
        const sbStrategy = sbStrategies[i];
        evFold += 0; // 折叠收益对 i 不敏感，下面直接按到达概率算
        evCall += sbStrategy[1] * -callPayoff;
      }
      // BB 面对 SB 全下（到达概率 = 平均 push 频率）的两种选择。
      let sbPushWeight = 0;
      for (let i = 0; i < buckets; i++) sbPushWeight += sbStrategies[i][1];
      sbPushWeight /= buckets;
      const evFoldValue = sbPushWeight * -1 + (1 - sbPushWeight) * 0.5;
      const evCallValue = (evCall / buckets) + (1 - sbPushWeight) * 0.5;
      const bbEv = [evFoldValue, evCallValue];
      const bbEvSum = bbStrategy[0] * bbEv[0] + bbStrategy[1] * bbEv[1];
      const reach = sbPushWeight;
      for (let action = 0; action < 2; action++) {
        bbRegret[j][action] = Math.max(0, bbRegret[j][action] + reach * (bbEv[action] - bbEvSum));
        bbStrategySum[j][action] += weight * reach * bbStrategy[action];
      }
    }
  }`,
);

fs.writeFileSync(path, src, 'utf8');
console.log('patched gto.ts CFR+ OK');
