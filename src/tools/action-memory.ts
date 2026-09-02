/**
 * action-memory.ts — 行为记忆系统
 *
 * 仿造工作记忆的"训练-沉淀"架构，但沉淀的是**行为模式**而非事实状态：
 *   - 采样：工具调用实际执行后累计 ≥5 次（跨轮游标）时快照窗口
 *   - 蒸馏：行为蒸馏师（轻量模型）把窗口提炼为带权重的行为经验
 *   - 注入：经验写入全局行为池（~/.seek-agent/actions/pool.json，不随工作区切换）
 *   - 整理：池满 10 条 → 行为模式整理师（主模型）合并去重进 ACTION.md
 *           → 写回 prompts/ACTION.md → 回调 reloadPrompt 让 system prompt 立即生效
 *
 * 开关：环境变量 ACTION_MEMORY_ENABLED=true（WebUI 设置面板可配置，重启生效）。
 * 整个采样蒸馏链路为后台 fire-and-forget，不阻塞工具执行循环。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateText } from 'ai';
import type { ModelMessage } from 'ai';
import { getModel, getLiteModel } from '../model-provider';
import { getWorkspaceRoot } from '../workdir';

// ═════════════════════════════════════════════════════
// 常量与路径
// ═════════════════════════════════════════════════════

/** 每累计多少次工具调用采样一次 */
const SAMPLE_WINDOW = 5;
/** 行为池容量：满则触发整理师 */
const POOL_CAPACITY = 10;
/** 单个窗口文本总长上限（超长从尾部截断） */
const MAX_WINDOW_CHARS = 12000;
/** 窗口内单条消息截断长度 */
const MAX_MSG_CHARS = 800;

function poolDir(): string {
  return path.join(os.homedir(), '.seek-agent', 'actions');
}

function poolFile(): string {
  return path.join(poolDir(), 'pool.json');
}

/** 行为池条目（content 为去权重前缀的纯经验文本） */
export interface ActionPoolItem {
  id: number;
  content: string;
  weight: number;
  createdAt: number;
  /** 来源工作区（追溯用） */
  source?: string;
}

// ═════════════════════════════════════════════════════
// 全局行为池存储（不随工作区切换，跨工作区共享）
// ═════════════════════════════════════════════════════

export class ActionPoolStore {
  private items: ActionPoolItem[] = [];
  private nextId = 1;

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(poolFile(), 'utf-8');
      const data = JSON.parse(raw);
      if (Array.isArray(data.items)) {
        this.items = data.items.filter(
          (it: any) => it && typeof it.id === 'number' && typeof it.content === 'string',
        );
      }
      this.nextId = data.nextId && data.nextId > 0
        ? data.nextId
        : (this.items.length > 0 ? Math.max(...this.items.map((i) => i.id)) + 1 : 1);
    } catch {
      // 首次运行或文件损坏：以空池启动
    }
  }

  private save(): void {
    fs.mkdirSync(poolDir(), { recursive: true });
    fs.writeFileSync(
      poolFile(),
      JSON.stringify({ nextId: this.nextId, items: this.items }, null, 2),
      'utf-8',
    );
  }

  /** 按权重降序返回全部条目 */
  list(): ActionPoolItem[] {
    return [...this.items].sort((a, b) => b.weight - a.weight);
  }

  add(content: string, weight: number, source?: string): ActionPoolItem {
    const item: ActionPoolItem = {
      id: this.nextId++,
      content,
      weight: Math.min(5, Math.max(0.1, weight)),
      createdAt: Date.now(),
      source,
    };
    this.items.push(item);
    this.save();
    return item;
  }

  clear(): void {
    this.items = [];
    this.nextId = 1;
    this.save();
  }

  get count(): number {
    return this.items.length;
  }

  get capacity(): number {
    return POOL_CAPACITY;
  }
}

/** 模块级单例 */
export const actionPool = new ActionPoolStore();

