/** 纯 CSS 绘制的扑克牌（无图片 / 无外部字体）。 */
import type { Card } from '../game/types';
import { RANK_LABELS, SUIT_LABELS, cardLabel } from '../game/cards';

export type CardSize = 'sm' | 'md' | 'lg';

interface PlayingCardProps {
  card: Card | null;
  size?: CardSize;
  dimmed?: boolean;
}

export function PlayingCard({ card, size = 'md', dimmed = false }: PlayingCardProps) {
  if (!card) {
    return <div className={`card card--${size} card--empty`} aria-hidden="true" />;
  }
  const isRed = card.suit === 'h' || card.suit === 'd';
  const label = cardLabel(card);
  return (
    <div
      className={`card card--${size} ${isRed ? 'card--red' : 'card--black'}${
        dimmed ? ' card--dimmed' : ''
      }`}
      role="img"
      aria-label={label}
      title={label}
    >
      <span className="card__corner card__corner--top">
        <span className="card__rank">{RANK_LABELS[card.rank]}</span>
        <span className="card__suit">{SUIT_LABELS[card.suit]}</span>
      </span>
      <span className="card__pip" aria-hidden="true">
        {SUIT_LABELS[card.suit]}
      </span>
      <span className="card__corner card__corner--bottom" aria-hidden="true">
        <span className="card__rank">{RANK_LABELS[card.rank]}</span>
        <span className="card__suit">{SUIT_LABELS[card.suit]}</span>
      </span>
    </div>
  );
}

interface CardBackProps {
  size?: CardSize;
  dimmed?: boolean;
}

export function CardBack({ size = 'sm', dimmed = false }: CardBackProps) {
  return (
    <div
      className={`card card--${size} card--back${dimmed ? ' card--dimmed' : ''}`}
      role="img"
      aria-label="暗牌"
    >
      <span className="card__back-mark" aria-hidden="true">
        ♠
      </span>
    </div>
  );
}
