/**
 * 下注引擎：合法动作计算、动作合法性校验、动作执行。
 *
 * 核心规则：
 * - 无限注：下注上限为剩余筹码。
 * - 最小加注增量 = 上一次完整加注的增量；翻牌前初始增量 = 大盲，翻牌后最小下注 = 大盲。
 * - short all-in（不足最小加注的全下）不重开已行动玩家的加注权；
 *   尚未行动的玩家仍可正常加注到完整最小额。
 * - 多个 short all-in 累计达到一次完整加注额时，重开已行动玩家的加注权（TDA 累积规则）。
 * - 大盲 option：翻牌前无人加注时，大盲可过牌或加注（由 hasActedThisStreet 自然支持）。
 */
import type { HandState, LegalActions, PlayerAction, PlayerState } from './types';
import { addLog } from './log';

export class IllegalActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalActionError';
  }
}

export function cloneHand(hand: HandState): HandState {
  return structuredClone(hand);
}

/** 计算当前行动玩家的合法动作。会校验是否轮到他行动。 */
export function getLegalActions(hand: HandState, playerIndex: number): LegalActions {
  if (hand.phase !== 'playing') {
    throw new IllegalActionError('本手牌已经结束');
  }
  if (hand.actingIndex === null) {
    throw new IllegalActionError('当前没有玩家需要行动');
  }
  if (hand.actingIndex !== playerIndex) {
    const current = hand.players[hand.actingIndex];
    throw new IllegalActionError(`当前轮到 ${current?.name ?? '其他玩家'} 行动`);
  }
  const player = hand.players[playerIndex];
  if (!player) throw new IllegalActionError('玩家不存在');
  if (player.status !== 'active') {
    throw new IllegalActionError(`${player.name} 当前不能行动（状态：${player.status}）`);
  }

  const toCall = Math.max(0, hand.currentBet - player.committedThisStreet);
  const callAmount = Math.min(toCall, player.stack);
  const maxRaiseTo = player.committedThisStreet + player.stack;
  const raiseRights = player.canRaise;

  // 最小“加到”金额：
  // - 无人下注：最小下注 = 大盲（若筹码不足，只能全下）。
  // - 面对小于大盲的短全下：补足到完整大盲（TDA 精神：按最小下注额完成下注）。
  // - 其他情况：当前下注 + 上一次完整加注增量。
  let minRaiseTo: number;
  if (hand.currentBet === 0) {
    minRaiseTo = hand.bigBlind;
  } else if (hand.currentBet < hand.bigBlind) {
    minRaiseTo = hand.bigBlind;
  } else {
    minRaiseTo = hand.currentBet + hand.lastFullRaiseSize;
  }

  const canAggressFully = raiseRights && maxRaiseTo >= minRaiseTo && maxRaiseTo > hand.currentBet;
  const isAllInCall = maxRaiseTo <= hand.currentBet;
  const canAllInAggressive = raiseRights && maxRaiseTo > hand.currentBet;

  return {
    playerId: player.id,
    currentBet: hand.currentBet,
    callAmount,
    canFold: true,
    canCheck: toCall === 0,
    canCall: toCall > 0,
    canBet: hand.currentBet === 0 && canAggressFully,
    canRaise: hand.currentBet > 0 && canAggressFully,
    canAllIn: player.stack > 0 && (isAllInCall || canAllInAggressive),
    minRaiseTo,
    maxRaiseTo,
    aggressiveType: hand.currentBet === 0 ? (canAggressFully ? 'bet' : null) : canAggressFully ? 'raise' : null,
    raiseRights,
    isAllInCall,
  };
}

function requireInteger(amount: number): void {
  if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
    throw new IllegalActionError(`金额必须为整数，收到：${amount}`);
  }
}

/** 校验动作是否合法，非法时抛出带中文说明的 IllegalActionError。 */
export function validateAction(
  hand: HandState,
  playerIndex: number,
  action: PlayerAction,
): LegalActions {
  const legal = getLegalActions(hand, playerIndex);
  const player = hand.players[playerIndex];

  switch (action.type) {
    case 'fold':
      return legal;
    case 'check':
      if (!legal.canCheck) {
        throw new IllegalActionError(
          `面对 ${hand.currentBet - player.committedThisStreet} 的下注不能过牌，只能跟注、加注或弃牌`,
        );
      }
      return legal;
    case 'call':
      if (!legal.canCall) {
        throw new IllegalActionError('当前无需跟注，可以过牌');
      }
      return legal;
    case 'allin':
      if (!legal.canAllIn) {
        throw new IllegalActionError('当前无法全下');
      }
      return legal;
    case 'bet':
    case 'raise': {
      if (action.type === 'bet' && hand.currentBet !== 0) {
        throw new IllegalActionError('当前已有下注，应使用加注');
      }
      if (action.type === 'raise' && hand.currentBet === 0) {
        throw new IllegalActionError('当前无人下注，应使用下注');
      }
      requireInteger(action.amount);
      if (action.amount <= hand.currentBet) {
        throw new IllegalActionError(
          `进攻性下注必须高于当前下注额 ${hand.currentBet}，收到 ${action.amount}`,
        );
      }
      if (action.amount > legal.maxRaiseTo) {
        throw new IllegalActionError(
          `下注额 ${action.amount} 超过可投入的上限 ${legal.maxRaiseTo}（剩余筹码不足）`,
        );
      }
      if (!player.canRaise) {
        throw new IllegalActionError(
          `加注权已关闭：本轮已行动过的玩家面对不足最小加注的全下只能跟注或弃牌`,
        );
      }
      // 全下金额允许低于最小加注额（短全下）；否则必须达到最小加注额。
      if (action.amount < legal.minRaiseTo && action.amount !== legal.maxRaiseTo) {
        throw new IllegalActionError(
          `最小加注额为 ${legal.minRaiseTo}，收到 ${action.amount}`,
        );
      }
      return legal;
    }
    default: {
      const exhaustive: never = action;
      throw new IllegalActionError(`未知动作：${JSON.stringify(exhaustive)}`);
    }
  }
}

