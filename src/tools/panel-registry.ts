/**
 * panel-registry.ts — TUI 右栏面板提供者注册表
 *
 * 供 inner_skills 或其他模块注册自定义右栏面板内容。
 * TermialUI 每次渲染面板时会调用所有已注册的提供者。
 */
import { stripAnsi, visibleWidth } from '../ui';

// ── 类型定义 ──

/** 面板渲染函数：接收面板内容宽度（不含边框），返回要显示的行 */
export type PanelRenderFn = (panelWidth: number) => string[];

export interface PanelProvider {
  /** 唯一标识，用于去重 */
  id: string;
  /** 渲染函数 */
  render: PanelRenderFn;
  /** 优先级（数字越大越靠前，默认 0） */
  priority?: number;
}

// ── ANSI 常量 ──
const FG_LB = '\x1b[38;2;112;128;144m';
const RESET = '\x1b[0m\x1b[38;2;0;0;0;48;2;245;245;245m';

// ── 注册表 ──
const providers: PanelProvider[] = [];

/** 注册一个面板提供者 */
export function registerPanelProvider(provider: PanelProvider): void {
  const idx = providers.findIndex(p => p.id === provider.id);
  if (idx !== -1) providers.splice(idx, 1);
  providers.push(provider);
  providers.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

/** 获取所有已注册的面板提供者（按优先级排序） */
export function getPanelProviders(): PanelProvider[] {
  return providers;
}

/** 移除指定 ID 的面板提供者 */
export function removePanelProvider(id: string): void {
  const idx = providers.findIndex(p => p.id === id);
  if (idx !== -1) providers.splice(idx, 1);
}

/** 清除所有面板提供者 */
export function clearPanelProviders(): void {
  providers.length = 0;
}

/**
 * 格式化面板内的一行内容（带左右边框，自动补齐空白）
 * 供 skill 的 panel.ts 渲染时使用
 */
export function formatPanelLine(pw: number, content: string): string {
  const plain = stripAnsi(content);
  const w = visibleWidth(plain);
  const pad = Math.max(0, pw - 4 - w);
  return `${FG_LB}│${RESET} ${content}${' '.repeat(pad)} ${FG_LB}│${RESET}`;
}

/** 生成面板分隔行（空行） */
export function panelEmptyLine(pw: number): string {
  return `${FG_LB}│${RESET}${' '.repeat(pw - 2)}${FG_LB}│${RESET}`;
}

/** 生成面板标题框 */
export function panelHeader(pw: number, title: string): string {
  const titleW = visibleWidth(title);
  const leftDash = Math.max(2, Math.floor((pw - 2 - titleW) / 2) - 1);
  const rightDash = pw - 2 - leftDash - titleW;
  const BOLD = '\x1b[1m';
  const DPURPLE = '\x1b[38;2;110;0;130m';
  return `${FG_LB}╭${'─'.repeat(leftDash)}${RESET}${BOLD}${DPURPLE}${title}${RESET}${FG_LB}${'─'.repeat(rightDash)}╮${RESET}`;
}

/** 生成面板底部边框 */
export function panelFooter(pw: number): string {
  return `${FG_LB}╰${'─'.repeat(pw - 2)}╯${RESET}`;
}
