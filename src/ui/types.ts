/** 纯 UI 层类型与常量（不参与规则计算）。 */
import type { Difficulty, Street } from '../game/types';

/** AI 行动速度档位。 */
export type AiSpeed = 'fast' | 'normal' | 'slow';

export const SPEED_LABELS: Record<AiSpeed, string> = {
  fast: '快',
  normal: '正常',
  slow: '慢',
};

export const SPEED_OPTIONS: readonly AiSpeed[] = ['fast', 'normal', 'slow'];

/** AI 回合延迟（毫秒）。 */
export const SPEED_DELAYS: Record<AiSpeed, number> = {
  fast: 250,
  normal: 700,
  slow: 1300,
};

/** 设置栏中可编辑、待「新局」生效的参数（速度与调试即时生效）。 */
export interface GameSettings {
  difficulty: Difficulty;
  playerCount: number;
  seed: string;
  speed: AiSpeed;
  debugMode: boolean;
  /** 挑战模式（宗师 AI）：本地算法机器人读取下注细节 / 思考时间并强施压。 */
  challengeMode: boolean;
}

/** 大厅（phase === 'idle'）展示的当前待开局配置。 */
export interface LobbyInfo {
  playerCount: number;
  difficulty: Difficulty;
  /** 是否开启挑战宗师模式。 */
  challengeMode: boolean;
  /** 已启用的大模型机器人数量。 */
  llmCount: number;
  /** 已启用的大模型显示名称。 */
  llmNames: string[];
}

export const DEFAULT_SETTINGS: GameSettings = {
  difficulty: 'normal',
  playerCount: 4,
  seed: '',
  speed: 'normal',
  debugMode: false,
  challengeMode: false,
};

/** 调试面板中的一条 AI 决策记录。 */
export interface AiDebugRecord {
  id: number;
  handNo: number;
  street: Street;
  playerId: number;
  playerName: string;
  difficulty: Difficulty;
  actionText: string;
  equity?: number;
  potOdds?: number;
  iterations?: number;
  reasoning: string;
  profile: string;
  /** 决策来源：本地算法 / 本地大模型。 */
  source?: 'local' | 'llm';
  /** 大模型名称（source === 'llm' 时）。 */
  model?: string;
  /** 大模型调用耗时（毫秒）。 */
  latencyMs?: number;
  /** 大模型原始响应（已截断）。 */
  rawResponse?: string;
  /** 大模型调用失败后已回退本地算法。 */
  fallbackFromLlm?: boolean;
  /** 回退原因（中文）。 */
  fallbackReason?: string;
  /** 大模型玩家输出的神态/语句（开启「神态语句」时）。 */
  talk?: string;
  /** 挑战模式：计时伪装（秒打 / 长考 / 正常节奏）。 */
  timing?: string;
  /** 挑战模式：宗师原型名称。 */
  archetype?: string;
}

/** 页面顶部的提示（错误 / 信息）。 */
export interface Notice {
  id: number;
  tone: 'info' | 'error';
  text: string;
}