interface AggressionParams {
  hand: HandState;
  player: PlayerState;
  playerIndex: number;
  target: number;
  previousBet: number;
}

/** 处理下注/加注/进攻性全下：更新下注额、最小加注增量、加注权。 */
function applyAggression({ hand, player, playerIndex, target, previousBet }: AggressionParams): void {
  const increment = target - previousBet;
  const isFullRaise = increment >= hand.lastFullRaiseSize;
  hand.currentBet = Math.max(hand.currentBet, target);

  if (isFullRaise) {
    hand.lastFullRaiseSize = increment;
    for (let i = 0; i < hand.players.length; i++) {
      if (i === playerIndex) continue;
      const other = hand.players[i];
      if (other.status === 'active') other.canRaise = true;
    }
  } else {
    // short all-in：不主动重开；但若多个短全下累计达到一次完整加注额，则重开。
    for (const other of hand.players) {
      if (other.id === player.id || other.status !== 'active') continue;
      if (other.hasActedThisStreet && !other.canRaise) {
        if (hand.currentBet - other.lastActionBet >= hand.lastFullRaiseSize) {
          other.canRaise = true;
        }
      }
    }
  }

  player.canRaise = false;
  hand.lastAggressorIndex = playerIndex;
}

/** 执行动作（原地修改传入的 hand，调用方负责克隆）。 */
function applyActionMutable(hand: HandState, playerIndex: number, action: PlayerAction): void {
  const legal = validateAction(hand, playerIndex, action);
  const player = hand.players[playerIndex];
  const previousBet = hand.currentBet;
  let paid = 0;

  switch (action.type) {
    case 'fold': {
      player.status = 'folded';
      addLog(hand, 'action', `${player.name} 弃牌`, player.id);
      break;
    }
    case 'check': {
      addLog(hand, 'action', `${player.name} 过牌`, player.id);
      break;
    }
    case 'call': {
      const toCall = Math.max(0, hand.currentBet - player.committedThisStreet);
      paid = Math.min(toCall, player.stack);
      player.stack -= paid;
      player.committedThisStreet += paid;
      player.totalCommitted += paid;
      if (player.stack === 0) player.status = 'allin';
      const text =
        player.status === 'allin'
          ? `${player.name} 全下跟注 ${paid}`
          : `${player.name} 跟注 ${paid}`;
      addLog(hand, 'action', text, player.id);
      break;
    }
    case 'allin': {
      const target = player.committedThisStreet + player.stack;
      paid = player.stack;
      player.stack = 0;
      player.committedThisStreet = target;
      player.totalCommitted += paid;
      player.status = 'allin';
      if (target > hand.currentBet) {
        applyAggression({ hand, player, playerIndex, target, previousBet });
        addLog(hand, 'action', `${player.name} 全下到 ${target}`, player.id);
      } else {
        addLog(hand, 'action', `${player.name} 全下跟注 ${paid}`, player.id);
      }
      break;
    }
    case 'bet':
    case 'raise': {
      const target = action.amount;
      paid = target - player.committedThisStreet;
      player.stack -= paid;
      player.committedThisStreet = target;
      player.totalCommitted += paid;
      if (player.stack === 0) player.status = 'allin';
      applyAggression({ hand, player, playerIndex, target, previousBet });
      const verb = action.type === 'bet' ? '下注' : '加注到';
      const suffix = player.status === 'allin' ? '（全下）' : '';
      addLog(hand, 'action', `${player.name} ${verb} ${target}${suffix}`, player.id);
      break;
    }
  }

  player.hasActedThisStreet = true;
  player.lastActionBet = player.committedThisStreet;
  player.canRaise = false;
  hand.actionCount += 1;
  hand.pot = hand.players.reduce((sum, p) => sum + p.totalCommitted, 0);
  hand.actions.push({
    handNo: hand.handNo,
    street: hand.street,
    actorId: player.id,
    actorName: player.name,
    action,
    paid,
    toAmount: player.committedThisStreet,
    potAfter: hand.pot,
    stackAfter: player.stack,
    board: hand.board.slice(),
  });
}

/**
 * 执行动作并返回新状态（纯函数，不修改入参）。
 * 注意：这里只执行动作本身，行动权推进 / 街道推进 / 摊牌由 gameEngine.playAction 负责。
 */
export function applyPlayerAction(
  hand: HandState,
  playerIndex: number,
  action: PlayerAction,
): HandState {
  const next = cloneHand(hand);
  applyActionMutable(next, playerIndex, action);
  return next;
}

export { applyActionMutable };
