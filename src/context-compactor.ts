/**
 * context-compactor.ts — 上下文预算监测与记忆消退压缩
 *
 * 消退路径：活跃消息 → [Worklog] 梗概 → 归档行（worklog_recall / work_recall 可召回）
 *
 * 时序约束（与设计方案一致）：
 *  - 当前轮次结束前不真正移除消息：压缩生成 CompactionPlan，应用延迟到下一轮用户输入的安全点
 *  - 一轮会话中压缩最多发生一次：由 agent 的 compactionInFlight / pendingCompaction 门控
 *  - 压缩任务异步执行（副模型 generateText），不阻塞主循环（"工作时也可以"）
 *
 * env 配置：
 *  - MAX_CONTEXT_TOKENS     触发线（默认 100000）
 *  - COMPRESS_TARGET_RATIO  停止线比例（默认 0.75，压到触发线的 75%）
 */

import { generateText } from 'ai';
import type { ModelMessage } from 'ai';
import { getModel, getSystemPrompt } from './model-provider';
import { worklogStore, type WorklogEntry } from './tools/worklog-store';

const DEFAULT_MAX_TOKENS = 100_000;
const DEFAULT_TARGET_RATIO = 0.75;

/** Worklog 存储接口（主模型 worklogStore 与子 Agent subagentWorklogStore 均满足） */
export interface WorklogStoreLike {
  setSessionId(id: string): void;
  nextId(): string;
  add(entry: WorklogEntry): void;
  get(id: string): WorklogEntry | undefined;
}
export interface CompactionPlan {
  /** 需从消息列表头部移除的消息条数（含旧 Worklog 消息） */
  removeCount: number;
  /** 插入头部的新消息（新 Worklog + 可能的归档行） */
  insertMessages: ModelMessage[];
  /** 本次移除的轮次数 */
  roundsRemoved: number;
  /** 归档条目（已写入 store） */
  worklog: WorklogEntry;
}

// ── 预算配置 ──

export function maxContextTokens(): number {
  const v = Number(process.env.MAX_CONTEXT_TOKENS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_TOKENS;
}

export function targetContextTokens(): number {
  const ratio = Number(process.env.COMPRESS_TARGET_RATIO);
  const r = Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? ratio : DEFAULT_TARGET_RATIO;
  return Math.floor(maxContextTokens() * r);
}

/** 判断当前 input token 是否超触发线（双阈值：超触发线才压，压到停止线） */
export function checkBudget(inputTokens: number): boolean {
  return inputTokens > maxContextTokens();
}

const DEFAULT_ROUND_RATIO = 0.5;

/** 单轮占比阈值：单轮 token 占总量的比例超过它时，优先做分层保真（幂等工具结果简化）而非归档 */
export function roundRatioThreshold(): number {
  const v = Number(process.env.ROUND_RATIO_THRESHOLD);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : DEFAULT_ROUND_RATIO;
}

// ── 轮次识别（与 memory.ts 的 findRounds 同构：user 消息为轮次边界） ──

interface RoundBoundary {
  start: number;
  end: number;
}

export function findRounds(messages: ModelMessage[]): RoundBoundary[] {
  const rounds: RoundBoundary[] = [];
  let start = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user' && typeof m.content === 'string') {
      if (start !== -1) rounds.push({ start, end: i - 1 });
      start = i;
    }
  }
  if (start !== -1) rounds.push({ start, end: messages.length - 1 });
  return rounds;
}

/** 粗估消息列表 token 数（每字符 ~0.3 token，仅用于选择压缩轮次） */
/** 统计消息列表原始字符数（占比判断用，避免 ceil 舍入误差） */
function estimateChars(messages: ModelMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content as Array<{ type?: string; text?: string; output?: { value?: string } }>) {
        if (typeof part.text === 'string') chars += part.text.length;
        else if (part.type === 'tool-result' && typeof part.output?.value === 'string') {
          chars += part.output.value.length;
        }
      }
    }
  }
  return chars;
}

/** 粗估消息列表 token 数（每字符 ~0.3 token，仅用于选择压缩轮次） */
function estimateTokens(messages: ModelMessage[]): number {
  return Math.ceil(estimateChars(messages) * 0.3);
}

