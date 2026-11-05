/**
 * 会话状态机：管理一桌多手牌（筹码持久化、按钮轮转、难度、历史记录、重开）。
 */
import type {
  Difficulty,
  HandHistory,
  LegalActions,
  PlayerAction,
  TableConfig,
  TablePlayer,
  TableState,
} from './types';
import {
  DEFAULT_CONFIG,
  MAX_LLM_SEATS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  type PlayerStatsRaw,
  type PublicPlayerStats,
} from './types';
import { assignBotStyleIds } from './cards';
import { IllegalActionError, createHand, getLegalActions, playAction } from './gameEngine';

export const BOT_NAMES = ['阿豪', '小雅', '老陈', '莉莉', '大鹏'];

export const DEFAULT_BOT_NAMES = BOT_NAMES;

/** 空的原始统计。 */
export function createEmptyStatsRaw(): PlayerStatsRaw {
  return {
    hands: 0,
    vpip: 0,
    pfr: 0,
    bets: 0,
    raises: 0,
    calls: 0,
    folds: 0,
    facedBet: 0,
    foldedToBet: 0,
    netChips: 0,
  };
}

/** 原始统计 → 公开统计（样本不足时返回 undefined）。 */
export function toPublicStats(raw: PlayerStatsRaw | undefined): PublicPlayerStats | undefined {
  if (!raw || raw.hands <= 0) return undefined;
  return {
    hands: raw.hands,
    vpipRate: raw.vpip / raw.hands,
    pfrRate: raw.pfr / raw.hands,
    aggression: Math.min(5, (raw.bets + raw.raises) / Math.max(1, raw.calls)),
    foldToBetRate: raw.facedBet > 0 ? raw.foldedToBet / raw.facedBet : null,
    netChips: raw.netChips,
  };
}

/** 本手结束后更新每个玩家的跨手统计与情绪（只由公开动作 / 收支推导）。 */
function updateSessionStats(table: TableState): void {
  const hand = table.hand;
  if (!hand) return;
  const raws = new Map<number, PlayerStatsRaw>();
  for (const player of table.players) {
    raws.set(player.id, player.statsRaw ? { ...player.statsRaw } : createEmptyStatsRaw());
  }

  let street = '';
  let streetBet = 0;
  // VPIP / PFR 按「手」计一次：同一手翻牌前的多次跟注 / 加注不重复累计。
  const vpipMark = new Set<number>();
  const pfrMark = new Set<number>();
  for (const record of hand.actions) {
    if (record.street !== street) {
      street = record.street;
      streetBet = 0;
    }
    const raw = raws.get(record.actorId);
    if (!raw) continue;
    const action = record.action;
    if (street === 'preflop') {
      const vpipAction =
        action.type === 'call' || action.type === 'bet' || action.type === 'raise' || action.type === 'allin';
      const raiseAction = action.type === 'bet' || action.type === 'raise' || action.type === 'allin';
      if (vpipAction && !vpipMark.has(record.actorId)) {
        raw.vpip += 1;
        vpipMark.add(record.actorId);
      }
      if (raiseAction && !pfrMark.has(record.actorId)) {
        raw.pfr += 1;
        pfrMark.add(record.actorId);
      }
    }
    if (action.type === 'bet') raw.bets += 1;
    else if (action.type === 'raise') raw.raises += 1;
    else if (action.type === 'call') raw.calls += 1;
    else if (action.type === 'fold') raw.folds += 1;

    const facing = streetBet > 0 && (action.type === 'fold' || action.type === 'call' || action.type === 'raise' || action.type === 'allin');
    if (facing) {
      raw.facedBet += 1;
      if (action.type === 'fold') raw.foldedToBet += 1;
    }
    if (action.type === 'bet' || action.type === 'raise' || action.type === 'allin') {
      streetBet = Math.max(streetBet, record.toAmount);
    }
  }

  for (const player of table.players) {
    const handPlayer = hand.players.find((item) => item.id === player.id);
    if (!handPlayer || handPlayer.status === 'out') continue;
    const raw = raws.get(player.id);
    if (!raw) continue;
    raw.hands += 1;
    const starting = table.handStartStacks[player.id] ?? player.stack;
    const net = player.stack - starting;
    raw.netChips += net;
    player.statsRaw = raw;
    const delta = Math.max(-1.5, Math.min(1.5, net / Math.max(1, table.config.bigBlind * 5)));
    const previous = player.mood ?? 0;
    player.mood = Math.max(-2, Math.min(2, previous * 0.6 + delta));
  }
}


