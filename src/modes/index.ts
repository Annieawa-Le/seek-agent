import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerMode } from './registry';
import { buildKbPreProcess } from './preprocess';


/**
 * Manager 模式工具白名单：read/search（了解上下文）+ 目录导航 + 知识库检索 + 联网搜索/网页抓取
 * + memory/todo（任务规划与跨轮记忆）+ browser（深度调研网页）+ 子模型编排（派活本职）。
 * 其余工具（patch/create/replace/execute_command/office/image 等）一律不接入——
 * 改代码、跑命令这类「干活」全交给子 agent，Manager 在提示词中指导其分配工具。
 */
const MANAGER_ALLOW_TOOLS = [
  // read 系列
  'read_file', 'read_lines', 'scan_file',
  'explorer-read-file', 'explorer-read-lines', 'explorer-read-num-line', 'explorer-scan-file',
  // search 系列
  'search_all_file', 'search_sub_file', 'search_directory', 'search_content',
  'explorer-search-all-file', 'explorer-search-sub-file', 'explorer-search-directory', 'explorer-search-content',
  // 目录导航（virtual-explorer）
  'list_directory', 'enter_subfolder', 'go_up',
  'explorer-list-directory', 'explorer-enter-subfolder', 'explorer-go-up',
  // 知识库检索
  'kb_query', 'kb_status',
  // 记忆（工作记忆 + 长期记忆 + 上下文管理）
  'memory_add', 'memory_update', 'memory_touch', 'memory_remove', 'memory_list',
  'memory_remember', 'memory_recall', 'memory_clear', 'memory_stats',
  'memory_focus', 'memory_shorten',
  // 任务段归档（配合 todo：一段工作收尾时把过程移出上下文，仅落盘到 Worklog）
  'mission-start', 'mission-accomplish', 'mission-cancel',
  // 待办（任务拆解与进度跟踪）
  'create_todo', 'finish_step', 'finish_to_step', 'undo_step', 'reroll_step', 'del_step', 'read_todo', 'del_todo', 'active_todo',
  'todo_save', 'todo_load', 'todo_list_saved', 'todo_delete_saved',
  // 浏览器（自主调研网页）
  'browser_launch', 'browser_navigate', 'browser_click', 'browser_type', 'browser_press',
  'browser_scroll', 'browser_extract', 'browser_screenshot', 'browser_execute_js', 'browser_wait',
  'browser_status', 'browser_close', 'browser_tabs', 'browser_switch_tab', 'browser-control-prompt-get',
  // 联网搜索与网页抓取（快速调研）
  'search_web', 'fetch_page', 'crawl_site', 'extract_links', 'web-crawler-prompt-get',
  'tavily_search', 'tavily_extract', 'tavily_crawl', 'tavily_map', 'tavily_research', 'web-accessor-prompt-get',
  // 子模型编排（Manager 本职）
  'spawn_agent', 'agent_task', 'agent_query', 'agent_fire', 'agent_worklog',
  'list_workers', 'get_worker', 'spawn_worker',
  // 文件池（把子模型读阶段读取的文件片段沉淀为命名池，委派时注入共享背景）
  'doc_pool', 'doc-pool-prompt-get',
  // 闹钟（长时间等待提醒，到点注入 user 消息打断）
  'alarm_set', 'alarm_cancel', 'alarm_list',
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 读取 prompts/addon/ 下的模式行为准则（读不到时返回 undefined） */
function readAddon(name: string): string | undefined {
  try {
    return fs.readFileSync(path.join(__dirname, '..', 'prompts', 'addon', name), 'utf-8');
  } catch {
    return undefined;
  }
}

/**
 * 注册所有内置模式（幂等，可重复调用）。
 * - kb（知识库模式）：P1 完整实现
 * - manager / worker：在 P2 / P2.5 补充行为（此处仅注册 meta，供 /mode list 展示）
 */
export function registerBuiltinModes(): void {
  registerMode({
    name: 'kb',
    label: '知识库模式',
    description: '回答前强制检索工作记忆 + 长期记忆 + 知识库，降低幻觉',
    icon: '📚',
    promptAddon: readAddon('KB.md'),
    preProcess: buildKbPreProcess(5),
  });

  registerMode({
    name: 'manager',
    label: 'Manager 模式',
    description: '子 agent 编排，复杂任务并行',
    icon: '🧑‍💼',
    mainReplacement: readAddon('MANAGER.md'), // 角色模式：替换 MAIN.md 成为主提示词
    allowTools: MANAGER_ALLOW_TOOLS, // 只读/搜索 + 子模型编排，干活全交子 agent
  });

  registerMode({
    name: 'worker',
    label: '打工人模式',
    description: '真正的打工人，开工前先创建开发引导员监督',
    icon: '🧑🔧',
    mainReplacement: readAddon('WORKER.md'), // 角色模式：替换 MAIN.md 成为主提示词
  });

  // 幻觉模式只注册 meta（/mode 可激活、UI 可选），提示词由 illusion_agent.ts 自管：
  // 不挂 mainReplacement/promptAddon，避免 loadDefaultPrompts 注入真实技能列表戳破"万能工具"幻觉。
  registerMode({
    name: 'hallucination',
    label: '100% AI 模式',
    description: '万能工具幻觉世界：主模型自由编造工具调用，后台 AI 执行器圆梦',
    icon: '🪄',
  });
}


















