/**
 * ui.ts — Ink 版 TerminalUI 转发薄壳
 *
 * 保持与旧版完全一致的对外接口（TerminalUI 类 / UIMessage 类型 / stripAnsi / visibleWidth），
 * 内部实现迁移到 src/ui-ink/（Ink + React 组件化渲染）。
 * 外部调用方（agent.ts / command / panel-registry / electron-bridge）无需任何改动。
 */
export { TerminalUI } from './ui-ink/TerminalUI';
export type { UIMessage } from './ui-ink/types';
export { stripAnsi, visibleWidth } from './ui-ink/utils';

