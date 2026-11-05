/**
 * 本地 AI 模块统一出口。
 *
 * - 本地算法：难度档位、起手牌范围模型、蒙特卡洛胜率、决策入口；
 * - 本地大模型机器人：OpenAI 兼容接口调用、提示词、动作解析、对局记忆；
 * - 训练产物：learnedProfiles（自博弈调参结果）。
 *
 * 除「本地大模型机器人」会访问用户自己部署的本地模型服务外，不访问任何外部网络。
 */
export * from './aiPlayer';
export * from './difficulty';
export * from './rangeModel';
export * from './equity';
export * from './learnedProfiles';
export * from './llmBot';
export * from './llmMemory';
