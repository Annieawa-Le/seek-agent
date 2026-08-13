import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { registerSkillTranslations } from '../assets/tool-translations';
import { initializeMCP } from '../mcp';
import { registerPanelProvider } from './panel-registry';
// ── 核心工具（硬编码） ──
import {
  deskAddTool, deskListTool, deskRemoveTool, deskClearTool,
} from './ref-desk';
import { readFileTool, readNumline, scanFileTool } from './read-file';
import { executeCommandTool } from './execute-command';
import { taskExecuteTool, taskSwitchTool, taskListTool, taskKillTool } from './task-runner';
import {
  memoryFocus, memoryShorten,
  memoryAdd, memoryUpdate, memoryTouch, memoryRemove, memoryList,
  memoryRemember, memoryRecall, memoryClear, memoryStats,
} from './memory';
import { searchAllFile, searchSubFile, searchDirectory, searchContent } from './search-files';
import { createFile, addPatch, delPatch, modifyPatch, replaceFile, undoPatch, historyPatch } from './file-manipulation';
import { replaceStrTool } from './replace-str';
import { worklogRecallTool, workRecallTool } from './worklog-tools';
import { createTodo, finishStep, finishToStep, undoStep, rerollStep, delStep, readTodo, delTodo, activeTodo } from './todo';
import { toolCache } from './tool-cache';
import { collabSendTool } from './collab';
import { alarmSetTool, alarmCancelTool, alarmListTool } from './alarm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── 包装参数解包兼容 ──
// 模型偶尔会把工具参数包进 _raw / input / args 等包装键（训练分布中常见的工具调用格式漂移）。
// AI SDK 对非法参数会降级返回原始 JSON 解析结果（保留包装键），
// wrapTool 在 execute 入口统一解包为扁平参数，让这种调用正常执行而非报错。
import { unwrapToolArgs } from './unwrap-args';
export { unwrapToolArgs, WRAP_KEYS } from './unwrap-args';

// ── 工具缓存包裹 ──
function wrapTool(name: string, t: any) {
  if (!t?.execute) return t;
  const wrappedExecute = async (args: any, context?: any) => {
    return t.execute(unwrapToolArgs(args), context);
  };
  return { ...t, execute: toolCache.wrap(name, wrappedExecute) };
}

/**
 * 动态导入模块，自动处理 .ts（开发）/.js（打包）扩展名的差异
 */
async function tryImport(basePath: string): Promise<any> {
  const ts = Date.now();
  // 先试 .ts（开发模式）
  try {
    const tsUrl = pathToFileURL(basePath + '.ts').href + `?t=${ts}`;
    return await import(tsUrl);
  } catch {
    // 再试 .js（打包模式）
    try {
      const jsUrl = pathToFileURL(basePath + '.js').href + `?t=${ts}`;
      return await import(jsUrl);
    } catch {
      throw new Error(`无法加载模块: ${basePath}`);
    }
  }
}


