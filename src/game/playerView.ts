/**
 * 玩家视角（PlayerView）：
 *
 * 人机 / 任意玩家只能通过本模块构造的受限视图获取信息：
 * - 自己的底牌；
 * - 公共牌、底池、当前下注额、位置、行动历史、公开日志；
 * - 其他玩家的公开信息（筹码、状态、下注额），**绝不含对手底牌**。
 *
 * AI 接口只接受 PlayerView，从类型层面杜绝人机读取对手底牌。
 */
import type {
  PublicPlayerStats,
  ActionRecord,
  Card,
  Difficulty,
  HandState,
  LegalActions,
  LogKind,
  PlayerKind,
  PlayerStatus,
  Street,
} from './types';
import { getLegalActions } from './betting';
import { hashString } from './cards';

export interface PublicPlayerView {
  id: number;
  name: string;
  isHuman: boolean;
  difficulty?: Difficulty;
  /** 玩家种类（人类 / 本地算法 / 大模型）。 */
  kind?: PlayerKind;
  /** 大模型机器人槽位。 */
  llmSlot?: number;
  /** 机器人风格原型 id（0..5）；人类无。 */
  styleId?: number;
  /** 跨手公开行为统计（只由公开动作推导）。 */
  stats?: PublicPlayerStats;
  stack: number;
  committedThisStreet: number;
  totalCommitted: number;
  status: PlayerStatus;
  hasActedThisStreet: boolean;
}

export interface SelfPlayerView extends PublicPlayerView {
  holeCards: Card[];
  canRaise: boolean;
  /** 当前情绪（-2 上头 .. +2 自信，0 平稳）：只有自己知道。 */
  mood?: number;
}

export interface PlayerLogView {
  id: number;
  street: string;
  kind: LogKind;
  text: string;
}

export interface PlayerView {
  viewerId: number;
  handNo: number;
  street: Street;
  board: Card[];
  pot: number;
  currentBet: number;
  lastFullRaiseSize: number;
  smallBlind: number;
  bigBlind: number;
  buttonIndex: number;
  players: PublicPlayerView[];
  self: SelfPlayerView;
  /** 仅当轮到该玩家行动时非 null。 */
  legal: LegalActions | null;
  actions: ActionRecord[];
  log: PlayerLogView[];
  actingIndex: number | null;
  /** 派生自种子，供 AI 的蒙特卡洛 / 随机化使用（确定性）。 */
  seed: number;
}

/** 构造指定玩家的受限视图。 */
export function buildPlayerView(hand: HandState, viewerId: number, seed: string): PlayerView {
  const viewerIndex = hand.players.findIndex((player) => player.id === viewerId);
  if (viewerIndex < 0) throw new Error(`找不到玩家：${viewerId}`);
  const viewer = hand.players[viewerIndex];

  const publicPlayers: PublicPlayerView[] = hand.players.map((player) => ({
    id: player.id,
    name: player.name,
    isHuman: player.isHuman,
    difficulty: player.difficulty,
    kind: player.kind,
    llmSlot: player.llmSlot,
    styleId: player.styleId,
    stats: player.stats,
    stack: player.stack,
    committedThisStreet: player.committedThisStreet,
    totalCommitted: player.totalCommitted,
    status: player.status,
    hasActedThisStreet: player.hasActedThisStreet,
  }));

  let legal: LegalActions | null = null;
  if (hand.phase === 'playing' && hand.actingIndex === viewerIndex) {
    legal = getLegalActions(hand, viewerIndex);
  }

  // 过滤掉摊牌类日志：摊牌日志包含所有玩家底牌，不能进入 AI 视图。
  const log: PlayerLogView[] = hand.log
    .filter((entry) => entry.kind !== 'showdown')
    .map((entry) => ({
      id: entry.id,
      street: entry.street,
      kind: entry.kind,
      text: entry.text,
    }));

  return {
    viewerId,
    handNo: hand.handNo,
    street: hand.street,
    board: hand.board.map((card) => ({ ...card })),
    pot: hand.pot,
    currentBet: hand.currentBet,
    lastFullRaiseSize: hand.lastFullRaiseSize,
    smallBlind: hand.smallBlind,
    bigBlind: hand.bigBlind,
    buttonIndex: hand.buttonIndex,
    players: publicPlayers,
    self: {
      ...publicPlayers[viewerIndex],
      holeCards: viewer.holeCards.map((card) => ({ ...card })),
      canRaise: viewer.canRaise,
      mood: viewer.mood,
    },
    legal,
    actions: hand.actions.map((record) => ({
      ...record,
      action: { ...record.action },
      board: record.board.map((card) => ({ ...card })),
    })),
    log,
    actingIndex: hand.actingIndex,
    seed: hashString(`${seed}#hand-${hand.handNo}#player-${viewerId}`),
  };
}
