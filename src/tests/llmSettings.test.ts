import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_LLM_SEATS } from '../game/types';
import {
  addLlmSeat,
  createDefaultLlmSettings,
  enabledLlmSeatConfigs,
  enabledLlmSlotCount,
  findEnabledLlmSlot,
  loadLlmSettings,
  localBotNamesFor,
  removeLlmSeat,
  resolvedHumanName,
  setLocalBotName,
  toAdvisorConfig,
  toLlmSeatConfig,
  updateAdvisorSettings,
  updateLlmSeat,
  advisorReady,
} from '../ui/llmSettings';
import { LLM_SETTINGS_KEY } from '../ui/storage';

function installStorage(initial: Record<string, string> = {}): void {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AI 设置：默认值与多玩家管理', () => {
  it('默认 2 个未启用的大模型玩家、关闭神态语句与军师', () => {
    const settings = createDefaultLlmSettings();
    expect(settings.seats).toHaveLength(2);
    expect(settings.seats.every((seat) => !seat.enabled)).toBe(true);
    expect(settings.tableTalk).toBe(false);
    expect(settings.advisor.enabled).toBe(false);
    expect(settings.humanName).toBe('你');
    expect(settings.localBotNames).toHaveLength(5);
    expect(resolvedHumanName(settings)).toBe('你');
  });

  it('可以添加多个玩家（上限 MAX_LLM_SEATS），删除后自动重新编号', () => {
    let settings = createDefaultLlmSettings();
    while (settings.seats.length < MAX_LLM_SEATS) settings = addLlmSeat(settings);
    expect(settings.seats).toHaveLength(MAX_LLM_SEATS);
    expect(addLlmSeat(settings).seats).toHaveLength(MAX_LLM_SEATS);

    settings = removeLlmSeat(settings, 1);
    expect(settings.seats.map((seat) => seat.slot)).toEqual([1, 2, 3, 4]);
    expect(settings.seats[0].slot).toBe(1);
  });

  it('更新座位时对温度 / 超时 / token 上限做收敛', () => {
    let settings = createDefaultLlmSettings();
    settings = updateLlmSeat(settings, 1, { temperature: 9, timeoutMs: 10, maxTokens: 999_999 });
    const seat = settings.seats[0];
    expect(seat.temperature).toBe(2);
    expect(seat.timeoutMs).toBe(1000);
    expect(seat.maxTokens).toBe(32000);
  });

  it('已启用座位转换为引擎配置：包含人物设定 / token 上限 / 座位号', () => {
    let settings = createDefaultLlmSettings();
    settings = updateLlmSeat(settings, 1, { enabled: true, name: '阿尔法', persona: '紧凶' });
    settings = updateLlmSeat(settings, 2, { enabled: false });
    const configs = enabledLlmSeatConfigs(settings);
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      slot: 1,
      name: '阿尔法',
      persona: '紧凶',
      enabled: true,
    });
    expect(configs[0].maxTokens).toBe(1200);
    expect(enabledLlmSlotCount(settings)).toBe(1);
    expect(findEnabledLlmSlot(settings, 1)?.name).toBe('阿尔法');
    expect(findEnabledLlmSlot(settings, 3)).toBeUndefined();
    expect(toLlmSeatConfig(settings.seats[0]).persona).toBe('紧凶');
  });

  it('玩家名称：自定义本地机器人名、缺省回退默认名', () => {
    let settings = createDefaultLlmSettings();
    settings = setLocalBotName(settings, 0, '阿甲');
    settings = setLocalBotName(settings, 2, '阿丙');
    const names = localBotNamesFor(settings, 4);
    expect(names[0]).toBe('阿甲');
    expect(names[1]).toBe('小雅');
    expect(names[2]).toBe('阿丙');
    expect(names[3]).toBe('莉莉');
    settings = { ...settings, humanName: '  赌神  ' };
    expect(resolvedHumanName(settings)).toBe('赌神');
  });

  it('军师配置：启用开关、就绪判断与引擎配置', () => {
    let settings = createDefaultLlmSettings();
    expect(advisorReady(settings)).toBe(true);
    settings = updateAdvisorSettings(settings, { enabled: true, model: 'advisor-model', maxTokens: 600 });
    expect(settings.advisor.enabled).toBe(true);
    expect(toAdvisorConfig(settings)).toMatchObject({ model: 'advisor-model', maxTokens: 600 });
    settings = updateAdvisorSettings(settings, { baseUrl: '  ' });
    expect(advisorReady(settings)).toBe(false);
  });
});

describe('AI 设置：localStorage 持久化与旧版本迁移', () => {
  it('读写往返保持数据', () => {
    installStorage();
    let settings = createDefaultLlmSettings();
    settings = updateLlmSeat(settings, 1, { enabled: true, name: '保存测试' });
    settings = { ...settings, tableTalk: true, humanName: '我' };
    localStorage.setItem(LLM_SETTINGS_KEY, JSON.stringify(settings));
    const loaded = loadLlmSettings();
    expect(loaded.seats[0].name).toBe('保存测试');
    expect(loaded.seats[0].enabled).toBe(true);
    expect(loaded.tableTalk).toBe(true);
    expect(loaded.humanName).toBe('我');
  });

  it('旧格式（两个固定槽位 slots）自动迁移为动态 seats', () => {
    installStorage({
      [LLM_SETTINGS_KEY]: JSON.stringify({
        slots: [
          {
            slot: 2,
            enabled: true,
            name: '旧模型二',
            baseUrl: 'http://127.0.0.1:1234/v1',
            model: 'old-model',
            apiKey: 'k',
            temperature: 0.3,
            timeoutMs: 12000,
          },
          {
            slot: 1,
            enabled: false,
            name: '旧模型一',
            baseUrl: 'http://127.0.0.1:11434/v1',
            model: 'old-1',
          },
        ],
      }),
    });
    const loaded = loadLlmSettings();
    expect(loaded.seats).toHaveLength(2);
    expect(loaded.seats[0].name).toBe('旧模型一');
    expect(loaded.seats[0].enabled).toBe(false);
    expect(loaded.seats[1].name).toBe('旧模型二');
    expect(loaded.seats[1].enabled).toBe(true);
    expect(loaded.seats[1].timeoutMs).toBe(12000);
    expect(loaded.seats[1].persona).toBe('');
    expect(loaded.seats[1].maxTokens).toBe(1200);
  });

  it('损坏数据 / 缺失字段时回退默认值且不抛异常', () => {
    installStorage({ [LLM_SETTINGS_KEY]: '{not json' });
    expect(loadLlmSettings().seats).toHaveLength(2);
    vi.unstubAllGlobals();
    installStorage({
      [LLM_SETTINGS_KEY]: JSON.stringify({
        seats: [{ name: 123 }, null],
        advisor: 'bad',
        humanName: 42,
        localBotNames: 'bad',
      }),
    });
    const loaded = loadLlmSettings();
    expect(loaded.seats).toHaveLength(2);
    expect(loaded.seats[0].name).toBe('大模型①');
    expect(loaded.seats[0].model).toContain('qwen');
    expect(loaded.advisor.model).toBeTruthy();
    expect(loaded.humanName).toBe('你');
    expect(loaded.localBotNames).toHaveLength(5);
  });
});