// ── 核心工具表 ──
const coreTools = {
  read_file: wrapTool('read_file', readFileTool),
  read_lines: wrapTool('read_lines', readNumline),
  scan_file: wrapTool('scan_file', scanFileTool),
  execute_command: wrapTool('execute_command', executeCommandTool),
  search_all_file: wrapTool('search_all_file', searchAllFile),
  search_sub_file: wrapTool('search_sub_file', searchSubFile),
  search_directory: wrapTool('search_directory', searchDirectory),
  search_content: wrapTool('search_content', searchContent),
  create_file: wrapTool('create_file', createFile),
  replace_file: wrapTool('replace_file', replaceFile),
  add_patch: wrapTool('add_patch', addPatch),
  del_patch: wrapTool('del_patch', delPatch),
  modify_patch: wrapTool('modify_patch', modifyPatch),
  undo_patch: wrapTool('undo_patch', undoPatch),
  history_patch: wrapTool('history_patch', historyPatch),
  replace_str: wrapTool('replace_str', replaceStrTool),
  // 参考桌面管理
  desk_add: wrapTool('desk_add', deskAddTool),
  desk_list: wrapTool('desk_list', deskListTool),
  desk_remove: wrapTool('desk_remove', deskRemoveTool),
  desk_clear: wrapTool('desk_clear', deskClearTool),
  // 后台任务管理（并行/后台跑命令）
  task_execute: wrapTool('task_execute', taskExecuteTool),
  task_switch: wrapTool('task_switch', taskSwitchTool),
  task_list: wrapTool('task_list', taskListTool),
  task_kill: wrapTool('task_kill', taskKillTool),
  // 待办事项管理
  create_todo: wrapTool('create_todo', createTodo),
  finish_step: wrapTool('finish_step', finishStep),
  finish_to_step: wrapTool('finish_to_step', finishToStep),
  undo_step: wrapTool('undo_step', undoStep),
  reroll_step: wrapTool('reroll_step', rerollStep),
  del_step: wrapTool('del_step', delStep),
  read_todo: wrapTool('read_todo', readTodo),
  del_todo: wrapTool('del_todo', delTodo),
  active_todo: wrapTool('active_todo', activeTodo),
  // 上下文记忆管理
  memory_focus: wrapTool('memory_focus', memoryFocus),
  // 对话记忆（双层记忆：工作记忆 + 长期记忆）
  memory_add: wrapTool('memory_add', memoryAdd),
  memory_update: wrapTool('memory_update', memoryUpdate),
  memory_touch: wrapTool('memory_touch', memoryTouch),
  memory_remove: wrapTool('memory_remove', memoryRemove),
  memory_list: wrapTool('memory_list', memoryList),
  memory_remember: wrapTool('memory_remember', memoryRemember),
  memory_recall: wrapTool('memory_recall', memoryRecall),
  memory_clear: wrapTool('memory_clear', memoryClear),
  memory_stats: wrapTool('memory_stats', memoryStats),
  memory_shorten: wrapTool('memory_shorten', memoryShorten),
  // Worklog 归档召回（记忆消退路径）
  worklog_recall: wrapTool('worklog_recall', worklogRecallTool),
  work_recall: wrapTool('work_recall', workRecallTool),
  // 跨会话协作
  collab_send: wrapTool('collab_send', collabSendTool),
  // 闹钟（长时间等待提醒，到点注入 user 消息打断）
  alarm_set: wrapTool('alarm_set', alarmSetTool),
  alarm_cancel: wrapTool('alarm_cancel', alarmCancelTool),
  alarm_list: wrapTool('alarm_list', alarmListTool),
};

// ── 技能→工具映射（用于卸载） ──
let skillToolMap: Record<string, string[]> = {};

// ── 懒加载技能注册表 ──
// 用于 always_detectable: false 的技能：prompt-get 工具始终可见，
// 其余工具在 prompt-get 被调用后静默注册到 toolsContainer
interface LazySkillEntry {
  tools: Record<string, any>;
  translations?: Record<string, any>;
  panel?: { id: string; render: any; priority?: number };
}
const lazySkillRegistry = new Map<string, LazySkillEntry>();

/**
 * 激活一个懒加载技能：将延迟注册的工具从 lazySkillRegistry 移到 toolsContainer。
 * 被 prompt-get 工具的 execute 包裹自动调用，也可手动调用。
 */
function activateLazySkill(skillName: string): boolean {
  const entry = lazySkillRegistry.get(skillName);
  if (!entry) return false;

  // 注册延迟工具到 toolsContainer
  for (const [name, toolImpl] of Object.entries(entry.tools)) {
    if (name in coreTools || name in toolsContainer) {
      continue;
    }
    toolsContainer[name] = wrapTool(name, toolImpl);
    (skillToolMap[skillName] ??= []).push(name);
  }

  // 注册翻译（仅非 prompt-get 部分，prompt-get 的已注册过）
  if (entry.translations) {
    const deferredTranslations: Record<string, any> = {};
    for (const [key, val] of Object.entries(entry.translations)) {
      if (!key.endsWith('-prompt-get')) {
        deferredTranslations[key] = val;
      }
    }
    if (Object.keys(deferredTranslations).length > 0) {
      registerSkillTranslations(deferredTranslations);
    }
  }

  // 注册面板
  if (entry.panel) {
    registerPanelProvider(entry.panel);
  }

  lazySkillRegistry.delete(skillName);
  return true;
}

