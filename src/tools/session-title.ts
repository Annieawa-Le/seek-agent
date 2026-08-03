/**
 * session-title.ts — 会话标题生成器
 *
 * 用轻量模型（getLiteModel，与做梦沉淀同一模型）为当前对话总结标题，
 * 供 autoSaveSession 以 `session-{标题}.json` 命名保存文件，替代抽象的随机 ID。
 *
 * 标题要求：具体而非泛化、4-12 字中文（可含技术名词）、可直接用作文件名。
 */

import { generateText } from 'ai';
import type { ModelMessage } from 'ai';
import { getLiteModel } from '../model-provider';

/** 标题总结提示词 */
const TITLE_PROMPT = `# Role
你是 AI 编程助手的「会话标题师」。你的任务是根据对话内容，为本次会话生成一个简短、具体、可读的中文标题。

# Input
最近的用户消息（已拼接，可能包含多轮对话）。

# Task
用 4-12 个字的中文短语概括当前会话的主题/任务。要求：
1. 具体而非泛化：优先提炼任务或领域（如"修复内存泄漏"、"Agent 记忆系统"），不要写"编程问题"、"对话记录"这类空话。
2. 可含技术名词：如"pnpm 工作区"、"RESTful API"、"session 持久化"。
3. 标题应随对话演进：如果任务有变化，标题应反映当前最新的焦点。

# Output
只输出标题本身。禁止：引号、标点符号、Markdown 标记、解释性文字、换行。`;

/** 从消息中提取最近几条用户输入（过滤系统注入的 [工作记忆] / 【子模型提交】） */
function recentUserInputs(messages: ModelMessage[], max = 6): string {
  const inputs: string[] = [];
  // 从后往前遍历，取最近 max 条用户输入
  for (let i = messages.length - 1; i >= 0 && inputs.length < max; i--) {
    const m = messages[i];
    if (m.role !== 'user' || typeof m.content !== 'string') continue;
    const text = m.content.trim();
    if (!text) continue;
    if (text.startsWith('[工作记忆]') || text.startsWith('【') || text.startsWith('[知识库检索]') || text.startsWith('[Worklog#')) continue;
    inputs.push(text);
  }
  return inputs.join('\n');
}

/**
 * 用轻量模型总结会话标题。
 * 失败或输入不足时返回空字符串（由调用方回退）。
 */
export async function summarizeSessionTitle(messages: ModelMessage[]): Promise<string> {
  const inputs = recentUserInputs(messages);
  if (!inputs.trim()) return '';

  try {
    const model = getLiteModel();
    const result = await generateText({
      model,
      system: TITLE_PROMPT,
      messages: [{ role: 'user', content: inputs.slice(0, 3000) }],
    });
    return sanitizeTitle(result.text);
  } catch {
    return '';
  }
}

/** 清洗标题：剔除文件名非法字符/控制字符，压缩空白，限长 */
export function sanitizeTitle(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 40) || '未命名会话';
}

/** 首轮 fallback 标题：取首条真实用户输入前 20 字（排除系统注入的 [工作记忆] 与子模型提交） */
export function fallbackTitle(messages: ModelMessage[]): string {
  const first = messages.find((m) =>
    m.role === 'user' && typeof m.content === 'string'
    && !m.content.startsWith('[工作记忆]') && !m.content.startsWith('【') && !m.content.startsWith('[知识库检索]') && !m.content.startsWith('[Worklog#'),
  );
  if (first && typeof first.content === 'string') {
    return sanitizeTitle(first.content.slice(0, 20));
  }
  return '未命名会话';
}