/** 粗估 token 数（导出给 agent 在瘦身后复查预算） */
export function estimateMessagesTokens(messages: ModelMessage[]): number {
  return estimateTokens(messages);
}

// ── 分层保真：单轮占比超阈值时的幂等工具结果简化 ──

/** 幂等工具集合：结果可再生（重读/重搜即可），可安全简化为"已遗忘，请重新读取" */
const IDEMPOTENT_TOOLS = new Set([
  // 文件读取
  'read_file', 'read_lines', 'scan_file',
  // 文件搜索
  'search_all_file', 'search_sub_file', 'search_directory', 'search_content',
  // 知识库查询
  'kb_query', 'kb_status',
  // 只读查询
  'desk_list', 'memory_list', 'memory_stats',
  'list_directory', 'enter_subfolder', 'go_up',
  'image_info', 'pdf_info', 'read_pdf', 'read_pdf_pages',
  // code-reader / code-edit-detector 分析
  'scanning_function', 'scanning_class', 'scanning_tag', 'scanning_script',
  'read_function', 'read_class', 'read_package', 'jump_to_definition',
  'get_function_range', 'find_matching_brace', 'find_matching_label',
  // 召回（可重复取回）
  'worklog_recall', 'work_recall',
]);

function isIdempotentTool(toolName: string): boolean {
  return IDEMPOTENT_TOOLS.has(toolName)
    || toolName.startsWith('explorer-read') || toolName.startsWith('explorer-search')
    || toolName.startsWith('explorer-list') || toolName.startsWith('explorer-scan');
}

/**
 * 分层保真：最旧一轮占比超阈值时，先对该轮幂等工具结果做原地简化。
 * 只处理最旧一轮（rounds[0]）——它是移除-梗概的首选候选；
 * 瘦身后若预算回落则本轮跳过（等下次清理），仍超限才走 compactMessages 移除-梗概。
 * 不移除消息、不产生 Worklog、不归档——仅替换 tool-result 内容（结构/配对完整）。
 * @returns 瘦身后的新消息列表；最旧轮占比未超阈值或无可简化工具结果时返回 null
 */
export function slimOldestRound(messages: ModelMessage[]): ModelMessage[] | null {
  const ratio = roundRatioThreshold();
  const rounds = findRounds(messages);
  if (rounds.length <= 1) return null; // 至少保留一轮真实对话

  const total = estimateChars(messages);
  if (total <= 0) return null;

  // 只看最旧一轮：占比超阈值才值得瘦身（其余轮交给移除-梗概路径处理）
  const r = rounds[0];
  const size = estimateChars(messages.slice(r.start, r.end + 1));
  if (size / total <= ratio) return null;

  const result = messages.map((m, i) => {
    if (i < r.start || i > r.end || m.role !== 'tool' || !Array.isArray(m.content)) return m;
    const parts = (m.content as Array<{ type?: string; toolName?: string; output?: { value?: string } }>).map((part) => {
      if (part.type === 'tool-result' && part.output && isIdempotentTool(part.toolName ?? '')) {
        return { ...part, output: { type: 'text', value: `[${part.toolName}] 已遗忘，请重新读取` } };
      }
      return part;
    });
    return parts.some((p, pi) => p !== (m.content as any[])[pi]) ? ({ ...m, content: parts } as ModelMessage) : m;
  });

  return result.some((m, i) => m !== messages[i]) ? result : null;
}


// ── Worklog 消息识别 ──

/** 判断消息是否为 [Worklog#...] 消息（含归档行） */
export function isWorklogMessage(m: ModelMessage): boolean {
  if (m.role !== 'assistant' && m.role !== 'user') return false;
  const text = typeof m.content === 'string' ? m.content : '';
  return text.startsWith('[Worklog#');
}

