/** AI 玩家设置弹窗：玩家名称、多个大模型玩家（含人物设定）、AI 军师、连接测试与自动探测。 */
import { useEffect, useState } from 'react';
import { MAX_LLM_SEATS } from '../game/types';
import { testLlmConnection, type LlmConnectionResult } from '../ai/llmBot';
import { testAdvisorConnection } from '../ai/advisor';
import { clearHandMemories, memoryCount } from '../ai/llmMemory';
import { formatChips, getErrorMessage } from './format';
import {
  LLM_PROBE_PORTS_TEXT,
  detectLocalLlmServices,
  slotPatchFromDetectedModel,
  type DetectedLlmService,
} from './llmDetect';
import {
  DEFAULT_LOCAL_BOT_NAMES,
  MAX_LOCAL_BOTS,
  addLlmSeat,
  advisorReady,
  getLlmSeat,
  llmSeatSummary,
  removeLlmSeat,
  seatLabel,
  setLocalBotName,
  toAdvisorConfig,
  toLlmSeatConfig,
  updateAdvisorSettings,
  updateLlmSeat,
  type LlmSettings,
  type LlmSlotSettings,
} from './llmSettings';

interface LlmSettingsModalProps {
  settings: LlmSettings;
  /** 当前设置栏选择的人数，用于计算最多可启用的大模型玩家数。 */
  playerCount: number;
  onChange: (next: LlmSettings) => void;
  onClose: () => void;
}

interface TestState {
  loading: boolean;
  result: LlmConnectionResult | null;
  error: string | null;
}

const EMPTY_TEST: TestState = { loading: false, result: null, error: null };

function ConnectionLine({ test }: { test: TestState }) {
  if (test.loading) {
    return (
      <div className="llm-test llm-test--loading" role="status">
        正在请求模型服务，请稍候…
      </div>
    );
  }
  if (test.result?.ok) {
    return (
      <div className="llm-test llm-test--ok" role="status">
        连接成功 · 延迟 {test.result.latencyMs ?? '—'}ms
        {test.result.sample ? ` · 样例：${test.result.sample}` : ''}
      </div>
    );
  }
  if (test.result && !test.result.ok) {
    return (
      <div className="llm-test llm-test--error" role="alert">
        连接失败：{test.result.message}
      </div>
    );
  }
  if (test.error) {
    return (
      <div className="llm-test llm-test--error" role="alert">
        连接失败：{test.error}
      </div>
    );
  }
  return null;
}

interface SeatCardProps {
  seat: LlmSlotSettings;
  onPatch: (patch: Partial<Omit<LlmSlotSettings, 'slot'>>) => void;
  onRemove: () => void;
  canRemove: boolean;
  enableBlocked: boolean;
  test: TestState;
  onTest: () => void;
  onClearMemory: () => void;
}