/** 行为记忆训练开关（ACTION_MEMORY_ENABLED=true） */
export function isActionMemoryEnabled(): boolean {
  return /^(true|1|yes)$/i.test(process.env.ACTION_MEMORY_ENABLED ?? '');
}

// ═════════════════════════════════════════════════════
// 采样窗口构建
// ═════════════════════════════════════════════════════

/** 把一条 ModelMessage 压缩为紧凑文本（供蒸馏师阅读） */
function messageToText(m: ModelMessage): string {
  if (typeof m.content === 'string') {
    const label = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : m.role;
    return `[${label}] ${m.content}`;
  }
  const parts: string[] = [];
  for (const part of m.content as any[]) {
    if (part.type === 'text') {
      parts.push(`[助手] ${part.text}`);
    } else if (part.type === 'tool-call') {
      const args = JSON.stringify(part.input ?? {}).slice(0, MAX_MSG_CHARS);
      parts.push(`[调用] ${part.toolName}(${args})`);
    } else if (part.type === 'tool-result') {
      const val = typeof part.output === 'object' && part.output
        ? String(part.output.value ?? JSON.stringify(part.output))
        : String(part.output ?? '');
      parts.push(`[结果] ${part.toolName}: ${val.slice(0, MAX_MSG_CHARS)}`);
    }
  }
  return parts.join('\n');
}

/**
 * 从 messages 中提取采样窗口文本：从第 cursor+1 个 tool-result 起
 * （含其之前最近一条 user 消息作为上文锚点）到末尾。
 */
export function buildWindowText(messages: ModelMessage[], cursor: number): string {
  // 找到第 cursor+1 个 tool 消息的索引
  let toolCount = 0;
  let windowStart = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const isTool = m.role === 'tool' && Array.isArray(m.content);
    if (isTool) {
      toolCount++;
      if (toolCount === cursor + 1) {
        // 往前找最近一条 user 消息作为上文锚点
        windowStart = i;
        for (let j = i - 1; j >= 0; j--) {
          if (messages[j].role === 'user' && typeof messages[j].content === 'string') {
            windowStart = j;
            break;
          }
        }
        break;
      }
    }
  }
  if (windowStart === -1) return '';

  const lines: string[] = [];
  let total = 0;
  for (let i = windowStart; i < messages.length; i++) {
    const text = messageToText(messages[i]);
    total += text.length + 1;
    if (total > MAX_WINDOW_CHARS) break;
    lines.push(text);
  }
  return lines.join('\n');
}

// ═════════════════════════════════════════════════════
// 蒸馏与整理
// ═════════════════════════════════════════════════════

/** 解析蒸馏师输出：JSON 数组，每项 "<权重>经验" */
export function parseDistilled(text: string): Array<{ weight: number; content: string }> {
  const cleaned = text.replace(/```json|```/g, '').trim();
  let data: unknown = null;
  try {
    data = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\[[\s\S]*\]/);
    if (m) {
      try { data = JSON.parse(m[0]); } catch { return []; }
    }
  }
  if (!Array.isArray(data)) return [];

  const result: Array<{ weight: number; content: string }> = [];
  for (const entry of data) {
    if (typeof entry !== 'string') continue;
    const m = entry.match(/^<(\d+(?:\.\d+)?)>(.*)$/);
    if (!m) continue;
    const weight = parseFloat(m[1]);
    const content = m[2].trim();
    if (!content || isNaN(weight) || weight <= 0) continue;
    result.push({ weight: Math.min(5, weight), content });
  }
  return result;
}

function promptsDir(): string {
  return path.join(__dirname, '..', 'prompts');
}

function actionMdPath(): string {
  return path.join(promptsDir(), 'ACTION.md');
}

function readPromptFile(name: string): string {
  try {
    return fs.readFileSync(path.join(promptsDir(), name), 'utf-8');
  } catch {
    return '';
  }
}

