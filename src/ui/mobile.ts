/**
 * 手机 / 平板 / 桌面布局判定（纯函数，便于单元测试）。
 *
 * CSS 里用媒体查询做样式切换；这里只负责 JS 侧需要知道布局的场景：
 * - 手机端默认把设置栏收进抽屉，避免牌桌与操作区被挤出首屏；
 * - 横屏手机可以用更紧凑的牌桌高度。
 */
import { useEffect, useState } from 'react';

export type LayoutMode = 'phone' | 'tablet' | 'desktop';

/** 与 styles.css 中的手机断点保持一致（≤ 820px 视为手机）。 */
export const PHONE_MAX_WIDTH = 820;
/** 与 styles.css 中的平板断点保持一致（≤ 1180px 视为平板）。 */
export const TABLET_MAX_WIDTH = 1180;

export function layoutModeForWidth(width: number): LayoutMode {
  if (!Number.isFinite(width) || width <= 0) return 'desktop';
  if (width <= PHONE_MAX_WIDTH) return 'phone';
  if (width <= TABLET_MAX_WIDTH) return 'tablet';
  return 'desktop';
}

/** 手机端设置栏默认收起（点顶部「设置」按钮展开成抽屉）。 */
export function settingsCollapsedByDefault(mode: LayoutMode): boolean {
  return mode === 'phone';
}

/** 横屏小屏设备：牌桌需要更矮的舞台高度。 */
export function isCompactLandscape(width: number, height: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  return height <= 560 && width > height;
}

/** 监听窗口宽度变化，返回当前布局档位（用于手机端默认收起设置栏）。 */
export function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(() =>
    typeof window === 'undefined' ? 'desktop' : layoutModeForWidth(window.innerWidth),
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const update = () => setMode(layoutModeForWidth(window.innerWidth));
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  return mode;
}

/** 是否运行在 Capacitor 原生壳（安卓 APK）里。 */
export function isCapacitorNative(win: unknown = typeof window === 'undefined' ? undefined : window): boolean {
  const capacitor = (win as { Capacitor?: { isNativePlatform?: () => boolean } } | undefined)?.Capacitor;
  if (!capacitor || typeof capacitor.isNativePlatform !== 'function') return false;
  return Boolean(capacitor.isNativePlatform());
}
