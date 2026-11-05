/** 人类操作区：动作按钮、下注/加注滑块与快捷尺度、等待状态提示。 */
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { LegalActions, PlayerAction, TableState } from '../game/types';
import { formatChips, STREET_LABELS } from './format';

interface ControlsProps {
  table: TableState;
  humanIndex: number;
  legal: LegalActions | null;
  onAction: (action: PlayerAction) => void;
  onNextHand: () => void;
  onNewGame: () => void;
  onResetChips: () => void;
  onStartGame: () => void;
  onOpenTutorial: () => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function Controls({
  table,
  humanIndex,
  legal,
  onAction,
  onNextHand,
  onNewGame,
  onResetChips,
  onStartGame,
  onOpenTutorial,
}: ControlsProps) {
  const hand = table.hand;
  const humanPlayer = hand ? (hand.players[humanIndex] ?? null) : null;
  const actor = hand && hand.actingIndex !== null ? hand.players[hand.actingIndex] : null;

  const panelRef = useRef<HTMLElement | null>(null);

  // 人类需要操作 / 本手结束时，如果操作区在视口之外，自动滚入视野。
  // 常见桌面视口（如 1440×900）下牌桌较高，避免玩家必须手动滚动才能行动。
  const needsAttention =
    legal !== null || table.phase === 'handOver' || table.phase === 'gameOver';
  useEffect(() => {
    if (!needsAttention) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    if (rect.bottom > viewportHeight - 8 || rect.top < 0) {
      panel.scrollIntoView({ behavior: 'auto', block: 'nearest' });
    }
  }, [needsAttention, table.phase, table.handNo, hand?.actionCount, hand?.actingIndex]);

  const [betText, setBetText] = useState('');
  const canSize = legal !== null && (legal.canBet || legal.canRaise);
  const minBet = legal?.minRaiseTo ?? 0;
  const maxBet = legal?.maxRaiseTo ?? 0;
  const sizingKey = legal
    ? `${hand?.handNo ?? 0}:${hand?.actionCount ?? 0}:${legal.minRaiseTo}:${legal.maxRaiseTo}`
    : 'none';

  useEffect(() => {
    if (legal && (legal.canBet || legal.canRaise)) {
      setBetText(String(legal.minRaiseTo));
    } else {
      setBetText('');
    }
    // 仅在新的行动回合 / 尺度区间变化时重置，避免覆盖用户输入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sizingKey]);

  const parsedBet = Number.parseInt(betText, 10);
  const currentBet = Number.isFinite(parsedBet) ? clamp(parsedBet, minBet, maxBet) : minBet;
  const pot = hand?.pot ?? 0;

  const setAmount = (value: number) => {
    if (!Number.isFinite(value)) return;
    setBetText(String(clamp(Math.round(value), minBet, maxBet)));
  };

  const handleAmountText = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    if (/^\d*$/.test(next)) setBetText(next);
  };

  const normalizeAmount = () => {
    setBetText(String(currentBet));
  };

  const handleBet = () => {
    if (legal?.canBet) onAction({ type: 'bet', amount: currentBet });
  };

  const handleRaise = () => {
    if (legal?.canRaise) onAction({ type: 'raise', amount: currentBet });
  };

  if (!hand) {
    if (table.phase === 'idle') {
      return (
        <section ref={panelRef} className="controls-panel" aria-label="操作区">
          <div className="controls__header">
            <span className="controls__turn">等待开局</span>
            <span className="controls__street">大厅</span>
          </div>
          <div className="controls__message">
            牌局尚未开始。点「开始对局」会按当前设置创建牌桌并发牌；也可以先看新手教程。
          </div>
          <div className="controls__actions">
            <button type="button" className="btn btn--primary" onClick={onStartGame}>
              开始对局
            </button>
            <button type="button" className="btn btn--secondary" onClick={onOpenTutorial}>
              新手教程
            </button>
          </div>
        </section>
      );
    }

    return (
      <section ref={panelRef} className="controls-panel" aria-label="操作区">
        <div className="controls__header">
          <span className="controls__turn">牌局已就绪</span>
        </div>
        <div className="controls__message">
          {table.message || '点击「下一手」开始一手牌。'}
        </div>
        <div className="controls__actions">
          <button type="button" className="btn btn--primary" onClick={onNextHand}>
            开始下一手
          </button>
          {table.phase === 'gameOver' && (
            <button type="button" className="btn btn--secondary" onClick={onResetChips}>
              重置筹码
            </button>
          )}
        </div>
      </section>
    );
  }

  if (table.phase === 'gameOver') {
    return (
      <section ref={panelRef} className="controls-panel" aria-label="操作区">
        <div className="controls__header">
          <span className="controls__turn">游戏结束</span>
          <span className="controls__street">第 {hand.handNo} 手</span>
        </div>
        <div className="controls__message">{table.message || '牌局已经结束。'}</div>
        <div className="controls__actions">
          <button type="button" className="btn btn--primary" onClick={onResetChips}>
            重置筹码
          </button>
          <button type="button" className="btn btn--secondary" onClick={onNewGame}>
            开始新局
          </button>
        </div>
      </section>
    );
  }

  if (table.phase === 'handOver' || table.phase === 'idle') {
    return (
      <section ref={panelRef} className="controls-panel" aria-label="操作区">
        <div className="controls__header">
          <span className="controls__turn">本手结束</span>
          <span className="controls__street">
            第 {hand.handNo} 手 · {STREET_LABELS[hand.street]}
          </span>
        </div>
        <div className="controls__message">{table.message || '本手已经结算完毕。'}</div>
        <div className="controls__actions">
          <button type="button" className="btn btn--primary" onClick={onNextHand}>
            开始下一手
          </button>
          <span className="controls__hint">也可以先调整设置，再点「新局」重新开始。</span>
        </div>
      </section>
    );
  }

  if (!legal) {
    let title = '等待发牌…';
    let detail = '本轮下注已经结束。';
    if (humanPlayer?.status === 'folded') {
      title = '你已弃牌';
      detail = '等待本手结束…';
    } else if (humanPlayer?.status === 'allin') {
      title = '你已全下';
      detail = '等待其余玩家行动与发牌…';
    } else if (humanPlayer?.status === 'out') {
      title = '你已淘汰';
      detail = '等待本手结束…';
    } else if (actor) {
      if (actor.kind === 'llm') {
        title = '大模型思考中…';
        detail = `${actor.name} 正在调用本地大模型；失败或超时会自动回退本地算法，不会卡住牌局。`;
      } else {
        title = `等待 ${actor.name} 行动…`;
        detail = '机器人正在思考，请稍候。';
      }
    }

    return (
      <section ref={panelRef} className="controls-panel controls-panel--waiting" aria-label="操作区">
        <div className="controls__header">
          <span className="controls__turn controls__turn--waiting">
            {title}
            {actor && !actor.isHuman && <span className="waiting-dots" aria-hidden="true"> ···</span>}
          </span>
          <span className="controls__street">{STREET_LABELS[hand.street]}</span>
          <span className="controls__your-stack">
            你的筹码 {formatChips(humanPlayer?.stack ?? 0)}
          </span>
        </div>
        <div className="controls__message">{detail}</div>
      </section>
    );
  }

  return (
    <section ref={panelRef} className="controls-panel" aria-label="操作区">
      <div className="controls__header">
        <span className="controls__turn controls__turn--human">轮到你行动</span>
        <span className="controls__street">{STREET_LABELS[hand.street]}</span>
        <span className="controls__your-stack">
          你的筹码 {formatChips(humanPlayer?.stack ?? 0)}
        </span>
      </div>

      <div className="controls__meta">
        <span>当前下注 {formatChips(legal.currentBet)}</span>
        <span>
          {legal.canCheck ? '无需跟注，可过牌' : `需跟注 ${formatChips(legal.callAmount)}`}
        </span>
        <span>底池 {formatChips(pot)}</span>
        {legal.isAllInCall && <span className="controls__meta-warn">跟注即全下</span>}
      </div>

      <div className="action-row">
        <button
          type="button"
          className="action-button action-button--fold"
          onClick={() => onAction({ type: 'fold' })}
          disabled={!legal.canFold}
        >
          弃牌
        </button>
        <button
          type="button"
          className="action-button action-button--check"
          onClick={() => onAction({ type: 'check' })}
          disabled={!legal.canCheck}
        >
          过牌
        </button>
        <button
          type="button"
          className="action-button action-button--call"
          onClick={() => onAction({ type: 'call' })}
          disabled={!legal.canCall}
        >
          {legal.canCall
            ? `跟注 ${formatChips(legal.callAmount)}${legal.isAllInCall ? '（全下）' : ''}`
            : '跟注'}
        </button>
        <button
          type="button"
          className="action-button action-button--bet"
          onClick={handleBet}
          disabled={!legal.canBet}
        >
          下注
        </button>
        <button
          type="button"
          className="action-button action-button--raise"
          onClick={handleRaise}
          disabled={!legal.canRaise}
        >
          加注
        </button>
        <button
          type="button"
          className="action-button action-button--allin"
          onClick={() => onAction({ type: 'allin' })}
          disabled={!legal.canAllIn}
        >
          全下
        </button>
      </div>

      {canSize && (
        <div className="sizing">
          <div className="sizing__head">
            <span className="sizing__label">{legal.canBet ? '下注额' : '加注到'}</span>
            <span className="sizing__range">
              合法范围 {formatChips(legal.minRaiseTo)} – {formatChips(legal.maxRaiseTo)}
            </span>
          </div>
          <div className="sizing__controls">
            <input
              type="range"
              className="sizing__slider"
              min={minBet}
              max={maxBet}
              step={1}
              value={currentBet}
              onChange={(event) => setBetText(event.target.value)}
              aria-label="下注金额滑块"
            />
            <input
              type="number"
              className="sizing__input"
              min={minBet}
              max={maxBet}
              step={1}
              inputMode="numeric"
              value={betText}
              onChange={handleAmountText}
              onBlur={normalizeAmount}
              onKeyDown={(event) => {
                if (event.key === 'Enter') normalizeAmount();
              }}
              aria-label="下注金额（整数）"
            />
          </div>
          <div className="quick-bets">
            <button type="button" className="quick-button" onClick={() => setAmount(minBet)}>
              最小
            </button>
            <button type="button" className="quick-button" onClick={() => setAmount(pot / 2)}>
              1/2 底池
            </button>
            <button type="button" className="quick-button" onClick={() => setAmount((pot * 2) / 3)}>
              2/3 底池
            </button>
            <button type="button" className="quick-button" onClick={() => setAmount(pot)}>
              底池
            </button>
            <button type="button" className="quick-button" onClick={() => setAmount(maxBet)}>
              全下
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
