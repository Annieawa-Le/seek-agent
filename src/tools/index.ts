import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { registerSkillTranslations } from '../assets/tool-translations';
import { registerPanelProvider } from './panel-registry';
import { setToolRegistry } from './inner_skills/sub-agent/manager';
// ── 核心工具（硬编码） ──
import {
  deskAddTool, deskListTool, deskRemoveTool, deskClearTool,
} from './ref-desk';
import { readFileTool, readCertainLines, readNumline, scanFileTool } from './read-file';
import { executeCommandTool } from './execute-command';
import { memoryFocus, memoryShorten } from './memory';
import { searchAllFile, searchSubFile, searchDirectory, searchContent } from './search-files';
import { createFile, addPatch, delPatch, modifyPatch, replaceFile, ensurePatch, popPatch, checkPatch, revisePatch } from './file-manipulation';
import { createTodo, finishStep, undoStep, rerollStep, delStep, readTodo, delTodo, activeTodo } from './todo';
import { toolCache } from './tool-cache';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── 工具缓存包裹 ──
function wrapTool(name: string, t: any) {
  if (!t?.execute) return t;
  return { ...t, execute: toolCache.wrap(name, t.execute) };
}

// ── 核心工具表 ──
const coreTools = {
  read_file: wrapTool('read_file', readFileTool),
  read_lines: wrapTool('read_lines', readCertainLines),
  read_num_line: wrapTool('read_num_line', readNumline),
  scan_file: wrapTool('scan_file', scanFileTool),
  pop_patch: wrapTool('pop_patch', popPatch),
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
  ensure_patch: ensurePatch,
  check_patch: checkPatch,
  revise_patch: revisePatch,
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
  memory_shorten: wrapTool('memory_shorten', memoryShorten),
};

// ── 自动扫描加载 inner_skills ──
async function loadInnerSkills(): Promise<Record<string, unknown>> {
  const skillsDir = path.join(__dirname, 'inner_skills');
  const allTools: Record<string, unknown> = {};

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
      // 动态加载技能模块（加 ?t= 时间戳以绕过 Node.js 模块缓存）
      const ts = Date.now();
      const indexUrl = pathToFileURL(path.join(skillPath, 'index.ts')).href + `?t=${ts}`;
      const skillModule = await import(indexUrl);
      const skillTools: Record<string, unknown> = skillModule.default || skillModule;

      for (const [name, toolImpl] of Object.entries(skillTools)) {
        if (name in allTools || name in coreTools) {
          console.warn(`⚠ inner_skill "${dir.name}" 的工具 "${name}" 与已有工具重名，已跳过`);
          continue;
        }
        allTools[name] = wrapTool(name, toolImpl);
      }
      // ── 加载技能的工具翻译（translation.ts） ──
      try {
        const transPath = path.join(skillPath, 'translation.ts');
        const transUrl = pathToFileURL(transPath).href + `?t=${ts}`;
        const transModule = await import(transUrl);
        const translations: Record<string, any> = transModule.default || transModule;
        if (translations && typeof translations === 'object' && !Array.isArray(translations)) {
          registerSkillTranslations(translations);
        }
      } catch {
        // 没有 translation.ts 或加载失败，静默跳过
      }

      // ── 加载技能的自定义面板（panel.ts） ──
      // ── 加载技能的自定义面板（panel.ts） ──
      try {
        const panelPath = path.join(skillPath, 'panel.ts');
        const panelUrl = pathToFileURL(panelPath).href;
        const panelModule = await import(panelUrl);
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

// 可变的 tools 容器 —— 静态 import 拿到的是同一对象引用，
// reload_skills 通过 Object.assign 更新其属性
const toolsContainer: Record<string, unknown> = {
  ...coreTools,
  ...skillTools,
};

export const tools = toolsContainer;

// ── 向 sub-agent 管理器注入工具注册表 ──
setToolRegistry(toolsContainer as any);





// ── 供 reload_skills 工具调用的重新加载接口 ──
export async function reloadSkills(): Promise<string> {
  const loaded = await loadInnerSkills();
  const report: string[] = [];
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
  setToolRegistry(toolsContainer as any);
  toolCache.reset();
  report.push(`共新增 ${report.filter(r => r.includes('✅')).length} 个工具。`);
  return report.join('\n');
}


















