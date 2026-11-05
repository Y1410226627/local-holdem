/** 欢迎大厅：牌局未开始（phase === 'idle'）时覆盖在牌桌区域。 */
import { DIFFICULTY_LABELS } from '../game/types';
import type { LobbyInfo } from './types';

interface WelcomeLobbyProps {
  info: LobbyInfo;
  onStartGame: () => void;
  onOpenTutorial: () => void;
}

export function WelcomeLobby({ info, onStartGame, onOpenTutorial }: WelcomeLobbyProps) {
  return (
    <div className="lobby-overlay" role="region" aria-label="欢迎大厅">
      <div className="lobby-card">
        <span className="lobby-card__mark" aria-hidden="true">
          ♠
        </span>
        <p className="lobby-card__eyebrow">本地人机 · 无限注德州扑克</p>
        <h2 className="lobby-card__title">先看规则，再坐上牌桌</h2>
        <p className="lobby-card__lead">
          用两张底牌和五张公共牌组成最强牌型，赢下底池。你与本地算法机器人同桌，
          也可以在「AI 玩家设置」里加入多个大模型玩家（含自定义名字与人物设定）。
        </p>

        <div className="lobby-card__facts" aria-label="当前设置">
          <span className="lobby-fact">{info.playerCount} 人桌</span>
          <span className="lobby-fact">
            {info.challengeMode ? '挑战宗师难度' : DIFFICULTY_LABELS[info.difficulty] + '难度'}
          </span>
          <span className={`lobby-fact${info.llmCount > 0 ? ' lobby-fact--llm' : ''}`}>
            {info.llmCount > 0 ? `大模型 ${info.llmCount} 个` : '纯本地算法'}
          </span>
        </div>

        {info.llmCount > 0 && (
          <p className="lobby-card__llm">
            大模型座位：{info.llmNames.join('、')}（点「开始对局」后生效）
          </p>
        )}

        {info.llmCount > info.playerCount - 1 && (
          <p className="lobby-card__warning" role="alert">
            当前 {info.playerCount} 人桌放不下 {info.llmCount} 个大模型机器人：
            请增加人数，或到「AI 玩家设置」减少启用的大模型玩家。
          </p>
        )}

        <div className="lobby-card__actions">
          <button type="button" className="btn btn--primary lobby-card__start" onClick={onStartGame}>
            开始对局
          </button>
          <button type="button" className="btn btn--secondary" onClick={onOpenTutorial}>
            新手教程
          </button>
        </div>

        <p className="lobby-card__hint">
          首次进入建议先看 1 分钟教程；牌局不会自动开始，点「开始对局」才会发牌。
        </p>
      </div>
    </div>
  );
}
