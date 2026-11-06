import { describe, expect, it } from 'vitest';
import {
  PHONE_MAX_WIDTH,
  TABLET_MAX_WIDTH,
  isCapacitorNative,
  isCompactLandscape,
  layoutModeForWidth,
  settingsCollapsedByDefault,
} from '../ui/mobile';

describe('手机端布局判定', () => {
  it('桌面宽度判为 desktop', () => {
    expect(layoutModeForWidth(1440)).toBe('desktop');
    expect(layoutModeForWidth(1920)).toBe('desktop');
  });

  it('平板宽度判为 tablet', () => {
    expect(layoutModeForWidth(TABLET_MAX_WIDTH)).toBe('tablet');
    expect(layoutModeForWidth(900)).toBe('tablet');
    expect(layoutModeForWidth(PHONE_MAX_WIDTH + 1)).toBe('tablet');
  });

  it('手机宽度判为 phone', () => {
    expect(layoutModeForWidth(390)).toBe('phone');
    expect(layoutModeForWidth(360)).toBe('phone');
    expect(layoutModeForWidth(PHONE_MAX_WIDTH)).toBe('phone');
  });

  it('非法宽度回退桌面布局，避免误把桌面切成手机样式', () => {
    expect(layoutModeForWidth(0)).toBe('desktop');
    expect(layoutModeForWidth(-1)).toBe('desktop');
    expect(layoutModeForWidth(Number.NaN)).toBe('desktop');
  });

  it('断点常量：手机断点小于平板断点', () => {
    expect(PHONE_MAX_WIDTH).toBeLessThan(TABLET_MAX_WIDTH);
    expect(PHONE_MAX_WIDTH).toBe(820);
  });

  it('只有手机端默认收起设置栏', () => {
    expect(settingsCollapsedByDefault('phone')).toBe(true);
    expect(settingsCollapsedByDefault('tablet')).toBe(false);
    expect(settingsCollapsedByDefault('desktop')).toBe(false);
  });

  it('横屏小屏（高度 ≤ 560 且宽 > 高）判为紧凑横屏', () => {
    expect(isCompactLandscape(844, 390)).toBe(true);
    expect(isCompactLandscape(390, 844)).toBe(false);
    expect(isCompactLandscape(1440, 900)).toBe(false);
  });

  it('非法尺寸不会误判为紧凑横屏', () => {
    expect(isCompactLandscape(Number.NaN, 390)).toBe(false);
    expect(isCompactLandscape(844, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('安卓壳判定', () => {
  it('普通浏览器（没有 Capacitor 对象）返回 false', () => {
    expect(isCapacitorNative(undefined)).toBe(false);
    expect(isCapacitorNative({})).toBe(false);
    expect(isCapacitorNative({ window: {} })).toBe(false);
  });

  it('在 Capacitor 原生壳里返回 true', () => {
    expect(isCapacitorNative({ Capacitor: { isNativePlatform: () => true } })).toBe(true);
  });

  it('Capacitor 存在但不在原生平台时返回 false', () => {
    expect(isCapacitorNative({ Capacitor: { isNativePlatform: () => false } })).toBe(false);
  });

  it('isNativePlatform 不是函数时安全返回 false', () => {
    expect(isCapacitorNative({ Capacitor: { isNativePlatform: 'yes' } })).toBe(false);
  });
});