// ── 自动扫描加载 inner_skills ──
async function loadInnerSkills(): Promise<Record<string, any>> {
  const skillsDir = path.join(__dirname, 'inner_skills');
  const allTools: Record<string, any> = {};

  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    // inner_skills 目录不存在时静默跳过
    return allTools;
  }

  const dirs = entries.filter(e => e.isDirectory());

  for (const dir of dirs) {
    const skillPath = path.join(skillsDir, dir.name);
    const enablePath = path.join(skillPath, 'enable.json');

    // 读取 enable.json 判断是否启用
    let config: { enable: boolean; always_detectable?: boolean };
    try {
      const configRaw = await readFile(enablePath, 'utf-8');
      config = JSON.parse(configRaw);
      if (!config.enable) continue;
    } catch {
      // 没有 enable.json 或读取失败 → 跳过此技能
      continue;
    }

    // always_detectable 默认 true（向后兼容）
    const alwaysDetectable = config.always_detectable !== false;

    // 动态加载技能模块
    try {
      const skillModule = await tryImport(path.join(skillPath, 'index'));
      const skillTools: Record<string, any> = skillModule.default || skillModule;

      // 加载翻译
      let translations: Record<string, any> | undefined;
      try {
        const transModule = await tryImport(path.join(skillPath, 'translation'));
        translations = transModule.default || transModule;
      } catch { /* 没有翻译文件 */ }

      // 加载面板
      let panelExport: any;
      try {
        const panelModule = await tryImport(path.join(skillPath, 'panel'));
        panelExport = panelModule.default || panelModule;
      } catch { /* 没有面板文件 */ }

      if (!alwaysDetectable) {
        // ── 懒加载模式：只注册 prompt-get 工具，其余存延迟注册表 ──
        const promptGetTools: Record<string, any> = {};
        const deferredTools: Record<string, any> = {};

        for (const [name, toolImpl] of Object.entries(skillTools)) {
          if (name.endsWith('-prompt-get')) {
            // 包裹 execute：调用后激活延迟工具
            if (toolImpl.execute) {
              const originalExecute = toolImpl.execute;
              toolImpl.execute = async (args: any, context?: any) => {
                const result = await originalExecute.call(toolImpl, args, context);
                activateLazySkill(dir.name);
                return result;
              };
            }
            promptGetTools[name] = toolImpl;
            (skillToolMap[dir.name] ??= []).push(name);
          } else {
            deferredTools[name] = toolImpl;
          }
        }

        // 注册 prompt-get 工具到 allTools
        for (const [name, toolImpl] of Object.entries(promptGetTools)) {
          if (name in allTools || name in coreTools) {
            console.warn(`⚠ inner_skill "${dir.name}" 的工具 "${name}" 与已有工具重名，已跳过`);
            continue;
          }
          allTools[name] = wrapTool(name, toolImpl);
        }

        // 仅注册 prompt-get 工具的翻译
        if (translations) {
          const promptGetTranslations: Record<string, any> = {};
          for (const key of Object.keys(translations)) {
            if (key.endsWith('-prompt-get')) {
              promptGetTranslations[key] = translations[key];
            }
          }
          if (Object.keys(promptGetTranslations).length > 0) {
            registerSkillTranslations(promptGetTranslations);
          }
        }

        // 存储延迟工具到懒加载注册表
        lazySkillRegistry.set(dir.name, {
          tools: deferredTools,
          translations,
          panel: panelExport
            ? (typeof panelExport === 'function'
              ? { id: dir.name, render: panelExport }
              : panelExport.render
                ? { id: dir.name, render: panelExport.render, priority: panelExport.priority ?? 0 }
                : undefined)
            : undefined,
        });

        continue; // 跳过下面的正常注册流程
      }

      // ── 正常注册（always_detectable: true） ──
      for (const [name, toolImpl] of Object.entries(skillTools)) {
        if (name in allTools || name in coreTools) {
          console.warn(`⚠ inner_skill "${dir.name}" 的工具 "${name}" 与已有工具重名，已跳过`);
          continue;
        }
        allTools[name] = wrapTool(name, toolImpl);
        (skillToolMap[dir.name] ??= []).push(name);
      }

      // 注册翻译
      if (translations && typeof translations === 'object' && !Array.isArray(translations)) {
        registerSkillTranslations(translations);
      }

      // 注册面板
      if (panelExport) {
        if (typeof panelExport === 'function') {
          registerPanelProvider({ id: dir.name, render: panelExport });
        } else if (panelExport && typeof panelExport.render === 'function') {
          registerPanelProvider({
            id: dir.name,
            render: panelExport.render,
            priority: panelExport.priority ?? 0,
          });
        }
      }
    } catch (err) {
      console.warn(`⚠ 加载 inner_skill "${dir.name}" 失败:`, (err as Error).message);
    }
  }

  return allTools;
}
const skillTools = await loadInnerSkills();

