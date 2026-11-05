import fs from 'node:fs';
function patch(path, pairs) {
  let src = fs.readFileSync(path, 'utf8');
  for (const [oldText, newText] of pairs) {
    const count = src.split(oldText).length - 1;
    if (count !== 1) throw new Error(path + ' count=' + count + '\n' + oldText.slice(0, 160));
    src = src.replace(oldText, () => newText);
  }
  fs.writeFileSync(path, src, 'utf8');
  console.log('patched ' + path);
}

patch('D:/德州扑克/src/ai/aiPlayer.ts', [
  [
    `  challenge?: boolean;
}`,
    `  challenge?: boolean;
  /** 关闭随机失误层（挑战专家基准用）。 */
  noMistakes?: boolean;
}`,
  ],
  [
    `  if (!isPreflop && !options.profileOverride && !challenge) {`,
    `  if (!isPreflop && !options.profileOverride && !challenge && !options.noMistakes) {`,
  ],
  [
    `): AIDecision {
  void view; void legal; void opponents;
  // 10k 配对基准显示：实验性挑战策略在默认参数下弱于专家线。
  // 因此动作以专家基准为准（保证不弱于专家档），挑战读人 / 计时 / 原型信息保留在调试展示。
  return {
    action: expertDecision.action,`,
    `): AIDecision {
  void legal;
  // 动作以专家基准为准（保证不弱于专家档）；对“跟注站 / 松被动”对手关闭纯诈唬。
  let finalAction = expertDecision.action;
  let exploitNote = '';
  const aggressive =
    finalAction.type === 'bet' || finalAction.type === 'raise' || finalAction.type === 'allin';
  const station = (opponents.avgVpip ?? 0) > 0.52 && (opponents.avgFoldToBet ?? 1) < 0.35;
  const equity = expertDecision.debug.equity ?? challengeDecision.debug.equity ?? 0.5;
  if (aggressive && station && equity < 0.58) {
    if (view.legal?.canCheck) {
      finalAction = { type: 'check' };
      exploitNote = '（对手跟注过多：放弃诈唬，过牌控池）';
    } else if (view.legal?.canCall) {
      finalAction = { type: 'call' };
      exploitNote = '（对手跟注过多：放弃诈唬加注，跟注控池）';
    }
  }
  return {
    action: finalAction,`,
  ],
  [
    `      reasoning: '挑战（专家基准动作）：' + expertDecision.debug.reasoning + '｜挑战分析：' + challengeDecision.debug.reasoning,`,
    `      reasoning: '挑战（专家基准动作）：' + expertDecision.debug.reasoning + exploitNote + '｜挑战分析：' + challengeDecision.debug.reasoning,`,
  ],
  [
    `  const expertDecision = await decideCore(view, difficulty, {
    ...options,
    challenge: false,
    maxIterations: options.maxIterations ?? 6000,
  });`,
    `  const expertDecision = await decideCore(view, difficulty, {
    ...options,
    challenge: false,
    noMistakes: true,
    maxIterations: options.maxIterations ?? 6000,
  });`,
  ],
]);
