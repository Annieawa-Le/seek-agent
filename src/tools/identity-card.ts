/**
 * identity-card.ts — 会话身份卡生成器
 *
 * 用轻量模型（getLiteModel，与会话标题同一模型）为当前对话总结生成
 * 结构化身份卡，供跨会话协作（collab_sessions）和侧边栏预览使用。
 *
 * 身份卡存于独立附属文件 sessions/session-{标题}.identity.json，
 * 由主进程读写，避免被 agent 每轮的 autoSaveSession 整文件重写覆盖。
 *
 * 提示词从 src/prompts/IDENTITY_CARD.md 读取（每次生成时读，便于调试即时生效）。
 */

import { generateText } from 'ai';
import type { ModelMessage } from 'ai';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { getLiteModel } from '../model-provider';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 身份卡结构（存储为 JSON） */
export interface IdentityCard {
  focus: string;
  summary: string;
  conclusions: string[];
  relatedSkills: string[];
}

/** 读取身份卡提示词（prompts/IDENTITY_CARD.md，随 src 一起打包） */
function loadCardPrompt(): string {
  try {
    const promptPath = path.join(__dirname, '..', 'prompts', 'IDENTITY_CARD.md');
    return fs.readFileSync(promptPath, 'utf-8');
  } catch {
    return '根据对话内容生成会话身份卡 JSON（focus/summary/conclusions/relatedSkills）。';
  }
}

/** 从消息列表提取紧凑对话文本（过滤系统注入的 [工作记忆] / 【子模型提交】） */
function extractConversationText(messages: ModelMessage[], maxChars = 8000): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    let text = '';
    if (typeof m.content === 'string') {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content
        .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
        .map((p: any) => p.text)
        .join('\n');
    }
    text = text.trim();
    if (!text) continue;
    if (text.startsWith('[工作记忆]') || text.startsWith('【')) continue;
    const roleLabel = m.role === 'user' ? '用户' : m.role === 'tool' ? '工具' : '助手';
    lines.push(`${roleLabel}: ${text.slice(0, 500)}`);
    if (lines.join('\n').length >= maxChars) break;
  }
  return lines.join('\n').slice(0, maxChars);
}

/** 从模型输出中提取 JSON（容忍可能的代码块包裹） */
function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const braceStart = trimmed.indexOf('{');
  const braceEnd = trimmed.lastIndexOf('}');
  if (braceStart >= 0 && braceEnd > braceStart) {
    return trimmed.slice(braceStart, braceEnd + 1);
  }
  return trimmed;
}

/** 校验并规整身份卡字段 */
function sanitizeCard(raw: any): IdentityCard {
  const str = (v: any, fallback: string) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : fallback);
  const arr = (v: any, fallback: string[]) =>
    Array.isArray(v)
      ? v.filter((x: any) => typeof x === 'string' && x.trim()).map((x: string) => x.trim().slice(0, 120)).slice(0, 6)
      : fallback;
  return {
    focus: str(raw?.focus, '未命名会话'),
    summary: str(raw?.summary, '暂无摘要'),
    conclusions: arr(raw?.conclusions, []),
    relatedSkills: arr(raw?.relatedSkills, []),
  };
}

/**
 * 用轻量模型总结生成身份卡。
 * 失败或输入不足时返回 null（由调用方回退到动态 preview）。
 */
export async function generateIdentityCard(messages: ModelMessage[]): Promise<IdentityCard | null> {
  const text = extractConversationText(messages);
  if (!text.trim()) return null;

  try {
    const model = getLiteModel();
    const result = await generateText({
      model,
      system: loadCardPrompt(),
      messages: [{ role: 'user', content: text }],
    });
    return sanitizeCard(JSON.parse(extractJson(result.text)));
  } catch {
    return null;
  }
}

