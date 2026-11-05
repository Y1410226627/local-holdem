/** 牌局日志工具（仅引擎内部使用）。 */
import type { HandState, LogKind } from './types';

/**
 * 追加一条中文日志。
 * id 由手数与日志序号确定，保证可复现（相同种子 + 相同动作 → 相同日志 id）。
 * 注意：任何隐藏信息（对手底牌）不得在摊牌前写入日志。
 */
export function addLog(
  hand: HandState,
  kind: LogKind,
  text: string,
  actorId?: number,
): void {
  hand.log.push({
    id: hand.handNo * 100000 + hand.log.length + 1,
    handNo: hand.handNo,
    street: kind === 'showdown' ? 'showdown' : hand.street,
    kind,
    text,
    actorId,
  });
}
