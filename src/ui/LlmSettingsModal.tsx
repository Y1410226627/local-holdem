/** 本地大模型机器人设置弹窗：两个槽位、连接测试、本机模型自动探测、对局记忆管理。 */
import { useEffect, useState } from 'react';
import type { LlmConnectionResult } from '../ai/llmBot';
import { testLlmConnection } from '../ai/llmBot';
import { clearHandMemories, memoryCount } from '../ai/llmMemory';
import { formatChips, getErrorMessage } from './format';
import {
  LLM_PROBE_PORTS_TEXT,
  detectLocalLlmServices,
  slotPatchFromDetectedModel,
  type DetectedLlmService,
} from './llmDetect';
import {
  LLM_SLOT_LABELS,
  enabledLlmSlotCount,
  getLlmSlot,
  llmSlotSummary,
  toLlmSeatConfig,
  updateLlmSlot,
  type LlmSettings,
  type LlmSlotSettings,
} from './llmSettings';

interface LlmSettingsModalProps {
  settings: LlmSettings;
  onChange: (next: LlmSettings) => void;
  onClose: () => void;
}

interface SlotCardProps {
  slot: LlmSlotSettings;
  onPatch: (patch: Partial<Omit<LlmSlotSettings, 'slot'>>) => void;
  onClearMemory: () => void;
}

function SlotCard({ slot, onPatch, onClearMemory }: SlotCardProps) {
  const [testing, setTesting] = useState(false);
  const [connection, setConnection] = useState<LlmConnectionResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const memory = memoryCount(slot.slot);

  const handleTest = async (): Promise<void> => {
    setTesting(true);
    setConnection(null);
    setTestError(null);
    try {
      const result = await testLlmConnection(toLlmSeatConfig(slot));
      setConnection(result);
    } catch (error) {
      setTestError(getErrorMessage(error));
    } finally {
      setTesting(false);
    }
  };

  const handleClear = (): void => {
    clearHandMemories(slot.slot);
    setTestError(null);
    onClearMemory();
  };

  return (
    <section
      className={`llm-card${slot.enabled ? ' llm-card--enabled' : ''}`}
      aria-label={`${LLM_SLOT_LABELS[slot.slot]}设置`}
    >
      <header className="llm-card__header">
        <div className="llm-card__title-row">
          <span className="llm-slot-badge">槽位 {slot.slot}</span>
          <h3 className="llm-card__title">{LLM_SLOT_LABELS[slot.slot]}</h3>
          <label className="llm-switch">
            <input
              type="checkbox"
              checked={slot.enabled}
              onChange={(event) => onPatch({ enabled: event.target.checked })}
            />
            <span>启用加入牌局</span>
          </label>
        </div>
        <p className="llm-card__summary">{llmSlotSummary(slot)}</p>
      </header>

      <div className="llm-form">
        <label className="llm-field">
          <span className="llm-field__label">显示名称</span>
          <input
            type="text"
            className="llm-input"
            value={slot.name}
            onChange={(event) => onPatch({ name: event.target.value })}
            placeholder={LLM_SLOT_LABELS[slot.slot]}
            spellCheck={false}
            autoComplete="off"
          />
        </label>

        <label className="llm-field llm-field--wide">
          <span className="llm-field__label">Base URL（OpenAI 兼容）</span>
          <input
            type="text"
            className="llm-input"
            value={slot.baseUrl}
            onChange={(event) => onPatch({ baseUrl: event.target.value })}
            placeholder={
              slot.slot === 1 ? 'http://127.0.0.1:11434/v1' : 'http://127.0.0.1:1234/v1'
            }
            spellCheck={false}
            autoComplete="off"
          />
        </label>

        <label className="llm-field">
          <span className="llm-field__label">模型名</span>
          <input
            type="text"
            className="llm-input"
            value={slot.model}
            onChange={(event) => onPatch({ model: event.target.value })}
            placeholder={slot.slot === 1 ? 'qwen2.5:7b' : 'local-model'}
            spellCheck={false}
            autoComplete="off"
          />
        </label>

        <label className="llm-field">
          <span className="llm-field__label">API Key（可选）</span>
          <input
            type="password"
            className="llm-input"
            value={slot.apiKey}
            onChange={(event) => onPatch({ apiKey: event.target.value })}
            placeholder="本地服务通常留空"
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
            value={slot.temperature}
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
            value={slot.timeoutMs}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isFinite(value)) onPatch({ timeoutMs: value });
            }}
          />
        </label>
      </div>

      <div className="llm-card__actions">
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          onClick={() => {
            void handleTest();
          }}
          disabled={testing}
        >
          {testing ? '正在测试连接…' : '测试连接'}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={handleClear}>
          清空该模型对局记忆
        </button>
        <span className="llm-memory-count">
          已记录 {formatChips(memory)} 条
        </span>
      </div>

      {testing && (
        <div className="llm-test llm-test--loading" role="status">
          正在请求本地模型服务，请稍候…
        </div>
      )}
      {!testing && connection?.ok && (
        <div className="llm-test llm-test--ok" role="status">
          连接成功 · 延迟 {connection.latencyMs ?? '—'}ms
          {connection.sample ? ` · 样例：${connection.sample}` : ''}
        </div>
      )}
      {!testing && connection && !connection.ok && (
        <div className="llm-test llm-test--error" role="alert">
          连接失败：{connection.message}
        </div>
      )}
      {!testing && testError && (
        <div className="llm-test llm-test--error" role="alert">
          连接失败：{testError}
        </div>
      )}
    </section>
  );
}

