/** 牌桌座位：头像、筹码、底牌、位置标记、状态与赢家高亮。 */
import type {
  Card,
  Difficulty,
  PlayerKind,
  PlayerStatus,
  PublicPlayerStats,
  ShowdownEntry,
} from '../game/types';
import { DIFFICULTY_LABELS } from '../game/types';
import { formatChips, seatEmoji } from './format';
import { CardBack, PlayingCard } from './CardView';

export interface SeatData {
  id: number;
  name: string;
  isHuman: boolean;
  stack: number;
  committedThisStreet: number;
  status: PlayerStatus;
  holeCards: Card[];
  difficulty?: Difficulty;
  kind?: PlayerKind;
  llmSlot?: number;
  /** 跨手公开行为统计（手数够多时显示 VPIP / 攻击性画像）。 */
  stats?: PublicPlayerStats;
  /** 难度徽标文案覆盖（挑战模式下显示「挑战宗师」）。 */
  difficultyLabel?: string;
}

export interface SeatPosition {
  left: number;
  top: number;
}

interface PlayerSeatProps {
  seat: SeatData;
  position: SeatPosition;
  isActing: boolean;
  isDealer: boolean;
  isSmallBlind: boolean;
  isBigBlind: boolean;
  revealCards: boolean;
  isWinner: boolean;
  winAmount: number;
  showdown: ShowdownEntry | null;
  showBet: boolean;
  /** 大模型玩家的神态/语句（开启该功能时显示在座位气泡）。 */
  talk?: string;
}

export function PlayerSeat({
  seat,
  position,
  isActing,
  isDealer,
  isSmallBlind,
  isBigBlind,
  revealCards,
  isWinner,
  winAmount,
  showdown,
  showBet,
  talk,
}: PlayerSeatProps) {
  const stats = seat.stats;
  const showStats = stats !== undefined && stats.hands >= 3;
  const vpipPct = stats ? Math.round(stats.vpipRate * 100) : 0;
  const pfrPct = stats ? Math.round(stats.pfrRate * 100) : 0;
  const afText = stats ? stats.aggression.toFixed(1) : '0.0';
  const foldText =
    stats && stats.foldToBetRate !== null ? Math.round(stats.foldToBetRate * 100) + '%' : '—';
  const thinkText =
    stats && typeof stats.avgThinkMs === 'number'
      ? ' · 均思考 ' + (stats.avgThinkMs / 1000).toFixed(1) + 's'
      : '';
  const statsTitle = stats
    ? '跨手画像（' +
      stats.hands +
      ' 手）：VPIP ' +
      vpipPct +
      '% · PFR ' +
      pfrPct +
      '% · 攻击性 ' +
      afText +
      ' · 面对下注弃牌 ' +
      foldText +
      thinkText
    : '';

  const className = [
    'seat',
    seat.isHuman ? 'seat--human' : '',
    isActing ? 'seat--acting' : '',
    isWinner ? 'seat--winner' : '',
    seat.status === 'folded' ? 'seat--folded' : '',
    seat.status === 'out' ? 'seat--out' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={className}
      style={{ left: `${position.left}%`, top: `${position.top}%` }}
      aria-label={`${seat.name}，筹码 ${seat.stack}${isActing ? '，行动中' : ''}`}
    >
      {(isDealer || isSmallBlind || isBigBlind) && (
        <div className="seat__position-badges" aria-hidden="true">
          {isDealer && <span className="pos-badge pos-badge--dealer">D</span>}
          {isSmallBlind && <span className="pos-badge pos-badge--sb">SB</span>}
          {isBigBlind && <span className="pos-badge pos-badge--bb">BB</span>}
        </div>
      )}

      <div className="seat__head">
        <span
          className={`seat__avatar${seat.isHuman ? ' seat__avatar--human' : ''}${
            seat.kind === 'llm' ? ' seat__avatar--llm' : ''
          }`}
          aria-hidden="true"
        >
          {seat.kind === 'llm' ? '🤖' : seatEmoji(seat.id, seat.isHuman)}
        </span>
        <div className="seat__identity">
          <div className="seat__name-row">
            <span className="seat__name" title={seat.name}>
              {seat.name}
            </span>
            {seat.kind === 'llm' && <span className="seat__llm-badge">LLM</span>}
            {!seat.isHuman &&
              seat.kind !== 'llm' &&
              (seat.difficultyLabel || seat.difficulty) && (
                <span
                  className={`seat__difficulty${
                    seat.difficultyLabel ? ' seat__difficulty--challenge' : ''
                  }`}
                >
                  {seat.difficultyLabel ??
                    (seat.difficulty ? DIFFICULTY_LABELS[seat.difficulty] : '')}
                </span>
              )}
          </div>
          <div className="seat__stack">
            筹码 <strong>{formatChips(seat.stack)}</strong>
          </div>
          {showStats && (
            <div className="seat__stats" title={statsTitle}>
              VPIP {vpipPct}% · AF {afText}
            </div>
          )}
        </div>
        {isActing && <span className="seat__pulse" aria-hidden="true" />}
      </div>

      {talk && (
        <div className="seat__talk" role="status" title={talk}>
          {talk}
        </div>
      )}

      <div className={`seat__cards${seat.status === 'folded' ? ' seat__cards--folded' : ''}`}>
        {seat.holeCards.length === 0 ? (
          <span className="seat__no-cards">—</span>
        ) : revealCards ? (
          seat.holeCards.map((card) => (
            <PlayingCard
              key={`${card.rank}-${card.suit}`}
              card={card}
              size="sm"
              dimmed={seat.status === 'folded'}
            />
          ))
        ) : (
          seat.holeCards.map((_card, index) => (
            <CardBack
              key={`back-${index}`}
              size="sm"
              dimmed={seat.status === 'folded'}
            />
          ))
        )}
      </div>

      <div className="seat__status-row">
        {isActing && seat.kind === 'llm' && (
          <span className="status-chip status-chip--thinking">大模型思考中</span>
        )}
        {isActing && seat.kind !== 'llm' && <span className="status-chip status-chip--acting">行动中</span>}
        {seat.status === 'folded' && <span className="status-chip status-chip--folded">已弃牌</span>}
        {seat.status === 'allin' && <span className="status-chip status-chip--allin">全下</span>}
        {seat.status === 'out' && <span className="status-chip status-chip--out">已淘汰</span>}
        {showBet && seat.committedThisStreet > 0 && seat.status !== 'folded' && (
          <span className="seat__bet">本轮下注 {formatChips(seat.committedThisStreet)}</span>
        )}
      </div>

      {showdown && (
        <div className="seat__description" title={showdown.description}>
          {showdown.description}
        </div>
      )}
      {isWinner && <div className="seat__win">赢 +{formatChips(winAmount)}</div>}
    </div>
  );
}
