/**
 * memory-dreaming.ts — 做梦沉淀机制
 *
 * 借鉴 shards 的 dreaming 设计：定期把「工作记忆」中的碎片交给模型提炼，
 * 沉淀为跨会话仍有价值的长期知识（规则 / 决策 / 偏好 / 事实），写入长期记忆。
 *
 * 触发策略（针对交互式编程助手，无"闲时"概念）：
 *   每轮对话结束后由 postRoundHook 调用，但仅当未沉淀条目达到阈值时才真正
 *   调用模型（避免每轮都产生 LLM 开销）；未达标时近乎零成本跳过。
 */

import { generateText } from 'ai';
import type { ModelMessage } from 'ai';
import { getLiteModel } from '../model-provider';
import { workingMemory, longTermMemory } from './memory-core';
import type { WorkingMemoryItem } from './memory-core';
/** 触发阈值：未沉淀工作记忆达到该数量才跑一次 dreaming */
const DREAM_THRESHOLD = 3;

/** 提炼提示词（借鉴 shards dreaming.md，针对编程助手场景裁剪） */
const DREAMING_PROMPT = `# Role
你是 AI 编程助手 seek-agent 的「记忆沉淀师」。你的任务是从近期的工作记忆碎片中，提炼出跨会话仍有长期价值的知识，输出为去语境化的绝对陈述句。

# Inputs
1. [Working Memory]: 未沉淀的工作记忆条目（含内容与权重）。
2. [Recent Conversation]: 最近几轮对话记录（仅作参考，无需逐条总结）。

# Task
全面扫描输入，挖掘以下维度的长期知识：
1. 【规则】：项目的技术约定、工具使用规范（如"测试用 Vitest"）。
2. 【决策】：重要的技术决策及原因（如"改用 patch 暂存区避免行号漂移"）。
3. 【偏好】：用户明确表达过的偏好（如"不喜欢过度重构"）。
4. 【事实】：稳定的项目/环境事实（如"embedding 由本地 Ollama 提供"）。
不要嫌弃细碎，微小的约定也值得记录；但必须过滤瞬时状态（"正在调试"、"老板很生气"）和对话流水账。

# Output Format
你必须且只能输出一个合法的 JSON Array，每项是一条独立的绝对陈述句字符串。如果没有任何值得沉淀的内容，输出 []。
["规则：xxx", "决策：xxx", "偏好：xxx", "事实：xxx"]

# 生死红线
1. 绝对禁止代词：严禁"他"、"那个"、"这个"、"昨天"，必须用具体名称/事物。
2. 禁止流水账：不记录单次事件，只提炼可复用的模式。
3. 建议加前缀：规则：/ 决策：/ 偏好：/ 事实：。`;

export interface DreamingResult {
  /** 是否因未达标而跳过（未调用模型） */
  skipped: boolean;
  /** 实际沉淀（成功写入长期记忆）的条数 */
  precipitated: number;
  reason?: string;
}

/**
 * 做梦沉淀：把未沉淀的工作记忆提炼为长期知识。
 * @param recentHistory 最近对话（可选，作为提炼上下文）
 */
export async function dreaming(recentHistory?: ModelMessage[]): Promise<DreamingResult> {
  const undreamed = workingMemory.listUndreamed();
  if (undreamed.length < DREAM_THRESHOLD) {
    return {
      skipped: true,
      precipitated: 0,
      reason: `未沉淀条目 ${undreamed.length} < 阈值 ${DREAM_THRESHOLD}`,
    };
  }

  // 最近对话取尾部若干条，压缩为纯文本供模型参考
  const recent = (recentHistory ?? []).slice(-12).map((m) => ({
    role: m.role,
    content: typeof m.content === 'string'
      ? m.content.slice(0, 2000)
      : `[${m.role} 结构化消息]`,
  }));

  let text: string;
  try {
    const model = getLiteModel();
    const result = await generateText({
      model,
      system: DREAMING_PROMPT,
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            workingMemory: undreamed.map((it: WorkingMemoryItem) => ({
              id: it.id,
              content: it.content,
              weight: it.weight,
            })),
            recentConversation: recent,
          }),
        },
      ],
    });
    text = result.text;
  } catch (e: any) {
    return { skipped: false, precipitated: 0, reason: `模型调用失败: ${e?.message || e}` };
  }

  const entries = parseDreamOutput(text);
  let precipitated = 0;
  for (const entry of entries) {
    try {
      const outcome = await longTermMemory.remember(entry);
      if (outcome.added) precipitated++;
    } catch {
      // 单条写入失败（如 embedding 不可用）不影响整体
    }
  }
  // 无论提炼出多少，本次扫描过的条目都标记为已沉淀，避免下次重复扫描
  workingMemory.markDreamed(undreamed.map((it) => it.id));
  return { skipped: false, precipitated };
}

/** 从模型输出中解析 JSON 数组（容忍 markdown 代码块包裹） */
function parseDreamOutput(text: string): string[] {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const tryParse = (s: string): string[] | null => {
    try {
      const data = JSON.parse(s);
      if (Array.isArray(data)) {
        return data.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
      }
    } catch { /* ignore */ }
    return null;
  };

  const direct = tryParse(cleaned);
  if (direct) return direct;

  // 回退：提取第一个 [...] 片段
  const m = cleaned.match(/\[[\s\S]*\]/);
  if (m) {
    const fallback = tryParse(m[0]);
    if (fallback) return fallback;
  }
  return [];
}







