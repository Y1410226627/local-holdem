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

// 1) 全难度降低随机失误 / 乱诈唬（提高下限）
patch('D:/德州扑克/src/ai/difficulty.ts', [
  ['      trapRate: 0,\n      errorRate: 0.03,', '      trapRate: 0,\n      errorRate: 0.015,'],
  ['      betSizes: [0.33],\n      raiseSizes: [0.33],\n      errorRate: 0.06,', '      betSizes: [0.33],\n      raiseSizes: [0.33],\n      errorRate: 0.03,'],
  ['      mixRaiseRate: 0.1,\n      trapRate: 0.04,\n      errorRate: 0.02,', '      mixRaiseRate: 0.1,\n      trapRate: 0.04,\n      errorRate: 0.01,'],
  ['      betSizes: [0.5],\n      raiseSizes: [0.5],\n      errorRate: 0.02,', '      betSizes: [0.5],\n      raiseSizes: [0.5],\n      errorRate: 0.01,'],
  ['      mixRaiseRate: 0.18,\n      trapRate: 0.06,\n      errorRate: 0.01,', '      mixRaiseRate: 0.18,\n      trapRate: 0.06,\n      errorRate: 0.005,'],
  ['      betSizes: [0.5, 2 / 3, 1],\n      raiseSizes: [0.5, 2 / 3, 1],\n      errorRate: 0.01,', '      betSizes: [0.5, 2 / 3, 1],\n      raiseSizes: [0.5, 2 / 3, 1],\n      errorRate: 0.005,'],
  ['      mixRaiseRate: 0.3,\n      trapRate: 0.1,\n      errorRate: 0.005,', '      mixRaiseRate: 0.3,\n      trapRate: 0.1,\n      errorRate: 0.002,'],
  ['      betSizes: [0.5, 2 / 3, 1, 1.3],\n      raiseSizes: [0.5, 2 / 3, 1, 1.3],\n      errorRate: 0.005,', '      betSizes: [0.5, 2 / 3, 1, 1.3],\n      raiseSizes: [0.5, 2 / 3, 1, 1.3],\n      errorRate: 0.002,'],
]);

patch('D:/德州扑克/src/ai/humanModel.ts', [
  ['  beginner: 0.22,\n  normal: 0.1,\n  hard: 0.04,\n  expert: 0.01,', '  beginner: 0.15,\n  normal: 0.07,\n  hard: 0.025,\n  expert: 0.005,'],
]);

// 2) 挑战 AI：关闭随机失误 + 对“跟注站”停止诈唬（只做价值）
patch('D:/德州扑克/src/ai/aiPlayer.ts', [
  [
    '  /**\n   * 挑战模式（宗师 AI）：使用挑战档 profile + 宗师原型 + 读下注细节 / 思考时间。\n   * 训练 / 对照评估时忽略（profileOverride 优先）。\n   */\n  challenge?: boolean;',
    '  /**\n   * 挑战模式（宗师 AI）：使用挑战档 profile + 宗师原型 + 读下注细节 / 思考时间。\n   * 训练 / 对照评估时忽略（profileOverride 优先）。\n   */\n  challenge?: boolean;\n  /** 关闭所有随机失误层（挑战基线使用）。 */\n  noMistakes?: boolean;',
  ],
  [
    '  if (!isPreflop && !options.profileOverride && !challenge) {',
    '  if (!isPreflop && !options.profileOverride && !challenge && !options.noMistakes) {',
  ],
  [
    `    expertDecision: AIDecision,
  opponents: OpponentSummary,
): AIDecision {
  void view; void legal; void opponents;`,
    `    expertDecision: AIDecision,
  opponents: OpponentSummary,
): AIDecision {
  void view; void legal;
  // 对“跟注站 / 松被动”对手：放弃纯诈唬，只做价值与控池。
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
  }`,
  ],
  [
    `  return {
    action: expertDecision.action,
    timingHint: challengeDecision.timingHint ?? expertDecision.timingHint,`,
    `  return {
    action: finalAction,
    timingHint: challengeDecision.timingHint ?? expertDecision.timingHint,`,
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