function SeatCard({
  seat,
  onPatch,
  onRemove,
  canRemove,
  enableBlocked,
  test,
  onTest,
  onClearMemory,
}: SeatCardProps) {
  const memory = memoryCount(seat.slot);
  return (
    <section
      className={`llm-card${seat.enabled ? ' llm-card--enabled' : ''}`}
      aria-label={`${seatLabel(seat.slot)}设置`}
    >
      <header className="llm-card__header">
        <div className="llm-card__title-row">
          <span className="llm-slot-badge">座位 {seat.slot}</span>
          <h3 className="llm-card__title">{seat.name.trim() || seatLabel(seat.slot)}</h3>
          <label className="llm-switch">
            <input
              type="checkbox"
              checked={seat.enabled}
              onChange={(event) => onPatch({ enabled: event.target.checked })}
              disabled={enableBlocked && !seat.enabled}
            />
            <span>加入牌局</span>
          </label>
          {canRemove && (
            <button
              type="button"
              className="btn btn--ghost btn--sm llm-card__remove"
              onClick={onRemove}
              aria-label={`删除${seatLabel(seat.slot)}`}
            >
              删除
            </button>
          )}
        </div>
        <p className="llm-card__summary">
          {llmSeatSummary(seat)}
          {enableBlocked && !seat.enabled ? ' · 当前人数已放不下更多大模型' : ''}
        </p>
      </header>

      <div className="llm-form">
        <label className="llm-field">
          <span className="llm-field__label">显示名称</span>
          <input
            type="text"
            className="llm-input"
            value={seat.name}
            onChange={(event) => onPatch({ name: event.target.value })}
            placeholder={seatLabel(seat.slot)}
            spellCheck={false}
            autoComplete="off"
          />
        </label>

        <label className="llm-field llm-field--wide">
          <span className="llm-field__label">人物设定（可选，写进提示词：性格 / 说话风格 / 打法）</span>
          <textarea
            className="llm-input llm-textarea"
            value={seat.persona}
            onChange={(event) => onPatch({ persona: event.target.value })}
            placeholder="例：老派赌徒，说话阴阳怪气，喜欢诈唬；或：冷静紧凶的数学流，很少闲聊。"
            rows={2}
            spellCheck={false}
          />
        </label>

        <label className="llm-field llm-field--wide">
          <span className="llm-field__label">Base URL（OpenAI 兼容）</span>
          <input
            type="text"
            className="llm-input"
            value={seat.baseUrl}
            onChange={(event) => onPatch({ baseUrl: event.target.value })}
            placeholder="http://127.0.0.1:11434/v1"
            spellCheck={false}
            autoComplete="off"
          />
        </label>

        <label className="llm-field">
          <span className="llm-field__label">模型名</span>
          <input
            type="text"
            className="llm-input"
            value={seat.model}
            onChange={(event) => onPatch({ model: event.target.value })}
            placeholder="qwen2.5:7b"
            spellCheck={false}
            autoComplete="off"
          />
        </label>

        <label className="llm-field">
          <span className="llm-field__label">API Key（可选）</span>
          <input
            type="password"
            className="llm-input"
            value={seat.apiKey}
            onChange={(event) => onPatch({ apiKey: event.target.value })}
            placeholder="本地通常留空"
            autoComplete="new-password"
          />
        </label>

        <label className="llm-field">
          <span className="llm-field__label">温度（0–2）</span>
          <input
            type="number"
            className="llm-input"
            min={0}
            max={2}
            step={0.1}
            value={seat.temperature}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isFinite(value)) onPatch({ temperature: value });
            }}
          />
        </label>

        <label className="llm-field">
          <span className="llm-field__label">超时（毫秒）</span>
          <input
            type="number"
            className="llm-input"
            min={1000}
            max={300000}
            step={1000}
            value={seat.timeoutMs}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isFinite(value)) onPatch({ timeoutMs: value });
            }}
          />
        </label>

        <label className="llm-field">
          <span className="llm-field__label">输出 token 上限</span>
          <input
            type="number"
            className="llm-input"
            min={32}
            max={32000}
            step={100}
            value={seat.maxTokens}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isFinite(value)) onPatch({ maxTokens: value });
            }}
          />
        </label>
      </div>

      <div className="llm-card__actions">
        <button type="button" className="btn btn--secondary btn--sm" onClick={onTest} disabled={test.loading}>
          {test.loading ? '正在测试…' : '测试连接'}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClearMemory}>
          清空对局记忆
        </button>
        <span className="llm-memory-count">已记录 {formatChips(memory)} 条</span>
      </div>
      <ConnectionLine test={test} />
    </section>
  );
}