/** 调用行为蒸馏师，把窗口文本提炼为带权重的行为经验 */
async function distill(windowText: string, existingCount: number): Promise<Array<{ weight: number; content: string }>> {
  const distillerPrompt = readPromptFile('ACTION_DISTILLER.md');
  if (!distillerPrompt || !windowText) return [];
  const result = await generateText({
    model: getLiteModel(),
    system: distillerPrompt,
    messages: [
      {
        role: 'user',
        content: JSON.stringify({ window: windowText, existingCount }),
      },
    ],
  });
  return parseDistilled(result.text);
}

/**
 * 调用行为模式整理师（主模型）：合并去重启 ACTION.md，清空行为池。
 * 返回是否成功更新。
 */
async function consolidate(): Promise<boolean> {
  if (actionPool.count === 0) return false;
  const consolidatorPrompt = readPromptFile('ACTION_CONSOLIDATOR.md');
  if (!consolidatorPrompt) return false;

  const existingAction = (() => {
    try {
      return fs.readFileSync(actionMdPath(), 'utf-8');
    } catch {
      return '';
    }
  })();

  const result = await generateText({
    model: getModel(),
    system: consolidatorPrompt,
    messages: [
      {
        role: 'user',
        content: JSON.stringify({
          pool: actionPool.list().map((it) => ({
            content: it.content,
            weight: it.weight,
            createdAt: it.createdAt,
          })),
          existingAction,
        }),
      },
    ],
  });

  const newAction = result.text.trim();
  if (!newAction.includes('# 行为记忆')) {
    // 模型未按格式输出时放弃本次更新（保住现有 ACTION.md）
    return false;
  }

  fs.writeFileSync(actionMdPath(), newAction + '\n', 'utf-8');
  actionPool.clear();
  return true;
}

// ═════════════════════════════════════════════════════
// 统一入口（agent.ts 工具循环调用）
// ═════════════════════════════════════════════════════

/** 跨轮游标：已蒸馏过的 tool-result 数量 */
let lastDistilledToolCount = 0;
/** 蒸馏/整理链路 in-flight 门控（防并发叠触发） */
let actionLinkInFlight = false;

function countToolResults(messages: ModelMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role === 'tool' && Array.isArray(m.content)) n++;
  }
  return n;
}

/**
 * 工具调用后的采样入口：累计达 SAMPLE_WINDOW 次时快照窗口并后台蒸馏；
 * 池满则继续整理 ACTION.md，成功后回调 onActionUpdated（供 agent 刷新 system prompt）。
 * 失败静默，游标照常推进（避免同一窗口反复重试）。
 */
export async function maybeDistillActions(
  messages: ModelMessage[],
  onActionUpdated?: () => void,
): Promise<void> {
  if (!isActionMemoryEnabled()) return;
  if (actionLinkInFlight) return;

  const toolCount = countToolResults(messages);
  const delta = toolCount - lastDistilledToolCount;
  if (delta < SAMPLE_WINDOW) return;

  // 同步快照窗口（异步期间 messages 仍会变长）
  const windowText = buildWindowText(messages, lastDistilledToolCount);

  actionLinkInFlight = true;
  try {
    const distilled = await distill(windowText, actionPool.count);
    let added = 0;
    for (const entry of distilled) {
      actionPool.add(entry.content, entry.weight, getWorkspaceRoot());
      added++;
    }
    if (added > 0) {
      console.log(`[action-memory] 蒸馏 ${added} 条行为经验，池 ${actionPool.count}/${POOL_CAPACITY}`);
    }

    // 池满 → 整理师合并进 ACTION.md
    if (actionPool.count >= POOL_CAPACITY) {
      try {
        const ok = await consolidate();
        if (ok) {
          console.log('[action-memory] 行为池已整理进 ACTION.md');
          onActionUpdated?.();
        }
      } catch (e: any) {
        console.log(`[action-memory] 整理失败（池保留，下次采样重试）: ${e?.message || e}`);
      }
    }
  } catch (e: any) {
    console.log(`[action-memory] 蒸馏失败: ${e?.message || e}`);
  } finally {
    actionLinkInFlight = false;
    lastDistilledToolCount = toolCount;
  }
}