/**
 * 翻前蓝图加载入口：导入离线生成的 JSON，并注册到 preflop 求解器。
 * 单独成文件，避免 aiPlayer 直接依赖 JSON 形状。
 */
import raw from '../data/preflop-blueprint.json';
import { setPreflopBlueprint, type PreflopBlueprint } from './preflop';

export const PREFLOP_BLUEPRINT = raw as unknown as PreflopBlueprint;

setPreflopBlueprint(PREFLOP_BLUEPRINT);
