import type { MessageHook } from '../agent';
import { getActiveModes } from './registry';
import { workingMemory, longTermMemory } from '../tools/memory-core';

/**
 * modePreProcessHook — 模式前置阶段动态分发器
 *
 * 挂在入口的 messageHook 链中（composeHooks），每次调用时读取当前激活模式，
 * 依次执行它们的 preProcess。这样模式切换无需重建 hook 链——分发器始终存在，
 * 真正执行的策略由激活模式决定。
 */
export const modePreProcessHook: MessageHook = async (messages) => {
  let current = messages;
  for (const mode of getActiveModes()) {
    if (mode.preProcess) current = await mode.preProcess(current);
  }
  return current;
};

/** 检索结果注入前缀（幂等判断 + 会话标题过滤共用） */
export const KB_INJECT_PREFIX = '[知识库检索]';

/** 值得检索的 user 消息判定：排除系统注入类消息 */
function isSearchableUserMessage(content: string): boolean {
  return (
    !content.startsWith('[工作记忆]') &&
    !content.startsWith('【') &&
    !content.startsWith(KB_INJECT_PREFIX)
  );
}

/**
 * 知识库模式的强制检索前置阶段（复刻 ima 的"回答前必然检索"）。
 * - 找到最新一条"值得检索"的 user 消息
 * - 若该消息尚未检索过，并行检索三层：工作记忆 + 长期记忆 + 知识库，
 *   将结果以 user 消息注入其前
 * - 幂等：同一 user 消息只检索一次，工具循环中的重复 hook 调用不触发
 * - 检索失败/未命中时注入占位，避免模型误以为没有知识库
 */
export function buildKbPreProcess(topK = 5): MessageHook {
  let lastInjectedQuestion = '';

  return async (messages) => {
    // 找最新一条值得检索的 user 消息
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'user' || typeof m.content !== 'string') continue;
      if (!isSearchableUserMessage(m.content)) continue;
      lastUserIdx = i;
      break;
    }
    if (lastUserIdx === -1) return messages;

    const question = (messages[lastUserIdx].content as string).slice(0, 500);
    // 幂等：同一问题内容已检索过则跳过（注入插在 user 前会致索引漂移，故用内容做键）
    if (question === lastInjectedQuestion) return messages;
    // 三层并行检索：工作记忆（同步）+ 长期记忆 + 知识库
    const workingItems = workingMemory.list().slice(0, 10);
    const [ltResults, kbResult] = await Promise.all([
      longTermMemory.recall(question, topK).catch(() => [] as Awaited<ReturnType<typeof longTermMemory.recall>>),
      queryKnowledgeBase(question, topK),
    ]);
    lastInjectedQuestion = question;
    const workingSection = workingItems.length === 0
      ? '（无工作记忆）'
      : workingItems.map((it) => `[${it.id}] (w:${it.weight.toFixed(1)}) ${it.content}`).join('\n');
    const longTermSection = ltResults.length === 0
      ? '（无相关长期记忆）'
      : ltResults.map((r, i) => `${i + 1}. ${r.content}（相似度 ${(r.score * 100).toFixed(0)}%）`).join('\n');
    const inject: { role: 'user'; content: string } = {
      role: 'user',
      content:
        `${KB_INJECT_PREFIX} 基于用户最新问题的检索结果（知识库 + 记忆）：\n\n` +
        `【工作记忆】当前对话焦点（按最近访问排序）：\n${workingSection}\n\n` +
        `【长期记忆】与问题相关的持久知识：\n${longTermSection}\n\n` +
        `【知识库】项目代码检索：\n${kbResult}\n\n` +
        '请优先基于以上检索结果回答，引用时标注来源（文件路径:行号）。' +
        '若结果与问题无关或未命中，请明确说明「知识库未命中」并基于你的理解回答。',
    };
    const out = [...messages];
    out.splice(lastUserIdx, 0, inject);
    return out;
  };
}

/** 知识库检索（失败时注入占位，避免模型误以为没有知识库） */
async function queryKnowledgeBase(question: string, topK: number): Promise<string> {
  try {
    const { kbQuery } = await import('../tools/inner_skills/kb-query/scripts/query');
    return await (kbQuery.execute as (args: any) => Promise<string>)({ question, topK, useHybrid: true });
  } catch (e: any) {
    return `⚠ 知识库检索失败：${e?.message || e}（可先运行 kb_build_index 构建索引）`;
  }
}














