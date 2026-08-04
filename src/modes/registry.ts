import type { AgentMode } from './types';

/**
 * modes/registry.ts — 模式注册中心
 *
 * 全局单例：注册、查询、激活。CLIAAgent 通过本模块读取当前模式策略：
 * - prompt 注入（agent.ts 拼接 systemPrompt）
 * - 工具门（executeToolCalls 执行前拦截）
 * - 前置 hook（messageHook 链组合）
 */

const modes = new Map<string, AgentMode>();
let activeNames: string[] = [];

/** 注册一个模式（同名覆盖） */
export function registerMode(mode: AgentMode): void {
  modes.set(mode.name, mode);
}

/** 按名称获取模式 */
export function getMode(name: string): AgentMode | undefined {
  return modes.get(name);
}

/** 列出所有已注册模式 */
export function listModes(): AgentMode[] {
  return [...modes.values()];
}

/**
 * 设置当前激活模式（default 表示清空）。
 * 支持多模式叠加（传入多个名称）。
 */
export function setActiveModes(names: string[]): { ok: boolean; message: string } {
  const cleaned = names.filter((n) => n && n !== 'default');
  const unknown = cleaned.filter((n) => !modes.has(n));
  if (unknown.length > 0) {
    return { ok: false, message: `未知模式：${unknown.join('、')}（可用 /mode list 查看）` };
  }
  activeNames = cleaned;
  return { ok: true, message: describeActive() };
}

/** 追加激活模式（不替换已有，default 忽略） */
export function addActiveMode(name: string): { ok: boolean; message: string } {
  if (!name || name === 'default') return { ok: true, message: describeActive() };
  if (!modes.has(name)) return { ok: false, message: `未知模式：${name}` };
  if (!activeNames.includes(name)) activeNames.push(name);
  return { ok: true, message: describeActive() };
}

/** 移除某个激活模式 */
export function removeActiveMode(name: string): { ok: boolean; message: string } {
  activeNames = activeNames.filter((n) => n !== name);
  return { ok: true, message: describeActive() };
}

/** 当前激活模式列表（按激活顺序） */
export function getActiveModes(): AgentMode[] {
  return activeNames.map((n) => modes.get(n)).filter(Boolean) as AgentMode[];
}

/** 当前激活模式名称列表 */
export function getActiveModeNames(): string[] {
  return [...activeNames];
}

export function isActiveMode(name: string): boolean {
  return activeNames.includes(name);
}

/** 激活模式摘要（人读） */
export function describeActive(): string {
  if (activeNames.length === 0) return '当前模式：快速模式（default，无策略挂载）';
  const labels = getActiveModes().map((m) => `${m.icon ?? ''}${m.label}`).join(' + ');
  return `当前模式：${labels}`;
}

/**
 * 工具门：检查工具在当前激活模式下是否允许执行。
 * - 无激活模式 → 全部放行
 * - 命中任一模式黑名单 → 拒绝（黑名单优先于白名单）
 * - 存在白名单模式：工具须命中至少一个白名单（并集语义，多模式叠加取宽松）
 */
export function checkToolGate(toolName: string): { allowed: boolean; reason?: string } {
  const actives = getActiveModes();
  if (actives.length === 0) return { allowed: true };

  for (const mode of actives) {
    if (mode.denyTools?.includes(toolName)) {
      return {
        allowed: false,
        reason: `⛔ 当前模式「${mode.label}」禁止调用工具 ${toolName}`,
      };
    }
  }

  const whitelisted = actives.filter((m) => m.allowTools && m.allowTools.length > 0);
  if (whitelisted.length > 0 && !whitelisted.some((m) => m.allowTools!.includes(toolName))) {
    const names = whitelisted.map((m) => `「${m.label}」`).join('、');
    return {
      allowed: false,
      reason: `⛔ 当前模式 ${names} 仅允许白名单工具，${toolName} 不在其中（可用 /mode default 退出模式）`,
    };
  }

  return { allowed: true };
}

/**
 * 按激活模式过滤工具集，返回过滤后的副本（原对象不变）。
 * 语义与 checkToolGate 一致：无激活模式原样返回；仅黑名单模式剔除黑名单；
 * 存在白名单模式时只保留白名单并集内的工具（同时剔除黑名单）。
 * 供 agent 层在 streamText 前过滤模型可见的工具 schema，
 * 让被禁工具连 prompt 都进不去，而非等执行时才被拦截。
 */
export function filterToolsForActiveModes<T extends Record<string, any>>(toolSet: T): T {
  const actives = getActiveModes();
  if (actives.length === 0) return toolSet;
  const out: Record<string, any> = {};
  for (const [name, t] of Object.entries(toolSet)) {
    if (checkToolGate(name).allowed) out[name] = t;
  }
  return out as T;
}




