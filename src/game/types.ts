/**
 * 德州扑克核心类型定义。
 *
 * 设计原则：
 * - 规则引擎状态为纯数据（可 structuredClone / 可序列化），不包含函数。
 * - 动作、状态使用 discriminated union，配合穷尽性检查。
 * - 本文件不依赖任何 UI / AI 代码，引擎与 UI、AI 完全解耦。
 */

/** 四种花色，扑克中花色不分大小。 */
export type Suit = 's' | 'h' | 'd' | 'c';

/** 牌点：2-10 为数字，11=J，12=Q，13=K，14=A。 */
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface Card {
  readonly rank: Rank;
  readonly suit: Suit;
}

/** 四条街。showdown / complete 由 HandState.phase 表示。 */
export type Street = 'preflop' | 'flop' | 'turn' | 'river';

export type HandPhase = 'playing' | 'complete';

/**
 * 玩家在本手牌中的状态：
 * - active: 未弃牌、未全下，可以继续行动
 * - folded: 已弃牌
 * - allin: 已全下，仍可赢得底池
 * - out: 本手牌未参与（筹码为 0，已淘汰 / 旁观）
 */
export type PlayerStatus = 'active' | 'folded' | 'allin' | 'out';

/** 人机难度。 */
export type Difficulty = 'beginner' | 'normal' | 'hard' | 'expert';

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  beginner: '入门',
  normal: '普通',
  hard: '困难',
  expert: '专家',
};

export const DIFFICULTY_ORDER: Difficulty[] = ['beginner', 'normal', 'hard', 'expert'];

/** 玩家种类：人类 / 本地算法 AI / 本地大模型机器人。 */
export type PlayerKind = 'human' | 'local' | 'llm';

/** 最多支持的大模型机器人数（受 6 人桌限制：至少留 1 个本地玩家/人类）。 */
export const MAX_LLM_SEATS = 5;

/**
 * 大模型玩家配置（OpenAI 兼容接口，纯本地/外部均可）。
 * 常见服务：Ollama（http://127.0.0.1:11434/v1）、LM Studio（http://127.0.0.1:1234/v1）、
 * 或任意 OpenAI 兼容的云端接口（自行填写 Base URL 与 API Key）。
 */
export interface LlmSeatConfig {
  /** 座位序号：1..MAX_LLM_SEATS（按顺序入座）。 */
  slot: number;
  /** 显示名称（座位名 / 调试面板），用户可自由编写。 */
  name: string;
  /** 场上人物设定（自定义，可为空）：性格、说话风格、打法倾向等，会写进提示词。 */
  persona?: string;
  /** OpenAI 兼容 Base URL，例如 http://127.0.0.1:11434/v1。 */
  baseUrl: string;
  /** 模型名称，例如 qwen2.5:7b。 */
  model: string;
  /** 可选 API Key（本地服务一般留空）。 */
  apiKey?: string;
  /** 采样温度 0..2，默认 0.5。 */
  temperature?: number;
  /** 单次请求超时毫秒数，默认 60000。 */
  timeoutMs?: number;
  /** 可选：单次输出 token 上限（默认 800；模型把 token 花在“思考”上时自动放宽重试）。 */
  maxTokens?: number;
  /** 是否加入牌局（点击「新局」后生效）。 */
  enabled: boolean;
}

/** 玩家动作。下注/加注的 amount 表示“加到”的街道累计投入（raise-to），而非增量。 */
export type PlayerAction =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call' }
  | { type: 'bet'; amount: number }
  | { type: 'raise'; amount: number }
  | { type: 'allin' };

export type ActionType = PlayerAction['type'];

export interface PlayerState {
  id: number;
  name: string;
  isHuman: boolean;
  difficulty?: Difficulty;
  /** 玩家种类（人类 / 本地算法 / 大模型）。 */
  kind?: PlayerKind;
  /** 大模型机器人槽位（kind === 'llm' 时有效）。 */
  llmSlot?: number;
  /** 机器人风格原型 id（0..BOT_STYLE_COUNT-1；体验随机层使用，人类为 undefined）。 */
  styleId?: number;
  /** 身后剩余筹码。 */
  stack: number;
  /** 底牌。任意时刻都应通过 PlayerView 过滤后再交给 AI。 */
  holeCards: Card[];
  /** 本轮（street）已投入筹码。 */
  committedThisStreet: number;
  /** 本手牌累计投入筹码（用于边池）。 */
  totalCommitted: number;
  status: PlayerStatus;
  /** 本轮是否已经行动过（用于大盲 option 与轮次结束判定）。 */
  hasActedThisStreet: boolean;
  /** 是否仍有加注权（short all-in 不重开已行动玩家）。 */
  canRaise: boolean;
  /** 上次行动时的街道投入额（用于多个短全下累计重开加注权）。 */
  lastActionBet: number;
}

export type LogKind =
  | 'system'
  | 'deal'
  | 'blind'
  | 'action'
  | 'street'
  | 'board'
  | 'showdown'
  | 'pot'
  | 'refund';

export interface LogEntry {
  id: number;
  handNo: number;
  street: Street | 'showdown' | 'system';
  kind: LogKind;
  text: string;
  actorId?: number;
}

