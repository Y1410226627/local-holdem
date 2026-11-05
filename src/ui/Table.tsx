/** 牌桌：椭圆桌面、公共牌、底池、环绕座位与结算信息。 */
import type { HandState, ShowdownEntry, TableState } from '../game/types';
import { DIFFICULTY_LABELS } from '../game/types';
import { formatChips, resultSummary, STREET_LABELS } from './format';
import { PlayerSeat, type SeatData, type SeatPosition } from './PlayerSeat';
import { PlayingCard } from './CardView';
import { WelcomeLobby } from './WelcomeLobby';
import type { LobbyInfo } from './types';

const HUMAN_SPOT: SeatPosition = { left: 50, top: 87 };

/** 非人类座位的百分比坐标，按人数提供，玩家数组顺序依次落座。 */
const OTHER_SPOTS: Record<number, SeatPosition[]> = {
  2: [{ left: 50, top: 12 }],
  3: [
    { left: 13, top: 38 },
    { left: 87, top: 38 },
  ],
  4: [
    { left: 11, top: 58 },
    { left: 50, top: 11 },
    { left: 89, top: 58 },
  ],
  5: [
    { left: 11, top: 59 },
    { left: 22, top: 18 },
    { left: 78, top: 18 },
    { left: 89, top: 59 },
  ],
  6: [
    { left: 11, top: 60 },
    { left: 21, top: 19 },
    { left: 50, top: 11 },
    { left: 79, top: 19 },
    { left: 89, top: 60 },
  ],
};

interface TableProps {
  table: TableState;
  lobby: LobbyInfo;
  onNextHand: () => void;
  onResetChips: () => void;
  onNewGame: () => void;
  onStartGame: () => void;
  onOpenTutorial: () => void;
  onOpenHistory: () => void;
  /** 大模型玩家 id → 神态/语句气泡。 */
  talkBubbles?: Record<number, string>;
}

interface BlindIds {
  smallBlindId: number | null;
  bigBlindId: number | null;
}

/** 从盲注日志还原小盲 / 大盲玩家（日志按先小盲后大盲写入）。 */
function findBlindIds(hand: HandState | null): BlindIds {
  if (!hand) return { smallBlindId: null, bigBlindId: null };
  const blinds = hand.log.filter((entry) => entry.kind === 'blind' && entry.actorId !== undefined);
  return {
    smallBlindId: blinds[0]?.actorId ?? null,
    bigBlindId: blinds[1]?.actorId ?? null,
  };
}

function PotSummary({ hand }: { hand: HandState }) {
  if (hand.phase === 'playing') {
    return (
      <div className="pot-banner">
        <span className="pot-banner__label">底池</span>
        <strong className="pot-banner__amount">{formatChips(hand.pot)}</strong>
        {hand.currentBet > 0 && (
          <span className="pot-banner__bet">当前下注 {formatChips(hand.currentBet)}</span>
        )}
      </div>
    );
  }

  const result = hand.result;
  if (!result) return null;

  return (
    <div className="pot-result">
      <div className="pot-result__title">底池结算</div>
      {result.pots.length === 0 && <div className="pot-result__empty">本手无底池可分</div>}
      {result.pots.map((pot) => (
        <div className="pot-result__row" key={`pot-${pot.index}`}>
          <span className="pot-result__label">{pot.label}</span>
          <span className="pot-result__amount">{formatChips(pot.amount)}</span>
          <span className="pot-result__payout">
            {pot.payouts
              .map((payout) => `${payout.name} +${formatChips(payout.amount)}`)
              .join('、')}
            {pot.oddChips > 0 && `（奇数筹码 ${pot.oddChips}）`}
          </span>
        </div>
      ))}
      {result.refunds.map((refund) => (
        <div className="pot-result__refund" key={`refund-${refund.playerId}`}>
          退回未跟注：{refund.name} +{formatChips(refund.amount)}
        </div>
      ))}
    </div>
  );
}