export function validateTableConfig(config: TableConfig): void {
  if (!Number.isInteger(config.playerCount) || config.playerCount < MIN_PLAYERS || config.playerCount > MAX_PLAYERS) {
    throw new Error(`玩家人数必须是 ${MIN_PLAYERS}-${MAX_PLAYERS} 的整数`);
  }
  if (!Number.isInteger(config.startingStack) || config.startingStack <= 0) {
    throw new Error('起始筹码必须为正整数');
  }
  if (!Number.isInteger(config.smallBlind) || config.smallBlind <= 0) {
    throw new Error('小盲必须为正整数');
  }
  if (!Number.isInteger(config.bigBlind) || config.bigBlind <= 0) {
    throw new Error('大盲必须为正整数');
  }
  if (config.smallBlind >= config.bigBlind) {
    throw new Error('小盲必须小于大盲');
  }
  if (config.startingStack < config.bigBlind) {
    throw new Error('起始筹码不能小于大盲');
  }
  if (typeof config.seed !== 'string' || config.seed.length === 0) {
    throw new Error('随机种子不能为空');
  }
  const llmSeats = config.llmSeats ?? [];
  if (!Array.isArray(llmSeats) || llmSeats.length > MAX_LLM_SEATS) {
    throw new Error(`最多支持 ${MAX_LLM_SEATS} 个大模型机器人`);
  }
  const slots = new Set<number>();
  let enabledLlmCount = 0;
  for (const seat of llmSeats) {
    if (!Number.isInteger(seat.slot) || seat.slot < 1 || seat.slot > MAX_LLM_SEATS) {
      throw new Error(`大模型机器人座位号必须为 1-${MAX_LLM_SEATS} 的整数`);
    }
    if (slots.has(seat.slot)) {
      throw new Error(`大模型机器人座位号重复：${seat.slot}`);
    }
    slots.add(seat.slot);
    if (!seat.enabled) continue;
    enabledLlmCount += 1;
    if (!seat.baseUrl || !seat.baseUrl.trim()) {
      throw new Error(`大模型「${seat.name?.trim() || `#${seat.slot}`}」的 Base URL 不能为空`);
    }
    if (!seat.model || !seat.model.trim()) {
      throw new Error(`大模型「${seat.name?.trim() || `#${seat.slot}`}」的模型名称不能为空`);
    }
  }
  if (enabledLlmCount > config.playerCount - 1) {
    throw new Error(
      `当前 ${config.playerCount} 人桌放不下 ${enabledLlmCount} 个大模型机器人，请增加人数或关闭一些大模型`,
    );
  }
}

/** 创建一桌游戏（phase='idle'，需调用 startNextHand 开始第一手）。 */
export function createTable(overrides: Partial<TableConfig> = {}): TableState {
  const config: TableConfig = { ...DEFAULT_CONFIG, ...overrides };
  config.llmSeats = (config.llmSeats ?? []).map((seat) => ({ ...seat }));
  validateTableConfig(config);

  const humanName = config.humanName?.trim() || '你';
  const players: TablePlayer[] = [
    {
      id: 0,
      name: humanName,
      isHuman: true,
      stack: config.startingStack,
      difficulty: config.difficulty,
      kind: 'human',
    },
  ];

  // 加入牌局的本地大模型机器人（按座位号顺序入座）。
  const enabledLlmSeats = config.llmSeats
    .filter((seat) => seat.enabled)
    .sort((a, b) => a.slot - b.slot);
  for (const seat of enabledLlmSeats) {
    players.push({
      id: players.length,
      name: seat.name?.trim() || `大模型#${seat.slot}`,
      isHuman: false,
      stack: config.startingStack,
      difficulty: config.difficulty,
      kind: 'llm',
      llmSlot: seat.slot,
    });
  }

  // 剩余座位由本地算法机器人补齐，名称可由配置自由指定。
  const localBotCount = config.playerCount - players.length;
  for (let i = 0; i < localBotCount; i++) {
    const customName = config.localBotNames?.[i]?.trim();
    players.push({
      id: players.length,
      name: customName || BOT_NAMES[i] || `机器人${i + 1}`,
      isHuman: false,
      stack: config.startingStack,
      difficulty: config.difficulty,
      kind: 'local',
    });
  }

  // 给所有机器人分配「风格原型」：每个新局由 seed 打乱，体验随机但可复现。
  const styleIds = assignBotStyleIds(
    config.seed,
    players.filter((player) => !player.isHuman).map((player) => player.id),
  );
  for (const player of players) {
    if (!player.isHuman) player.styleId = styleIds.get(player.id);
    player.statsRaw = createEmptyStatsRaw();
    player.mood = 0;
  }

  return {
    config,
    players,
    // 第一手按钮位为 0 号玩家（startNextHand 会从当前按钮顺时针轮转）。
    buttonIndex: config.playerCount - 1,
    handNo: 0,
    hand: null,
    phase: 'idle',
    logs: [],
    history: [],
    message: '',
    handStartStacks: players.map((player) => player.stack),
  };
}

function nextSeatWithChips(table: TableState, fromIndex: number): number {
  const n = table.players.length;
  for (let offset = 1; offset <= n; offset++) {
    const index = (fromIndex + offset) % n;
    if (table.players[index].stack > 0) return index;
  }
  return -1;
}

function countPlayersWithChips(table: Pick<TableState, 'players'>): number {
  return table.players.filter((player) => player.stack > 0).length;
}

/** 把引擎中的最新手牌同步回会话（日志增量追加）。 */
function syncHand(table: TableState, previousLogLength: number): void {
  if (!table.hand) return;
  table.logs = [...table.logs, ...table.hand.log.slice(previousLogLength)];
}

/** 本手结束后：同步筹码、写入历史、记录胜负摘要。 */
function finalizeHand(table: TableState): void {
  const hand = table.hand;
  if (!hand || !hand.result) throw new Error('无法结算：手牌尚未结束');

  for (let i = 0; i < table.players.length; i++) {
    table.players[i].stack = hand.players[i].stack;
  }
  updateSessionStats(table);

  const history: HandHistory = {
    handNo: hand.handNo,
    seed: table.config.seed,
    buttonIndex: hand.buttonIndex,
    board: hand.board.slice(),
    players: hand.players.map((player, index) => ({
      id: player.id,
      name: player.name,
      holeCards: player.holeCards.slice(),
      startingStack: table.handStartStacks[index] ?? player.stack,
      endingStack: player.stack,
      status: player.status,
      kind: player.kind,
      llmSlot: player.llmSlot,
      styleId: player.styleId,
    })),
    result: hand.result,
    actions: hand.actions.slice(),
    log: hand.log.slice(),
  };
  table.history = [...table.history, history];

  const winnerText = hand.result.winners
    .map((winner) => `${winner.name} +${winner.amount}`)
    .join('、');
  table.message = hand.result.foldedWin
    ? `${winnerText}（其他玩家全部弃牌）`
    : `本手结束：${winnerText}`;
  table.phase = 'handOver';

  if (table.players[0].stack <= 0) {
    table.phase = 'gameOver';
    table.message = '你已输光筹码，点击「重置筹码」重新开始。';
  } else if (countPlayersWithChips(table) < 2) {
    table.phase = 'gameOver';
    table.message = '游戏结束：桌上仅剩一名有筹码的玩家。';
  }
}

/** 开始下一手（轮转按钮位）。 */
export function startNextHand(table: TableState): TableState {
  if (table.phase === 'playing') throw new Error('当前手牌尚未结束，不能开始新一手');
  const next = structuredClone(table);

  if (countPlayersWithChips(next) < 2) {
    next.phase = 'gameOver';
    next.message = '游戏结束：有筹码的玩家不足两人。';
    return next;
  }
  if (next.players[0].stack <= 0) {
    next.phase = 'gameOver';
    next.message = '你已输光筹码，点击「重置筹码」重新开始。';
    return next;
  }

  const buttonIndex = nextSeatWithChips(next, next.buttonIndex);
  if (buttonIndex < 0) throw new Error('无法确定按钮位');
  next.buttonIndex = buttonIndex;
  next.handNo += 1;
  next.handStartStacks = next.players.map((player) => player.stack);

  const hand = createHand({
    handNo: next.handNo,
    players: next.players.map((player) => ({
      id: player.id,
      name: player.name,
      isHuman: player.isHuman,
      stack: player.stack,
      difficulty: player.difficulty,
      kind: player.kind,
      llmSlot: player.llmSlot,
      styleId: player.styleId,
      stats: toPublicStats(player.statsRaw),
      mood: player.mood,
    })),
    buttonIndex,
    smallBlind: next.config.smallBlind,
    bigBlind: next.config.bigBlind,
    seed: next.config.seed,
  });

  next.hand = hand;
  next.phase = hand.phase === 'complete' ? 'handOver' : 'playing';
  next.logs = [...next.logs, ...hand.log];
  next.message = '';

  if (hand.phase === 'complete') {
    finalizeHand(next);
  }
  return next;
}

/** 执行一个玩家动作（playerIndex 必须等于当前行动玩家）。 */
export function act(table: TableState, playerIndex: number, action: PlayerAction): TableState {
  if (table.phase !== 'playing' || !table.hand) {
    throw new IllegalActionError('当前不在牌局进行中');
  }
  const previousLogLength = table.hand.log.length;
  const newHand = playAction(table.hand, playerIndex, action);
  const next = structuredClone(table);
  next.hand = newHand;
  syncHand(next, previousLogLength);
  if (newHand.phase === 'complete') {
    finalizeHand(next);
  }
  return next;
}

/** 当前人类玩家的合法动作（未轮到时返回 null）。 */
export function getHumanLegalActions(table: TableState): LegalActions | null {
  if (table.phase !== 'playing' || !table.hand) return null;
  const hand = table.hand;
  const humanIndex = hand.players.findIndex((player) => player.isHuman);
  if (humanIndex < 0 || hand.actingIndex !== humanIndex) return null;
  return getLegalActions(hand, humanIndex);
}

export function isHumanTurn(table: TableState): boolean {
  return getHumanLegalActions(table) !== null;
}

/** 修改所有机器人的难度（人类玩家没有难度）。当前进行中的手牌也会立即应用新难度。 */
export function setTableDifficulty(table: TableState, difficulty: Difficulty): TableState {
  const next = structuredClone(table);
  next.config.difficulty = difficulty;
  for (const player of next.players) {
    if (!player.isHuman) player.difficulty = difficulty;
  }
  if (next.hand) {
    for (const player of next.hand.players) {
      if (!player.isHuman) player.difficulty = difficulty;
    }
  }
  return next;
}

/** resetChips 的可选参数。 */
export interface ResetChipsOptions {
  /** 重置后换用的新种子；不传则沿用原牌桌种子（固定种子模式可复现）。 */
  seed?: string;
}

/** 重置所有玩家筹码并回到第一手（保留难度 / 种子 / 历史；可注入新种子）。 */
export function resetChips(table: TableState, options: ResetChipsOptions = {}): TableState {
  const next = structuredClone(table);
  const config = next.config;
  const injectedSeed = options.seed?.trim();
  if (injectedSeed) config.seed = injectedSeed;
  next.players = next.players.map((player) => ({
    id: player.id,
    name: player.name,
    isHuman: player.isHuman,
    difficulty: player.difficulty,
    stack: config.startingStack,
    kind: player.kind,
    llmSlot: player.llmSlot,
    styleId: player.styleId,
    statsRaw: createEmptyStatsRaw(),
    mood: 0,
  }));
  // 注入新种子 = 新牌局：重新打乱风格分配，让每个新局的对手“性格组合”不同。
  if (injectedSeed) {
    const styleIds = assignBotStyleIds(
      config.seed,
      next.players.filter((player) => !player.isHuman).map((player) => player.id),
    );
    for (const player of next.players) {
      if (!player.isHuman) player.styleId = styleIds.get(player.id);
    }
  }
  next.buttonIndex = config.playerCount - 1;
  next.handNo = 0;
  next.hand = null;
  next.phase = 'idle';
  next.message = '筹码已重置。';
  next.handStartStacks = next.players.map((player) => player.stack);
  next.logs = [
    ...next.logs,
    {
      id: next.logs.length + 1,
      handNo: 0,
      street: 'system',
      kind: 'system',
      text: '筹码已重置，开始新的牌局。',
    },
  ];
  return next;
}

/** 导出牌局历史（P1：牌局历史导出 / 简单回放数据源）。 */
export function exportHistory(table: TableState): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      config: table.config,
      handCount: table.history.length,
      hands: table.history,
    },
    null,
    2,
  );
}