export function LlmSettingsModal({ settings, playerCount, onChange, onClose }: LlmSettingsModalProps) {
  const [, setMemoryVersion] = useState(0);
  const [detecting, setDetecting] = useState(false);
  const [detectedServices, setDetectedServices] = useState<DetectedLlmService[] | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [appliedMessage, setAppliedMessage] = useState<string | null>(null);
  const [seatTests, setSeatTests] = useState<Record<number, TestState>>({});
  const [advisorTest, setAdvisorTest] = useState<TestState>(EMPTY_TEST);

  const enabledCount = settings.seats.filter((seat) => seat.enabled).length;
  const maxEnabled = Math.max(0, playerCount - 1);
  const canAddSeat = settings.seats.length < MAX_LLM_SEATS;
  const localBotCount = Math.max(0, playerCount - 1 - enabledCount);

  const patchSeat = (slot: number, patch: Partial<Omit<LlmSlotSettings, 'slot'>>): void => {
    onChange(updateLlmSeat(settings, slot, patch));
  };

  const handleTestSeat = async (seat: LlmSlotSettings): Promise<void> => {
    setSeatTests((previous) => ({ ...previous, [seat.slot]: { ...EMPTY_TEST, loading: true } }));
    try {
      const result = await testLlmConnection(toLlmSeatConfig(seat));
      setSeatTests((previous) => ({ ...previous, [seat.slot]: { loading: false, result, error: null } }));
    } catch (error) {
      setSeatTests((previous) => ({
        ...previous,
        [seat.slot]: { loading: false, result: null, error: getErrorMessage(error) },
      }));
    }
  };

  const handleTestAdvisor = async (): Promise<void> => {
    setAdvisorTest({ ...EMPTY_TEST, loading: true });
    try {
      const result = await testAdvisorConnection(toAdvisorConfig(settings));
      setAdvisorTest({ loading: false, result, error: null });
    } catch (error) {
      setAdvisorTest({ loading: false, result: null, error: getErrorMessage(error) });
    }
  };

  const handleDetect = async (): Promise<void> => {
    setDetecting(true);
    setDetectError(null);
    try {
      const services = await detectLocalLlmServices();
      setDetectedServices(services);
    } catch (error) {
      setDetectError(getErrorMessage(error));
    } finally {
      setDetecting(false);
    }
  };

  useEffect(() => {
    void handleDetect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const applyDetectedModel = (service: DetectedLlmService, model: string): void => {
    if (!canAddSeat) {
      setAppliedMessage(`最多 ${MAX_LLM_SEATS} 个大模型玩家；请先删除一个再添加。`);
      return;
    }
    const withSeat = addLlmSeat(settings);
    const newSlot = withSeat.seats.length;
    onChange(
      updateLlmSeat(withSeat, newSlot, {
        ...slotPatchFromDetectedModel(service, model),
        enabled: false,
      }),
    );
    setAppliedMessage(
      `已新增${seatLabel(newSlot)}并填入 ${model}（${service.baseUrl}）。点「测试连接」确认后勾选「加入牌局」。`,
    );
  };

  const detectedModelCount =
    detectedServices?.reduce((sum, service) => sum + service.models.length, 0) ?? 0;
  const advisor = settings.advisor;
  const advisorConfigured = advisorReady(settings);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal llm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="llm-settings-title"
      >
        <header className="modal__header">
          <div>
            <p className="modal__eyebrow">
              AI 玩家设置 · 已启用 {enabledCount} / {maxEnabled}
            </p>
            <h2 className="modal__title" id="llm-settings-title">
              AI 玩家 / 名称 / 军师设置
            </h2>
            <p className="modal__subtitle">
              大模型玩家数量由人数决定（{playerCount} 人桌最多 {maxEnabled} 个）；名称和人物设定都可自由编写。
              修改后点设置栏「新局」重新入座。
            </p>
          </div>
          <button type="button" className="modal__close" onClick={onClose} aria-label="关闭 AI 设置">
            ×
          </button>
        </header>

        <div className="llm-modal__body">
          <p className="llm-modal__intro">
            提示词使用精简英文 + 短 JSON 输出以节省 token；人物设定、神态语句、AI 军师都是可选项。
            大模型失败会自动回退本地算法，不会卡死牌局。
          </p>

          <section className="llm-names" aria-label="玩家名称">
            <h3 className="llm-section__title">玩家名称</h3>
            <div className="llm-form">
              <label className="llm-field">
                <span className="llm-field__label">你的名字</span>
                <input
                  type="text"
                  className="llm-input"
                  value={settings.humanName}
                  onChange={(event) => {
                    // 直接改 settings 的 humanName（不经过 updateLlmSeat）
                    onChange({ ...settings, humanName: event.target.value });
                  }}
                  placeholder="你"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              {Array.from({ length: MAX_LOCAL_BOTS }, (_item, index) => (
                <label className="llm-field" key={`bot-name-${index}`}>
                  <span className="llm-field__label">本地机器人{index + 1}</span>
                  <input
                    type="text"
                    className="llm-input"
                    value={settings.localBotNames[index] ?? ''}
                    onChange={(event) => onChange(setLocalBotName(settings, index, event.target.value))}
                    placeholder={DEFAULT_LOCAL_BOT_NAMES[index] ?? `机器人${index + 1}`}
                    spellCheck={false}
                    autoComplete="off"
                  />
                </label>
              ))}
            </div>
            <p className="llm-names__hint">
              当前会有 {localBotCount} 个本地算法机器人入座，名称按上面的顺序取用；不足时用默认名。
            </p>
          </section>

          <section className="llm-names" aria-label="神态语句开关">
            <h3 className="llm-section__title">表现</h3>
            <label className="llm-switch llm-switch--block">
              <input
                type="checkbox"
                checked={settings.tableTalk}
                onChange={(event) => onChange({ ...settings, tableTalk: event.target.checked })}
              />
              <span>允许大模型玩家输出神态 / 语句（会在动作 JSON 里多一个 say 字段，额外消耗少量 token）</span>
            </label>
          </section>

          <div className="llm-cards">
            {settings.seats.map((seat) => {
              const test = seatTests[seat.slot] ?? EMPTY_TEST;
              const enableBlocked = !seat.enabled && enabledCount >= maxEnabled;
              return (
                <SeatCard
                  key={`llm-seat-${seat.slot}`}
                  seat={seat}
                  onPatch={(patch) => {
                    if (patch.enabled === true && enabledCount >= maxEnabled && !seat.enabled) {
                      setAppliedMessage(
                        `当前 ${playerCount} 人桌最多启用 ${maxEnabled} 个大模型玩家；请增加人数或取消其它座位。`,
                      );
                      return;
                    }
                    patchSeat(seat.slot, patch);
                    setAppliedMessage(null);
                  }}
                  onRemove={() => {
                    onChange(removeLlmSeat(settings, seat.slot));
                    setAppliedMessage(null);
                  }}
                  canRemove={settings.seats.length > 1}
                  enableBlocked={enableBlocked}
                  test={test}
                  onTest={() => {
                    void handleTestSeat(seat);
                  }}
                  onClearMemory={() => {
                    clearHandMemories(seat.slot);
                    setMemoryVersion((value) => value + 1);
                  }}
                />
              );
            })}
          </div>

          <div className="llm-cards__actions">
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => {
                onChange(addLlmSeat(settings));
                setAppliedMessage(null);
              }}
              disabled={!canAddSeat}
            >
              + 添加一个大模型玩家
            </button>
            <span className="llm-cards__hint">
              最多 {MAX_LLM_SEATS} 个；实际入座数还受上方「人数」限制。
            </span>
          </div>

          <section className="llm-detect" aria-label="扫描本机模型服务">
            <div className="llm-detect__head">
              <div>
                <h3 className="llm-detect__title">本机模型自动探测</h3>
                <p className="llm-detect__hint">
                  并行扫描常见本地服务端口（{LLM_PROBE_PORTS_TEXT}）上的 Ollama / LM Studio / vLLM /
                  llama.cpp，自动读取模型名称并可一键新增玩家。浏览器直连本地服务需要服务端允许 CORS。
                </p>
              </div>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => {
                  void handleDetect();
                }}
                disabled={detecting}
              >
                {detecting ? '正在扫描本机模型…' : '重新扫描本机模型'}
              </button>
            </div>

            {detectError && (
              <div className="llm-detect__error" role="alert">
                扫描失败：{detectError}
              </div>
            )}
            {!detecting && detectedServices && detectedServices.length === 0 && (
              <div className="llm-detect__empty" role="status">
                <strong>暂未发现可访问的本地模型服务。</strong>
                <span>
                  请先启动 Ollama / LM Studio 等本地服务，并允许跨域（Ollama 设置{' '}
                  <code>OLLAMA_ORIGINS=*</code>；LM Studio 开启 CORS）后重新扫描；也可以在下方手动填写
                  Base URL。外部接口直接填它的地址。
                </span>
              </div>
            )}
            {detecting && (
              <div className="llm-detect__loading" role="status">
                正在并行探测 {LLM_PROBE_PORTS_TEXT} 等端口…
              </div>
            )}
            {!detecting && detectedServices && detectedServices.length > 0 && (
              <div className="llm-detect__results">
                <p className="llm-detect__summary">
                  发现 <strong>{detectedServices.length}</strong> 个服务、<strong>{detectedModelCount}</strong>{' '}
                  个模型：
                </p>
                {detectedServices.map((service) => (
                  <div className="llm-detect__service" key={service.port}>
                    <div className="llm-detect__service-head">
                      <strong>{service.label}</strong>
                      <code>{service.rootUrl}</code>
                      <span>{service.models.length} 个模型</span>
                    </div>
                    <ul className="llm-detect__models">
                      {service.models.map((model) => (
                        <li className="llm-detect__model" key={`${service.port}-${model}`}>
                          <code>{model}</code>
                          <button
                            type="button"
                            className="quick-button"
                            onClick={() => applyDetectedModel(service, model)}
                            disabled={!canAddSeat}
                          >
                            新增大模型玩家并填入
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
            {appliedMessage && (
              <div className="llm-detect__applied" role="status">
                {appliedMessage}
              </div>
            )}
          </section>

          <section className="advisor-settings" aria-label="AI 军师设置">
            <div className="llm-detect__head">
              <div>
                <h3 className="llm-detect__title">AI 军师（人类玩家专用）</h3>
                <p className="llm-detect__hint">
                  在牌局里随时开关；只在点击「分析当前局势」或发送消息时调用，中文回答。
                  它看不到对手底牌，只根据公开信息与你的底牌分析。可以接与牌桌 AI 不同的模型。
                </p>
              </div>
              <label className="llm-switch">
                <input
                  type="checkbox"
                  checked={advisor.enabled}
                  onChange={(event) =>
                    onChange(updateAdvisorSettings(settings, { enabled: event.target.checked }))
                  }
                />
                <span>启用军师面板</span>
              </label>
            </div>

            <div className="llm-form">
              <label className="llm-field llm-field--wide">
                <span className="llm-field__label">Base URL（OpenAI 兼容）</span>
                <input
                  type="text"
                  className="llm-input"
                  value={advisor.baseUrl}
                  onChange={(event) => onChange(updateAdvisorSettings(settings, { baseUrl: event.target.value }))}
                  placeholder="http://127.0.0.1:11434/v1"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <label className="llm-field">
                <span className="llm-field__label">模型名</span>
                <input
                  type="text"
                  className="llm-input"
                  value={advisor.model}
                  onChange={(event) => onChange(updateAdvisorSettings(settings, { model: event.target.value }))}
                  placeholder="qwen2.5:7b"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <label className="llm-field">
                <span className="llm-field__label">API Key（可选）</span>
                <input
                  type="password"
                  className="llm-input"
                  value={advisor.apiKey}
                  onChange={(event) => onChange(updateAdvisorSettings(settings, { apiKey: event.target.value }))}
                  placeholder="本地通常留空"
                  autoComplete="new-password"
                />
              </label>
              <label className="llm-field">
                <span className="llm-field__label">温度（0–2）</span>
                <input
                  type="number"
                  className="llm-input"
                  min={0}
                  max={2}
                  step={0.1}
                  value={advisor.temperature}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value)) {
                      onChange(updateAdvisorSettings(settings, { temperature: value }));
                    }
                  }}
                />
              </label>
              <label className="llm-field">
                <span className="llm-field__label">超时（毫秒）</span>
                <input
                  type="number"
                  className="llm-input"
                  min={1000}
                  max={300000}
                  step={1000}
                  value={advisor.timeoutMs}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value)) {
                      onChange(updateAdvisorSettings(settings, { timeoutMs: value }));
                    }
                  }}
                />
              </label>
              <label className="llm-field">
                <span className="llm-field__label">输出 token 上限</span>
                <input
                  type="number"
                  className="llm-input"
                  min={32}
                  max={32000}
                  step={100}
                  value={advisor.maxTokens}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value)) {
                      onChange(updateAdvisorSettings(settings, { maxTokens: value }));
                    }
                  }}
                />
              </label>
            </div>

            <div className="llm-card__actions">
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => {
                  void handleTestAdvisor();
                }}
                disabled={advisorTest.loading || !advisorConfigured}
              >
                {advisorTest.loading ? '正在测试…' : '测试军师连接'}
              </button>
              <span className="llm-memory-count">中文输出 · 仅按需调用</span>
            </div>
            <ConnectionLine test={advisorTest} />
          </section>

          <section className="llm-help" aria-label="本地服务说明">
            <h3 className="llm-help__title">本地服务与跨域</h3>
            <ul className="llm-help__list">
              <li>
                <strong>Ollama：</strong>先设置环境变量 <code>OLLAMA_ORIGINS=*</code>（Windows 可执行{' '}
                <code>setx OLLAMA_ORIGINS *</code>），重启 Ollama；Base URL 用{' '}
                <code>http://127.0.0.1:11434/v1</code>。
              </li>
              <li>
                <strong>LM Studio：</strong>启动 Local Server 后在服务器设置中开启 CORS；Base URL 用{' '}
                <code>http://127.0.0.1:1234/v1</code>。
              </li>
              <li>
                <strong>外部接口：</strong>任意 OpenAI 兼容接口都可填 Base URL + 模型名 + API Key；
                浏览器直连需要对方允许 CORS。
              </li>
              <li>
                <strong>思考型模型：</strong>若测试连接成功但牌局里提示“返回空内容”，通常是思考 token
                用尽；可换非思考模型，或调大该座位的「输出 token 上限」。
              </li>
              <li>
                <strong>生效时机：</strong>座位、名称、人物设定在点「新局 / 开始对局」后生效；
                对局中修改 URL / 模型 / 神态开关会在下一次调用生效。
              </li>
            </ul>
            <p className="llm-help__note">
              设置保存在本机浏览器（localStorage），不会上传 API Key 或对局数据。每个模型的对局记忆最多保留
              80 条，可在卡片上单独清空。
            </p>
          </section>
        </div>

        <footer className="modal__footer">
          <span>提示词使用精简英文与短键 JSON，减少 token 消耗。</span>
          <button type="button" className="btn btn--secondary btn--sm" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}