export function Table({
  table,
  lobby,
  onNextHand,
  onResetChips,
  onNewGame,
  onStartGame,
  onOpenTutorial,
  onOpenHistory,
  talkBubbles = {},
}: TableProps) {
  const hand = table.hand;
  const humanIndex = table.players.findIndex((player) => player.isHuman);

  const seats: SeatData[] = table.players.map((tablePlayer, index) => {
    const handPlayer = hand?.players[index];
    return {
      id: handPlayer?.id ?? tablePlayer.id,
      name: handPlayer?.name ?? tablePlayer.name,
      isHuman: handPlayer?.isHuman ?? tablePlayer.isHuman,
      stack: handPlayer?.stack ?? tablePlayer.stack,
      committedThisStreet: handPlayer?.committedThisStreet ?? 0,
      status: handPlayer?.status ?? (tablePlayer.stack > 0 ? 'active' : 'out'),
      holeCards: handPlayer?.holeCards ?? [],
      difficulty: tablePlayer.difficulty,
      kind: handPlayer?.kind ?? tablePlayer.kind,
      llmSlot: handPlayer?.llmSlot ?? tablePlayer.llmSlot,
    };
  });

  const otherIndices = table.players.map((_player, index) => index).filter((index) => index !== humanIndex);
  const spotsForCount = OTHER_SPOTS[table.players.length] ?? OTHER_SPOTS[6];

  const positionFor = (index: number): SeatPosition => {
    if (index === humanIndex) return HUMAN_SPOT;
    const spotIndex = otherIndices.indexOf(index);
    return spotsForCount[spotIndex] ?? { left: 50, top: 40 };
  };

  const dealerIndex = hand?.buttonIndex ?? table.buttonIndex;
  const blindIds = findBlindIds(hand);
  const showdownMap = new Map<number, ShowdownEntry>();
  if (hand?.result?.showdown) {
    for (const entry of hand.result.showdown) showdownMap.set(entry.playerId, entry);
  }
  const revealShowdown = hand?.phase === 'complete' && !!hand.result?.showdown;
  const winMap = new Map<number, number>();
  for (const winner of hand?.result?.winners ?? []) winMap.set(winner.playerId, winner.amount);

  const board = hand?.board ?? [];
  const pot = hand
    ? hand.phase === 'playing'
      ? hand.pot
      : (hand.result?.pots.reduce((sum, item) => sum + item.amount, 0) ?? 0)
    : 0;
  const actorIndex = hand?.actingIndex ?? null;
  const actor = hand && actorIndex !== null ? hand.players[actorIndex] : null;
  const isHumanTurn = table.phase === 'playing' && actor !== null && actor.isHuman;

  let hint = '';
  if (table.phase === 'playing') {
    if (actor) {
      if (actor.isHuman) {
        hint = '轮到你行动';
      } else if (actor.kind === 'llm') {
        hint = `大模型 ${actor.name} 思考中…`;
      } else {
        hint = `等待 ${actor.name} 行动…`;
      }
    } else {
      hint = '等待发牌…';
    }
  } else if (hand?.result) {
    hint = `本手结束：${resultSummary(hand.result)}`;
  } else if (table.message) {
    hint = table.message;
  }

  const streetText = !hand
    ? '等待开始'
    : hand.phase === 'playing'
      ? STREET_LABELS[hand.street]
      : '本手结束';

  return (
    <section className="table-panel" aria-label="牌桌">
      <div className="table-toolbar">
        <div className="table-toolbar__left">
          <span className="table-chip">第 {table.handNo} 手</span>
          <span className="table-chip">
            盲注 {formatChips(table.config.smallBlind)}/{formatChips(table.config.bigBlind)}
          </span>
          <span className="table-chip table-chip--muted">
            机器人 {DIFFICULTY_LABELS[table.config.difficulty]}
          </span>
        </div>
        <div className="table-toolbar__right">
          {table.phase === 'playing' && (
            <span className="table-chip table-chip--live">
              <span className="live-dot" aria-hidden="true" /> 进行中
            </span>
          )}
          <button type="button" className="btn btn--ghost btn--sm" onClick={onOpenHistory}>
            牌局历史 {table.history.length > 0 ? `(${table.history.length})` : ''}
          </button>
        </div>
      </div>

      <div className="table-stage">
        <div className="felt" aria-hidden="true" />

        <div className="felt-center">
          {hand ? (
            <>
              <PotSummary hand={hand} />
              <div className="board" aria-label="公共牌">
                {Array.from({ length: 5 }, (_item, index) => (
                  <PlayingCard key={`board-${index}`} card={board[index] ?? null} size="lg" />
                ))}
              </div>
              <div className="table-status">
                <span className="street-chip">{streetText}</span>
                <span className={`turn-hint${isHumanTurn ? ' turn-hint--human' : ''}`}>{hint}</span>
              </div>
            </>
          ) : (
            <div className="felt-empty">
              <span className="felt-empty__mark" aria-hidden="true">
                ♠
              </span>
              <span>{table.phase === 'gameOver' ? '牌局已结束' : '点击「下一手」开始牌局'}</span>
            </div>
          )}
        </div>

        {seats.map((seat, index) => {
          const isHuman = index === humanIndex;
          const revealCards =
            isHuman ||
            (revealShowdown && (seat.status === 'active' || seat.status === 'allin'));
          return (
            <PlayerSeat
              key={`seat-${seat.id}`}
              seat={seat}
              position={positionFor(index)}
              isActing={table.phase === 'playing' && actorIndex === index}
              isDealer={index === dealerIndex}
              isSmallBlind={seat.id === blindIds.smallBlindId}
              isBigBlind={seat.id === blindIds.bigBlindId}
              revealCards={revealCards}
              isWinner={winMap.has(seat.id)}
              winAmount={winMap.get(seat.id) ?? 0}
              showdown={showdownMap.get(seat.id) ?? null}
              showBet={table.phase === 'playing'}
              talk={talkBubbles[seat.id]}
            />
          );
        })}

        {table.phase === 'idle' && !hand && (
          <WelcomeLobby info={lobby} onStartGame={onStartGame} onOpenTutorial={onOpenTutorial} />
        )}

        {table.phase === 'gameOver' && (
          <div className="table-overlay" role="dialog" aria-modal="true" aria-label="游戏结束">
            <div className="table-overlay__card">
              <span className="table-overlay__icon" aria-hidden="true">
                ♠
              </span>
              <h2 className="table-overlay__title">游戏结束</h2>
              <p className="table-overlay__message">{table.message || '牌局结束。'}</p>
              <div className="table-overlay__actions">
                <button type="button" className="btn btn--primary" onClick={onResetChips}>
                  重置筹码
                </button>
                <button type="button" className="btn btn--secondary" onClick={onNewGame}>
                  开始新局
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="table-footer">
        <span className="table-footer__item">底池 {formatChips(pot)}</span>
        <span className="table-footer__item">
          你的筹码 {formatChips(table.players[humanIndex]?.stack ?? 0)}
        </span>
        <span className="table-footer__item table-footer__item--muted">
          {table.phase === 'handOver' ? (
            <button type="button" className="link-button" onClick={onNextHand}>
              开始下一手 →
            </button>
          ) : table.phase === 'idle' ? (
            <button type="button" className="link-button" onClick={onStartGame}>
              开始对局 →
            </button>
          ) : (
            '本地运行 · 可选大模型'
          )}
        </span>
      </div>
    </section>
  );
}