export function LlmSettingsModal({ settings, onChange, onClose }: LlmSettingsModalProps) {
  const [, setMemoryVersion] = useState(0);
  const enabledCount = enabledLlmSlotCount(settings);
  const [detecting, setDetecting] = useState(false);
  const [detectedServices, setDetectedServices] = useState<DetectedLlmService[] | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [appliedMessage, setAppliedMessage] = useState<string | null>(null);

  const patchSlot = (slot: 1 | 2, patch: Partial<Omit<LlmSlotSettings, 'slot'>>): void => {
    onChange(updateLlmSlot(settings, slot, patch));
  };

  const handleDetect = async (): Promise<void> => {
    setDetecting(true);
    setDetectError(null);
    setAppliedMessage(null);
    try {
      const services = await detectLocalLlmServices();
      setDetectedServices(services);
    } catch (error) {
      setDetectError(getErrorMessage(error));
    } finally {
      setDetecting(false);
    }
  };

  // 打开设置时自动扫描一次，方便用户确认本机模型服务与模型名。
  useEffect(() => {
    void handleDetect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyDetectedModel = (
    service: DetectedLlmService,
    model: string,
    slot: 1 | 2,
  ): void => {
    patchSlot(slot, slotPatchFromDetectedModel(service, model));
    setAppliedMessage(
      `已填入${LLM_SLOT_LABELS[slot]}：${model}（${service.baseUrl}）。请点「测试连接」确认后勾选「启用加入牌局」。`,
    );
  };

  const detectedModelCount =
    detectedServices?.reduce((sum, service) => sum + service.models.length, 0) ?? 0;

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

  const handleClearMemory = (): void => setMemoryVersion((value) => value + 1);

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
            <p className="modal__eyebrow">本地大模型 · 已启用 {enabledCount} / 2</p>
            <h2 className="modal__title" id="llm-settings-title">
              大模型机器人设置
            </h2>
            <p className="modal__subtitle">
              仅调用你配置的本地 OpenAI 兼容服务；修改后点设置栏「新局」重新入座。
            </p>
          </div>
          <button type="button" className="modal__close" onClick={onClose} aria-label="关闭大模型设置">
            ×
          </button>
        </header>

        <div className="llm-modal__body">
          <p className="llm-modal__intro">
            两个槽位可以分别启用一个本地大模型机器人。启用后，2–6 人桌会优先把它们安排在你的下家；
            同桌最多 2 个。模型只会收到公开信息与自己的底牌，失败时自动回退本地算法，不会卡死牌局。
          </p>

          <section className="llm-detect" aria-label="扫描本机模型服务">
            <div className="llm-detect__head">
              <div>
                <h3 className="llm-detect__title">本机模型自动探测</h3>
                <p className="llm-detect__hint">
                  并行扫描常见本地服务端口（{LLM_PROBE_PORTS_TEXT}）上的 Ollama / LM Studio / vLLM /
                  llama.cpp，自动读取模型名称并一键填入槽位。浏览器直连本地服务需要服务端允许 CORS。
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
                  Base URL。若服务不是运行在本机，请直接填写它的地址。
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
                  个模型，可直接填入槽位：
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
                            onClick={() => applyDetectedModel(service, model, 1)}
                          >
                            填入槽位①
                          </button>
                          <button
                            type="button"
                            className="quick-button"
                            onClick={() => applyDetectedModel(service, model, 2)}
                          >
                            填入槽位②
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

          <div className="llm-cards">
            {([1, 2] as const).map((slotNumber) => {
              const slot = getLlmSlot(settings, slotNumber);
              return (
                <SlotCard
                  key={slot.slot}
                  slot={slot}
                  onPatch={(patch) => patchSlot(slot.slot, patch)}
                  onClearMemory={handleClearMemory}
                />
              );
            })}
          </div>

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
                <strong>人数限制：</strong>2 人桌最多启用 1 个大模型；多人桌最多 2 个。人数不足时会给出中文提示，
                不会崩溃。
              </li>
              <li>
                <strong>生效时机：</strong>座位与名称在点「新局 / 开始对局」后生效；对局中修改 URL / 模型会用于下一次调用。
              </li>
            </ul>
            <p className="llm-help__note">
              测试连接失败时请检查服务是否启动、Base URL 是否包含正确的端口与 /v1 路径，以及上面提到的 CORS 设置。
              错误信息会完整显示在槽位卡片下方。
            </p>
          </section>
        </div>

        <footer className="modal__footer">
          <span>设置保存在本机浏览器（localStorage）；不会上传 API Key 或对局数据。</span>
          <button type="button" className="btn btn--secondary btn--sm" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}