// ── MCP 工具集成 ──
// 从 mcp.json 配置中初始化 MCP Server 并获取远程工具
// 这些工具会自动合并到 toolsContainer 中，与本地工具无缝协作
let mcpIntegration: Awaited<ReturnType<typeof initializeMCP>> | null = null;
let mcpInitialized = false;

async function initMcpTools(): Promise<void> {
  if (mcpInitialized) return;
  mcpInitialized = true;
  try {
    mcpIntegration = await initializeMCP();
    if (Object.keys(mcpIntegration.tools).length > 0) {
      // 将 MCP 工具注册到 toolsContainer
      for (const [name, toolImpl] of Object.entries(mcpIntegration.tools)) {
        if (name in toolsContainer) {
          console.warn(`⚠ MCP 工具 "${name}" 与已有工具重名，已跳过`);
          continue;
        }
        toolsContainer[name] = toolImpl;
      }
    }
  } catch (err) {
    console.warn('[MCP] 初始化失败:', (err as Error).message);
  }
}

// 可变的 tools 容器 —— 静态 import 拿到的是同一对象引用，
// reload_skills 通过 Object.assign 更新其属性
const toolsContainer: Record<string, any> = {
  ...coreTools,
  ...skillTools,
};

// 非阻塞初始化 MCP（工具会在连接完成后动态注入到 toolsContainer）
initMcpTools().catch(err =>
  console.warn('[MCP] 异步初始化失败:', (err as Error).message)
);

export const tools = toolsContainer;
/**
 * 尝试从懒加载注册表中解析工具：如果工具属于某个懒加载技能，
 * 自动激活该技能并将工具注册到 toolsContainer，再返回工具实现。
 * 用于 executeToolCalls 的兜底查找，实现「调用即激活」语义。
 */
export function resolveLazyTool(toolName: string): any | null {
  for (const [skillName, entry] of lazySkillRegistry) {
    if (toolName in entry.tools) {
      activateLazySkill(skillName);
      return toolsContainer[toolName] ?? null;
    }
  }
  return null;
}








// ── 供 reload_skills 工具调用的重新加载接口 ──
export async function reloadSkills(): Promise<string> {
  // 清空懒加载注册表（reload 时一并重建），已激活的 skill 工具已在 toolsContainer 中不受影响
  lazySkillRegistry.clear();
  const loaded = await loadInnerSkills();
  const report: string[] = [];
  skillToolMap = {};
  for (const [name, impl] of Object.entries(loaded)) {
    if (name in coreTools || name in toolsContainer) {
      report.push(`  ⏭ 跳过 ${name}（重名）`);
      continue;
    }
    toolsContainer[name] = wrapTool(name, impl);
    report.push(`  ✅ 添加 ${name}`);
  }
  report.push('');
  // 刷新子 agent 工具注册表
  toolCache.reset();

  // ── 重新加载 MCP 工具 ──
  try {
    const { reloadMCP } = await import('../mcp');
    const mcp = await reloadMCP();
    for (const [name, toolImpl] of Object.entries(mcp.tools)) {
      if (name in coreTools || name in toolsContainer) {
        report.push(`  ⏭ 跳过 MCP 工具 ${name}（重名）`);
        continue;
      }
      toolsContainer[name] = toolImpl;
      report.push(`  ✅ 添加 MCP 工具 ${name}`);
    }
    mcpIntegration = mcp as any;
  } catch (err) {
    report.push(`  ⚠ MCP 重载失败: ${(err as Error).message}`);
  }

  report.push(`共新增 ${report.filter(r => r.includes('✅')).length} 个工具。`);
  return report.join('\n');
}

// ── 卸载指定技能的所有工具 ──
/** 卸载指定 inner_skill 的所有工具，返回卸载的工具名列表 */
export function removeSkill(skillName: string): string[] {
  // 检查懒加载注册表
  if (lazySkillRegistry.has(skillName)) {
    const entry = lazySkillRegistry.get(skillName)!;
    lazySkillRegistry.delete(skillName);
    const removed = Object.keys(entry.tools);
    // 同时清理 skillToolMap 中已注册的 prompt-get 工具
    const promptNames = skillToolMap[skillName];
    if (promptNames) {
      for (const name of promptNames) {
        if (name in coreTools) continue;
        if (name in toolsContainer) {
          delete toolsContainer[name];
        }
      }
      delete skillToolMap[skillName];
    }
    return removed;
  }

  const toolNames = skillToolMap[skillName];
  if (!toolNames || toolNames.length === 0) return [];
  const removed: string[] = [];
  for (const name of toolNames) {
    if (name in coreTools) continue; // 安全防护
    if (name in toolsContainer) {
      delete toolsContainer[name];
      removed.push(name);
    }
  }
  delete skillToolMap[skillName];
  return removed;
}