export interface ActionRecord {
  handNo: number;
  street: Street;
  actorId: number;
  actorName: string;
  action: PlayerAction;
  /** 本次动作实际投入的筹码。 */
  paid: number;
  /** 动作完成后的街道累计投入。 */
  toAmount: number;
  potAfter: number;
  stackAfter: number;
  board: Card[];
}

/** 引擎计算出的当前玩家合法动作集合，UI 与 AI 均以此为准。 */
export interface LegalActions {
  playerId: number;
  currentBet: number;
  /** 跟注需要投入的筹码（已按剩余筹码封顶）。 */
  callAmount: number;
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  /** 当前可下注（无人下注时）。 */
  canBet: boolean;
  /** 当前可加注（面对下注时）。 */
  canRaise: boolean;
  /** 是否可以全下（包括全下跟注与短全下加注）。 */
  canAllIn: boolean;
  /** 合法的最小“加到”金额（下注与加注共用）。 */
  minRaiseTo: number;
  /** 全下时的“加到”金额。 */
  maxRaiseTo: number;
  /** 当前进攻性动作类型：bet（无人下注）/ raise（面对下注）/ null。 */
  aggressiveType: 'bet' | 'raise' | null;
  raiseRights: boolean;
  /** 跟注即全下。 */
  isAllInCall: boolean;
}

export interface ShowdownEntry {
  playerId: number;
  name: string;
  holeCards: Card[];
  bestFive: Card[];
  category: number;
  categoryName: string;
  description: string;
  isWinner: boolean;
}

export interface PotPayout {
  playerId: number;
  name: string;
  amount: number;
}

export interface PotAward {
  /** 0 = 主池，1.. = 边池。 */
  index: number;
  label: string;
  amount: number;
  winnerIds: number[];
  payouts: PotPayout[];
  oddChips: number;
  oddChipTo?: number;
}

export interface HandResult {
  pots: PotAward[];
  refunds: PotPayout[];
  winners: PotPayout[];
  showdown: ShowdownEntry[] | null;
  /** 是否因其他玩家全部弃牌而直接获胜（未摊牌）。 */
  foldedWin: boolean;
}

export interface HandState {
  handNo: number;
  street: Street;
  phase: HandPhase;
  players: PlayerState[];
  buttonIndex: number;
  smallBlind: number;
  bigBlind: number;
  board: Card[];
  deck: Card[];
  burned: Card[];
  /** 当前底池总额 = 所有玩家 totalCommitted 之和（含本轮）。 */
  pot: number;
  /** 本轮最高投入额。 */
  currentBet: number;
  /** 上一次完整下注/加注的增量（最小加注增量）。 */
  lastFullRaiseSize: number;
  /** 当前行动玩家下标，null 表示本轮下注已结束。 */
  actingIndex: number | null;
  lastAggressorIndex: number | null;
  actionCount: number;
  actions: ActionRecord[];
  log: LogEntry[];
  result: HandResult | null;
}

export interface TableConfig {
  playerCount: number;
  startingStack: number;
  smallBlind: number;
  bigBlind: number;
  seed: string;
  difficulty: Difficulty;
  /** 人类玩家名称（默认“你”）。 */
  humanName?: string;
  /** 本地算法机器人名称（按入座顺序取用；不足时回退默认名）。 */
  localBotNames?: string[];
  /** 大模型机器人配置（数量受桌人数限制）。 */
  llmSeats: LlmSeatConfig[];
}

export type TablePhase = 'idle' | 'playing' | 'handOver' | 'gameOver';

export interface TablePlayer {
  id: number;
  name: string;
  isHuman: boolean;
  stack: number;
  difficulty: Difficulty;
  /** 玩家种类。 */
  kind: PlayerKind;
  /** 大模型机器人槽位。 */
  llmSlot?: number;
  /** 机器人风格原型 id。 */
  styleId?: number;
}

export interface HandHistoryPlayer {
  id: number;
  name: string;
  holeCards: Card[];
  startingStack: number;
  endingStack: number;
  status: PlayerStatus;
  kind?: PlayerKind;
  llmSlot?: number;
  styleId?: number;
}

export interface HandHistory {
  handNo: number;
  seed: string;
  buttonIndex: number;
  board: Card[];
  players: HandHistoryPlayer[];
  result: HandResult;
  actions: ActionRecord[];
  log: LogEntry[];
}

export interface TableState {
  config: TableConfig;
  players: TablePlayer[];
  buttonIndex: number;
  handNo: number;
  hand: HandState | null;
  phase: TablePhase;
  logs: LogEntry[];
  history: HandHistory[];
  message: string;
  /** 本手牌开始时各玩家的筹码，用于历史记录。 */
  handStartStacks: number[];
}

/** 默认参数：4 人桌，盲注 10/20，起始筹码 1000。 */
export const DEFAULT_CONFIG: TableConfig = {
  playerCount: 4,
  startingStack: 1000,
  smallBlind: 10,
  bigBlind: 20,
  seed: 'local-holdem',
  difficulty: 'normal',
  llmSeats: [],
};

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
