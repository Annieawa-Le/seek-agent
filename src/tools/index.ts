import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { registerSkillTranslations } from '../assets/tool-translations';
import { initializeMCP } from '../mcp';
import { registerPanelProvider } from './panel-registry';
// ── 核心工具（硬编码） ──
// ── 核心工具（硬编码） ──
import {
  deskAddTool, deskListTool, deskRemoveTool, deskClearTool,
} from './ref-desk';
import { readFileTool, readCertainLines, readNumline, scanFileTool } from './read-file';
import { executeCommandTool } from './execute-command';
import {
  memoryFocus, memoryShorten,
  memoryAdd, memoryUpdate, memoryTouch, memoryRemove, memoryList,
  memoryRemember, memoryRecall, memoryClear, memoryStats,
} from './memory';
import { searchAllFile, searchSubFile, searchDirectory, searchContent } from './search-files';
import { createFile, addPatch, delPatch, modifyPatch, replaceFile, undoPatch, historyPatch } from './file-manipulation';
import { createTodo, finishStep, undoStep, rerollStep, delStep, readTodo, delTodo, activeTodo } from './todo';
import { toolCache } from './tool-cache';
import { collabSessionsTool, collabSendTool } from './collab';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── 工具缓存包裹 ──
function wrapTool(name: string, t: any) {
  if (!t?.execute) return t;
  return { ...t, execute: toolCache.wrap(name, t.execute) };
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
  read_lines: wrapTool('read_lines', readCertainLines),
  read_num_line: wrapTool('read_num_line', readNumline),
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
  // 参考桌面管理
  desk_add: wrapTool('desk_add', deskAddTool),
  desk_list: wrapTool('desk_list', deskListTool),
  desk_remove: wrapTool('desk_remove', deskRemoveTool),
  desk_clear: wrapTool('desk_clear', deskClearTool),
  // 待办事项管理
  create_todo: wrapTool('create_todo', createTodo),
  finish_step: wrapTool('finish_step', finishStep),
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
  // 跨会话协作
  collab_sessions: wrapTool('collab_sessions', collabSessionsTool),
  collab_send: wrapTool('collab_send', collabSendTool),
};

// ── 技能→工具映射（用于卸载） ──
let skillToolMap: Record<string, string[]> = {};

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
    try {
      const configRaw = await readFile(enablePath, 'utf-8');
      const config = JSON.parse(configRaw);
      if (!config.enable) continue;
    } catch {
      // 没有 enable.json 或读取失败 → 跳过此技能
      continue;
    }

    // 动态加载技能模块
    try {
      // 动态加载技能模块（自动处理 .ts/.js 扩展名）
      const skillModule = await tryImport(path.join(skillPath, 'index'));
      const skillTools: Record<string, any> = skillModule.default || skillModule;

      for (const [name, toolImpl] of Object.entries(skillTools)) {
        if (name in allTools || name in coreTools) {
          console.warn(`⚠ inner_skill "${dir.name}" 的工具 "${name}" 与已有工具重名，已跳过`);
          continue;
        }
        allTools[name] = wrapTool(name, toolImpl);
        (skillToolMap[dir.name] ??= []).push(name);
      }
      // ── 加载技能的工具翻译（translation.ts） ──
      try {
        const transModule = await tryImport(path.join(skillPath, 'translation'));
        const translations: Record<string, any> = transModule.default || transModule;
        if (translations && typeof translations === 'object' && !Array.isArray(translations)) {
          registerSkillTranslations(translations);
        }
      } catch {
        // 没有 translation.ts 或加载失败，静默跳过
      }

      // ── 加载技能的自定义面板（panel.ts） ──
      try {
        const panelModule = await tryImport(path.join(skillPath, 'panel'));
        const panelExport = panelModule.default || panelModule;
        if (typeof panelExport === 'function') {
          registerPanelProvider({ id: dir.name, render: panelExport });
        } else if (panelExport && typeof panelExport.render === 'function') {
          registerPanelProvider({
            id: dir.name,
            render: panelExport.render,
            priority: panelExport.priority ?? 0,
          });
        }
      } catch {
        // 没有 panel.ts 或加载失败，静默跳过
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






// ── 供 reload_skills 工具调用的重新加载接口 ──
export async function reloadSkills(): Promise<string> {
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
  try {
    const configRaw = await readFile(path.join(skillsDir, 'enable.json'), 'utf-8');
    const config = JSON.parse(configRaw);
    if (!config.enable) {
      console.warn(`[loadSingleSkill] ${skillName} 已禁用`);
      return false;
    }
  } catch {
    console.warn(`[loadSingleSkill] ${skillName} 缺少 enable.json`);
    return false;
  }

  // 如果已加载则跳过
  if (skillToolMap[skillName]?.some(name => name in toolsContainer)) {
    return true;
  }

  // 加载工具
  try {
    const skillModule = await tryImport(path.join(skillsDir, 'index'));
    const skillTools: Record<string, any> = skillModule.default || skillModule;

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
    try {
      const transModule = await tryImport(path.join(skillsDir, 'translation'));
      const translations = transModule.default || transModule;
      if (translations && typeof translations === 'object' && !Array.isArray(translations)) {
        registerSkillTranslations(translations);
      }
    } catch { /* 没有翻译文件，跳过 */ }

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