export function extractWorklogId(text: string): string | null {
  const m = text.match(/\[Worklog#(W\d+)\]/);
  return m ? m[1] : null;
}

/** 判断是否为系统注入消息（[工作记忆]/[知识库检索]/[长期记忆]/【子模型提交），不进归档内容 */
export function isSystemInjectMessage(m: ModelMessage): boolean {
  if (m.role !== 'user') return false;
  const text = typeof m.content === 'string' ? m.content : '';
  return /^(\[工作记忆\]|\[知识库检索\]|\[长期记忆\]|【)/.test(text);
}

// ── 副模型压缩 ──

const COMPACT_PROMPT = `# 当前任务：工作记忆压缩
你是 AI 编程助手的「工作记忆压缩师」。旧对话轮次即将从活跃上下文移入归档，
请以第一人称"我"（即主模型身份）总结这批工作中：我做了什么、用户的意图是什么、涉及哪些文件改动、还有哪些待办。

# Input
将被归档的对话轮次（用户输入、AI 输出、工具调用摘要）。

# Task
先理解这批工作，再输出以下结构的工作梗概（全部使用中文，总长控制在 1500 字以内）：

【标题】≤20 字，概括这批工作的主题
【用户意图】用户想做什么——提炼核心意图与关键原意，不要逐字拼接原话
【关键决策】做出的重要决定及其原因
【文件改动】涉及的文件与改动要点（每项一行）
【待办】未完成事项
【取回指引】如需细节，应重读哪个文件 / 重跑哪个命令

# Output
只输出以上结构，不要输出解释性文字。`;

async function summarizeRounds(roundMessages: ModelMessage[]): Promise<{ title: string; summary: string }> {
  // 压缩读入成本控制：去掉所有 tool 相关消息（tool-call/tool-result 配对剥掉
  // toolCallId 后不符合 AI SDK v6 的 ModelMessage schema，会导致 generateText 本地校验失败），
  // assistant 内容转为纯文本，tool-call 只留工具名占位；原文已完整归档可召回
  const slim: ModelMessage[] = roundMessages
    .filter((m) => m.role !== 'tool')
    .map((m) => {
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        const parts = m.content as Array<{ type?: string; toolName?: string; text?: string }>;
        const texts = parts.filter((p) => p.type === 'text' && typeof p.text === 'string').map((p) => p.text as string);
        const toolNames = parts.filter((p) => p.type === 'tool-call' && typeof p.toolName === 'string').map((p) => p.toolName as string);
        const lines = [...texts];
        if (toolNames.length) lines.push(`[工具调用: ${toolNames.join(', ')}]`);
        if (!lines.length) return null; // 无实质内容的 assistant 消息丢弃
        return { role: 'assistant', content: lines.join('\n') } as ModelMessage;
      }
      return m;
    })
    .filter((m): m is ModelMessage => m !== null);

  try {
    const model = getModel();
    const result = await generateText({
      model,
      system: `${getSystemPrompt()}\n\n${COMPACT_PROMPT}`,
      messages: [...slim, { role: 'user', content: '请压缩以上对话轮次为工作梗概。' }],
      maxOutputTokens: 2500,
    });
    const text = result.text.trim();
    const titleMatch = text.match(/【标题】\s*(.+)/);
    const title = (titleMatch?.[1] ?? '').trim().slice(0, 20) || '工作记录';
    return { title, summary: text.slice(0, 3000) };
  } catch {
    // 兜底：简单提取用户输入作为梗概
    const inputs = roundMessages
      .filter((m) => m.role === 'user' && typeof m.content === 'string')
      .map((m) => (m.content as string).slice(0, 60))
      .filter((t) => t && !t.startsWith('[工作记忆]') && !t.startsWith('【')
        && !t.startsWith('[知识库检索]') && !t.startsWith('[Worklog#'));
    const title = inputs[0]?.slice(0, 12) || '工作记录';
    const summary = [
      `【标题】${title}`,
      '【用户意图】',
      ...inputs.map((t) => `- ${t}`),
      '【关键决策】',
      '【文件改动】',
      '【待办】',
      '【取回指引】原始消息已归档，可使用 work_recall 查看原文。',
    ].join('\n');
    return { title, summary };
  }
}

/**
 * 执行压缩：从消息快照中确定要移除的最旧轮次，生成 Worklog 并写入归档。
 * @param snapshot 消息快照（调用方传入，避免与主循环并发修改）
 * @param sessionId 会话 id（归档分区）
 * @param currentInputTokens 本次请求的 input token 数（触发判断）
 * @returns 压缩计划；无需压缩时返回 null
 */
export async function compactMessages(
  snapshot: ModelMessage[],
  sessionId: string,
  currentInputTokens: number,
  summarize?: (roundMessages: ModelMessage[]) => Promise<{ title: string; summary: string }>,
  store: WorklogStoreLike = worklogStore,
): Promise<CompactionPlan | null> {
  const trigger = maxContextTokens();
  const target = targetContextTokens();
  if (currentInputTokens <= trigger) return null;

  store.setSessionId(sessionId);

  const rounds = findRounds(snapshot);
  // 至少保留一轮真实对话
  if (rounds.length <= 1) return null;

  // 从最旧轮次开始累加移除，直到估算释放量 ≥ 需要压下的 token
  const needRelease = currentInputTokens - target;
  let removeCount = 0;
  let roundsToRemove = 0;
  let released = 0;
  for (const r of rounds) {
    released += estimateTokens(snapshot.slice(r.start, r.end + 1));
    removeCount = r.end + 1;
    roundsToRemove++;
    if (released >= needRelease || roundsToRemove >= rounds.length - 1) break;
  }

  // 头部 Worklog 收集：跳过系统注入消息（[工作记忆]/[知识库检索]/【子模型提交 等，hook 每轮注入到最前），
  // 收集其后的连续 [Worklog# 消息（含已归档行），它们不再进副模型重复压缩
  const headWorklogs: ModelMessage[] = [];
  let wlScan = 0; // 头部扫描位置（含跳过的注入消息，removeCount 需覆盖）
  while (wlScan < snapshot.length) {
    const m = snapshot[wlScan];
    if (isWorklogMessage(m)) { headWorklogs.push(m as ModelMessage); wlScan++; continue; }
    if (isSystemInjectMessage(m)) { wlScan++; continue; }
    break;
  }

  // 二级消退：把最旧的完整 Worklog 降级为归档行；已归档行原样保留（时间线在前）
  let headArchiveLine: ModelMessage | null = null;
  const oldestFull = headWorklogs.find((w) => {
    const t = typeof w.content === 'string' ? w.content : '';
    return !t.includes('已归档');
  });
  if (oldestFull) {
    const oldText = typeof oldestFull.content === 'string' ? oldestFull.content : '';
    const oldId = extractWorklogId(oldText);
    const oldEntry = oldId ? store.get(oldId) : undefined;
    const oldTitle = oldEntry?.title ?? '工作记录';
    headArchiveLine = {
      role: 'assistant',
      content: `[Worklog#${oldId ?? ''}]已归档：${oldTitle}，使用 worklog_recall ${oldId ?? ''} 查看梗概，work_recall ${oldId ?? ''} 查看原文`,
    } as ModelMessage;
  }

  // 移除范围内的真实对话消息（Worklog 与系统注入消息已单独处理，不进归档内容）
  const removedAll = snapshot.slice(0, removeCount);
  const removedMessages = removedAll.filter((m) => !isWorklogMessage(m) && !isSystemInjectMessage(m));
  // 移除范围需覆盖头部扫描到的注入消息 + 全部 Worklog 消息
  removeCount = Math.max(removeCount, wlScan);
  // 生成新 Worklog（副模型压缩）
  const { title, summary } = await (summarize ?? summarizeRounds)(removedMessages);
  const id = store.nextId();
  const entry: WorklogEntry = {
    id,
    title,
    summary,
    archivedMessages: removedMessages,
    createdAt: new Date().toISOString(),
  };
  store.add(entry);

  // 时间线顺序：旧的已归档行（原样）→ 刚降级的归档行 → 新 Worklog
  const insertMessages: ModelMessage[] = [
    ...headWorklogs.filter((w) => {
      const t = typeof w.content === 'string' ? w.content : '';
      return t.includes('已归档');
    }),
  ];
  if (headArchiveLine) insertMessages.push(headArchiveLine);
  insertMessages.push({
    role: 'assistant',
    content: `[Worklog#${id}] ${title}\n${summary}`,
  } as ModelMessage);

  return { removeCount, insertMessages, roundsRemoved: roundsToRemove, worklog: entry };

}






