// ── 卸载指定名称的工具 ──
/** 卸载单个工具（不区分归属 skill），返回工具所属 skill 名（如有） */
export function removeTool(toolName: string): string | null {
  if (toolName in coreTools) return null; // 核心工具不可卸载
  if (!(toolName in toolsContainer)) return null;
  delete toolsContainer[toolName];
  // 从 skillToolMap 中清理
  for (const [skill, names] of Object.entries(skillToolMap)) {
    const idx = names.indexOf(toolName);
    if (idx !== -1) {
      names.splice(idx, 1);
      if (names.length === 0) delete skillToolMap[skill];
      return skill;
    }
  }
  return '__anonymous__';
}


// ── 加载单个 inner_skill ──
/** 加载指定名称的单个 inner_skill（避免全量 reload 开销） */
export async function loadSingleSkill(skillName: string): Promise<boolean> {
  const skillsDir = path.join(__dirname, 'inner_skills', skillName);

  // 检查 enable.json
  let config: { enable: boolean; always_detectable?: boolean };
  try {
    const configRaw = await readFile(path.join(skillsDir, 'enable.json'), 'utf-8');
    config = JSON.parse(configRaw);
    if (!config.enable) {
      console.warn(`[loadSingleSkill] ${skillName} 已禁用`);
      return false;
    }
  } catch {
    console.warn(`[loadSingleSkill] ${skillName} 缺少 enable.json`);
    return false;
  }

  // always_detectable 默认 true
  const alwaysDetectable = config.always_detectable !== false;

  // 如果已加载则跳过
  if (skillToolMap[skillName]?.some(name => name in toolsContainer)) {
    return true;
  }

  // 加载工具
  try {
    const skillModule = await tryImport(path.join(skillsDir, 'index'));
    const skillTools: Record<string, any> = skillModule.default || skillModule;

    // 加载翻译
    let translations: Record<string, any> | undefined;
    try {
      const transModule = await tryImport(path.join(skillsDir, 'translation'));
      translations = transModule.default || transModule;
    } catch { /* 没有翻译文件 */ }

    if (!alwaysDetectable) {
      // ── 懒加载模式 ──
      const promptGetTools: Record<string, any> = {};
      const deferredTools: Record<string, any> = {};

      for (const [name, toolImpl] of Object.entries(skillTools)) {
        if (name.endsWith('-prompt-get')) {
          if (toolImpl.execute) {
            const originalExecute = toolImpl.execute;
            toolImpl.execute = async (args: any, context?: any) => {
              const result = await originalExecute.call(toolImpl, args, context);
              activateLazySkill(skillName);
              return result;
            };
          }
          promptGetTools[name] = toolImpl;
        } else {
          deferredTools[name] = toolImpl;
        }
      }

      const loadedNames: string[] = [];
      for (const [name, toolImpl] of Object.entries(promptGetTools)) {
        if (name in coreTools || name in toolsContainer) {
          console.warn(`[loadSingleSkill] ${name} 重名，跳过`);
          continue;
        }
        toolsContainer[name] = wrapTool(name, toolImpl);
        loadedNames.push(name);
      }
      skillToolMap[skillName] = loadedNames;

      // 仅注册 prompt-get 翻译
      if (translations) {
        const promptGetTranslations: Record<string, any> = {};
        for (const key of Object.keys(translations)) {
          if (key.endsWith('-prompt-get')) {
            promptGetTranslations[key] = translations[key];
          }
        }
        if (Object.keys(promptGetTranslations).length > 0) {
          registerSkillTranslations(promptGetTranslations);
        }
      }

      // 存延迟注册表
      lazySkillRegistry.set(skillName, {
        tools: deferredTools,
        translations,
        panel: undefined,
      });

      return true;
    }

    // ── 正常加载 ──
    const loadedNames: string[] = [];
    for (const [name, toolImpl] of Object.entries(skillTools)) {
      if (name in coreTools || name in toolsContainer) {
        console.warn(`[loadSingleSkill] ${name} 重名，跳过`);
        continue;
      }
      toolsContainer[name] = wrapTool(name, toolImpl);
      loadedNames.push(name);
    }
    skillToolMap[skillName] = loadedNames;

    // 加载翻译
    if (translations && typeof translations === 'object' && !Array.isArray(translations)) {
      registerSkillTranslations(translations);
    }

    // 加载面板
    try {
      await tryImport(path.join(skillsDir, 'panel'));
    } catch { /* 没有面板文件，跳过 */ }

    return true;
  } catch (e: any) {
    console.warn(`[loadSingleSkill] 加载 ${skillName} 失败: ${e.message}`);
    return false;
  }
}





























// ── MCP 相关导出 ──
export { getMcpManager, shutdownMCP, reloadMCP } from '../mcp';

// ── 工具归属 skill 反查（供子模型注入技能使用说明） ──

/** 返回当前 工具名→所属 skill 名 的映射副本（核心工具不在其中） */
export function getSkillToolMap(): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(skillToolMap).map(([skill, names]) => [skill, [...names]]),
  );
}

/** 反查某个工具所属 skill，读取其 SYSTEM_INJECTION.md（无则返回空串）。每次读盘，避免 reload 后缓存过期 */
export async function getSkillInjectionForTool(toolName: string): Promise<string> {
  for (const [skill, names] of Object.entries(skillToolMap)) {
    if (!names.includes(toolName)) continue;
    const injPath = path.join(__dirname, 'inner_skills', skill, 'SYSTEM_INJECTION.md');
    try {
      return (await readFile(injPath, 'utf-8')).trim();
    } catch {
      return '';
    }
  }
  return '';
}

/** 确保指定技能已激活（懒加载技能会立即注册其所有工具），返回该技能的所有工具名。 */
export function ensureSkillActivated(skillName: string): string[] {
  activateLazySkill(skillName);
  return [...(skillToolMap[skillName] ?? [])];
}




























/**
 * 剥离工具定义的 execute 字段，生成仅供模型看 schema 的只读工具集。
 *
 * AI SDK v6 的 streamText 在传入带 execute 的工具时会内部自动执行工具（agent loop），
 * 而本系统工具统一由 agent 层 executeToolCalls / 子模型循环手动执行——
 * 不剥离会导致同一工具被 SDK 与 agent 层各执行一次（双重执行）。
 */
export function stripToolExecutes(toolSet: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [name, t] of Object.entries(toolSet)) {
    if (t && typeof t === 'object' && 'execute' in t) {
      const { execute: _exec, ...schema } = t;
      result[name] = schema;
    } else {
      result[name] = t;
    }
  }
  return result;
}

/**
 * 修复工具调用参数：确保 input 永远是 object，而非引发 provider 崩溃的 string。
 * AI SDK 在 LLM 生成非法 JSON 时会回退为原始字符串，导致下一轮 400。
 */
export function sanitizeToolInput(input: unknown): Record<string, unknown> {
  // 已经是 object（非 null/非数组）→ 正常情况，直接返回
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }

  // string → 尝试 JSON.parse + 修复畸形 JSON
  if (typeof input === 'string') {
    const trimmed = input.trim();
    // 空字符串 → 兜底
    if (!trimmed) return {};

    // 第一次尝试：直接 parse
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      // 解析成功但不是 object → 包装
      return { _value: parsed };
    } catch {
      // 第二次尝试：修复常见 JSON 畸形后再 parse
      const fixed = fixMalformedJson(trimmed);
      try {
        const parsed = JSON.parse(fixed);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
        return { _value: parsed };
      } catch {
        // 实在修不好 → 兜底，至少不崩
        return { _raw: trimmed };
      }
    }
  }

  // 数组或其他类型 → 包装防止崩溃
  return { _value: input };
}

function fixMalformedJson(str: string): string {
  let s = str;

  // 1. 修复未转义的反斜杠（Windows 路径常见）
  s = s.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');

  // 2. 修复未引号包裹的字符串值（如 "key": unquoted_value）
  //    匹配 : 后面跟着非引号/非数字/非布尔/null 开头的值
  s = s.replace(/:\s*([^"{\[\]\d\s-][^,\]}]*?)(?=\s*[,}\]])/g, (match, value) => {
    const trimmed = value.trim();
    if (trimmed === 'true' || trimmed === 'false' || trimmed === 'null') return match;
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) return match;
    // 转义值内的引号
    const escaped = trimmed.replace(/"/g, '\\"');
    return match.replace(value, `"${escaped}"`);
  });

  // 3. 修复尾随逗号
  s = s.replace(/,\s*([}\]])/g, '$1');

  // 4. 单引号 → 双引号
  s = s.replace(/'/g, '"');

  return s;
}