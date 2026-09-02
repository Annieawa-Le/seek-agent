/**
 * runner.ts — 子模型执行引擎
 *
 * 独立运行子模型的 LLM 调用循环，支持工具调用。
 * 子模型拥有自己的消息列表、工具列表和系统提示词。
 * 当子模型调用 a_submission 时，循环结束并返回提交内容。
 *
 * ── 与主工具系统的关系 ──
 * 子模型直接使用全局注册的工具（add_patch / del_patch / replace_str 等），
 * 不维护独立暂存区。所有工具调用直接作用于主系统的文件 IO 和 diff 持久化。
 */

import { streamText, tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import { getModel } from '../../../model-provider';
import { subAgentManager } from './manager';
import { appendChatMessage } from '../../../modes/chat-thread';
import { subagentContextStore, slimMessages, cleanPersistedMessages } from '../../../tools/subagent-context-store';
import { docPoolStore } from '../../doc-pool-store';
import { unwrapToolArgs } from '../../unwrap-args';
import { recordTask, recordAssistant, recordToolCall, recordToolResult, recordSystem } from '../../../modes/subagent-stream';
import type { SubAgentState, SubmissionPayload } from './types';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactMessages, maxContextTokens, estimateMessagesTokens, findRounds } from '../../../context-compactor';
import { subagentWorklogStore } from '../../../tools/subagent-worklog-store';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 子模型系统提示词（注入工具调用说明） ──

const SUB_AGENT_SYSTEM_SUFFIX = `

## 工作流程
1. 分析分配给您的任务
2. 使用可用的工具逐步完成工作
3. 任务完成后，调用 \`a_submission\` 工具向主模型提交工作结果

## a_submission 工具
- 当您完成分配的任务后，必须调用 \`a_submission\` 来提交结果
- \`summary\`: 工作概要（一句话总结）
- \`details\`: 详细的工作过程和结果
- 调用 a_submission 后，您的工作结果将被发送回主模型`;

/** 生成身份转换 + 可用工具描述（工具名 + 一句话用途 + 相关技能使用说明） */
async function buildToolIdentityDesc(tools: string[]): Promise<string> {
  if (tools.length === 0) {
    return '你现在的身份已经转变成了一位助手，你现在可用的工具有：无。';
  }
  const registry = await getGlobalTools();
  const toolLines = tools.map((name) => {
    const impl = registry[name];
    const rawDesc = typeof impl?.description === 'string' ? impl.description.trim() : '';
    const firstLine = rawDesc.split('\n')[0]?.trim() ?? '';
    const desc = firstLine.length > 64 ? firstLine.slice(0, 61) + '…' : firstLine;
    return desc ? `- ${name}：${desc}` : `- ${name}`;
  });
  const parts = [
    '你现在的身份已经转变成了一位助手，你现在可用的工具及用途：',
    ...toolLines,
  ];
  // 工具所属 skill 的 SYSTEM_INJECTION.md（去重注入，如 browser-control 的使用说明）
  const mod = await getIndexModule();
  const getSkillInjection = (mod as any)?.getSkillInjectionForTool;
  const seen = new Set<string>();
  const injections: string[] = [];
  for (const name of tools) {
    try {
      const inj = getSkillInjection ? await getSkillInjection(name) : '';
      if (inj && !seen.has(inj)) {
        seen.add(inj);
        injections.push(inj);
      }
    } catch { /* 单个注入失败跳过 */ }
  }
  if (injections.length > 0) {
    parts.push('', '## 相关技能使用说明', injections.join('\n\n'));
  }
  return parts.join('\n');
}

// ── 公共工具函数 ──

/** 组装子模型可用的工具列表（含 a_submission 终端工具） */
async function buildChildTools(
  assignedToolNames: string[],
  onSubmission: (payload: SubmissionPayload) => void,
): Promise<Record<string, any>> {
  const childTools: Record<string, any> = {};
  const registry = await getGlobalTools();

  // a_submission —— 终端工具，调用即提交结果
  childTools['a_submission'] = tool({
    description: '向主模型提交工作结果。任务完成后调用此工具来汇报工作。',
    inputSchema: z.object({
      summary: z.string().describe('工作概要总结（一句话）'),
      details: z.string().describe('详细的工作过程和结果'),
    }),
    execute: async ({ summary, details }) => {
      onSubmission({ summary, details });
      return `[已提交] ${summary}`;
    },
  });
  // 加载被分配的工具 —— 直接从全局注册表获取
  for (const toolName of assignedToolNames) {
    if (toolName === 'a_submission') continue;
    const impl = registry[toolName];
    if (impl) {
      childTools[toolName] = impl;
    }
  }

  return childTools;
}

// ── 全局工具注册表（懒惰获取 + 缓存，避免循环依赖；ESM 下用动态 import） ──
let indexModuleCache: any = null;
async function getIndexModule(): Promise<any> {
  if (indexModuleCache) return indexModuleCache;
  try {
    indexModuleCache = await import('../../index');
    return indexModuleCache;
  } catch {
    return {};
  }
}

async function getGlobalTools(): Promise<Record<string, any>> {
  const mod = await getIndexModule();
  return (mod as any).tools ?? {};
}

// 剥离 execute 的工具定义（供 streamText，避免 AI SDK 内部自动执行工具导致双重执行）
let stripToolExecutesCache: ((t: Record<string, any>) => Record<string, any>) | null = null;
async function getStripToolExecutes(): Promise<(t: Record<string, any>) => Record<string, any>> {
  if (stripToolExecutesCache) return stripToolExecutesCache;
  const mod = await import('../../index');
  stripToolExecutesCache = (mod as any).stripToolExecutes;
  return stripToolExecutesCache!;
}

// ── 执行引擎 ──

// ── 子 Agent 上下文中途折叠 ──

/**
 * 判断子 Agent 上下文是否需要折叠（估算 token 超触发线且至少两轮真实对话）。
 * 纯函数，供工具结果累积时实时检查——不等当前轮次结束。
 */
export function shouldCompactChildContext(messages: ModelMessage[]): boolean {
  if (findRounds(messages).length <= 1) return false; // 至少保留一轮真实对话
  return estimateMessagesTokens(messages) > maxContextTokens();
}

/**
 * 子 Agent 上下文折叠：对话进行中（工具结果累积）或轮末实时压缩，
 * 超触发线时把最旧一轮折叠为 Worklog（仅一轮时跳过）。
 * @param realInputTokens 轮末传入真实 usage.inputTokens（更准）；中途估算不传
 * @param summarize 可选自定义压缩函数（测试注入 mock，生产走副模型）
 * @returns 是否发生了折叠
 */
export async function maybeCompactChildContext(
  agent: SubAgentState,
  childMessages: ModelMessage[],
  realInputTokens?: number,
  summarize?: (roundMessages: ModelMessage[]) => Promise<{ title: string; summary: string }>,
): Promise<boolean> {
  const tokens = realInputTokens ?? estimateMessagesTokens(childMessages);
  if (tokens <= maxContextTokens()) return false;
  try {
    const ownerSid = agent.ownerSessionId || subagentContextStore.getSessionId();
    subagentWorklogStore.setSessionId(ownerSid);
    subagentWorklogStore.setActiveAgent(agent.name);
    const plan = await compactMessages(
      childMessages,
      ownerSid,
      tokens,
      summarize,
      subagentWorklogStore,
    );
    if (plan) {
      childMessages.splice(0, plan.removeCount, ...plan.insertMessages);
      recordSystem(agent.name, `🧠 上下文已压缩：移除 ${plan.roundsRemoved} 轮，归档为 ${plan.worklog.id}（${plan.worklog.title}）`);
      return true;
    }
  } catch (e: any) {
    recordSystem(agent.name, `⚠ 上下文压缩失败: ${e?.message || e}`);
  }
  return false;
}

/**
 * 执行一个子 agent 的完整工作循环
 *
 * @param agent - 子 agent 状态
 * @param mainMessages - 主模型当前的消息列表（clone 模式需要）
 * @param mainSystemPrompt - 主模型的系统提示词（clone 模式需要）
 * @param task - 委派的任务
 * @param extraContext - 额外上下文
 * @returns 提交内容 JSON 字符串
 */
export async function executeChildAgent(
  agent: SubAgentState,
  mainMessages: ModelMessage[],
  mainSystemPrompt: string,
  task: string,
  extraContext?: string,
): Promise<string> {
  // 记录执行 Promise：agent_query 截停时 await 等待其完全结束（含 finally 的上下文本地化落盘），
  // 避免截停后立即启动查询循环与旧执行并发写上下文
  const ref: { current?: Promise<unknown> } = {};
  const p = doExecuteChildAgent(agent, mainMessages, mainSystemPrompt, task, extraContext, ref);
  ref.current = p;
  agent.executionPromise = p;
  return p;
}

/**
 * executeChildAgent 的实际实现（内部函数，不直接导出）。
 * 由 executeChildAgent 包装后设置 agent.executionPromise，供 agent_query 安全截停时等待。
 */
async function doExecuteChildAgent(
  agent: SubAgentState,
  mainMessages: ModelMessage[],
  mainSystemPrompt: string,
  task: string,
  extraContext?: string,
  ref?: { current?: Promise<unknown> },
): Promise<string> {
  subAgentManager.updateStatus(agent.name, 'running');

  // 所属会话绑定：执行期间上下文读写/压缩/提交均按 owner 分区，
  // 切换会话不影响后台任务（结果最终归原会话）
  const ownerSid = agent.ownerSessionId || subagentContextStore.getSessionId();

  // 中断控制：渲染层便条窗体「停止」按钮通过 agent:stop 触发 agent.abortController.abort()
  agent.abortController?.abort(); // 上一次执行遗留的 controller 作废
  const abortController = new AbortController();
  agent.abortController = abortController;
  // 任务写入消息流（便条窗体数据源）
  recordTask(agent.name, task);

  // 子模型对话历史（try 外声明，finally 统一落盘）
  const childMessages: ModelMessage[] = [];

  try {
    const toolDesc = await buildToolIdentityDesc(agent.tools ?? []);

    if (agent.mode === 'clone') {
      // clone：继承主模型完整上下文 + 身份注入 + 任务
      childMessages.push(...mainMessages);
      childMessages.push({ role: 'user', content: toolDesc });
      childMessages.push({ role: 'user', content: task });
    } else if (agent.mode === 'mission') {
      // mission：自定义系统提示（含身份描述）+ 上下文和任务
      // 上下文延续：若该子 Agent 有持久化历史（上次派活的对话），加载作为初始上下文
      const persisted = subagentContextStore.load(agent.name, ownerSid);
      if (persisted && Array.isArray(persisted.messages) && persisted.messages.length > 0) {
        const cleaned = cleanPersistedMessages(persisted.messages);
        if (cleaned.length > 0) {
          childMessages.push(...(cleaned as ModelMessage[]));
          recordSystem(agent.name, `📎 已延续上次上下文（${cleaned.length} 条历史消息）`);
        }
      }
      if (extraContext) {
        childMessages.push({ role: 'user', content: extraContext });
      }
      childMessages.push({ role: 'user', content: task });
    }

    // ── 构建子模型系统提示词 ──
    let childSystemPrompt: string;
    if (agent.mode === 'mission' && agent.systemPrompt) {
      childSystemPrompt = `${toolDesc}\n\n${agent.systemPrompt}${SUB_AGENT_SYSTEM_SUFFIX}`;
    } else if (agent.mode === 'clone') {
      childSystemPrompt = mainSystemPrompt + SUB_AGENT_SYSTEM_SUFFIX;
    } else {
      childSystemPrompt = mainSystemPrompt + SUB_AGENT_SYSTEM_SUFFIX;
    }

    // ── 捕获提交 ──
    let submission: SubmissionPayload | null = null;

    const childTools = await buildChildTools(agent.tools ?? [], (payload) => {
      submission = payload;
      // 子模型提交写入协作聊天 thread（peer 角色）
      appendChatMessage(agent.name, 'subagent', 'peer', `【提交】概要: ${payload.summary}\n详情: ${payload.details}`);
      // 提交也写入消息流（便条窗体可看到最终结果）
      recordSystem(agent.name, `📤 已提交：${payload.summary}`);
    });
    // 供 streamText 的只读 schema 版本（剥离 execute，避免 AI SDK 内部自动执行工具）
    const modelChildTools = (await getStripToolExecutes())(childTools);
    // ── LLM 循环 ──
    // 子模型持续运行直到调用 a_submission 提交结果（被 agent_fire 销毁或停止按钮中断时自然退出）
    while (!submission && subAgentManager.get(agent.name) && !abortController.signal.aborted) {

      const result = await streamText({
        model: getModel(),
        system: childSystemPrompt,
        messages: childMessages,
        tools: modelChildTools, // 剥离 execute，避免 AI SDK 内部自动执行工具导致双重执行
        abortSignal: abortController.signal, // 支持「停止」按钮中断
      });

      // 收集文本
      let fullText = '';
      for await (const chunk of result.textStream) {
        fullText += chunk;
      }

      // 收集工具调用
      const finalResult = await result;
      const calls = await finalResult.toolCalls ?? [];

      // 收集 reasoning（thinking 模式：回传时必须带 reasoning_content，否则上游 400）
      let reasoningParts: { type: 'reasoning'; text: string }[] = [];
      try {
        reasoningParts = (await result.reasoning) as { type: 'reasoning'; text: string }[];
      } catch { /* reasoning 获取失败不影响主流程 */ }

      // 文本写入消息流（便条窗体实时追踪）
      if (fullText) recordAssistant(agent.name, fullText);

      // ── 子 Agent 上下文压缩（轮末：基于真实 usage.inputTokens 精确触发） ──
      const usageTokens = (finalResult as any).usage?.inputTokens as number | undefined;
      if (typeof usageTokens === 'number') {
        await maybeCompactChildContext(agent, childMessages, usageTokens);
      }

      if (calls.length === 0) {
        // 纯文本回复——没有工具调用，视为最终输出（带 reasoning part，thinking 模式回传必需）
        const textOnlyContent: any[] = [];
        if (reasoningParts.length > 0) {
          for (const r of reasoningParts) textOnlyContent.push({ type: 'reasoning', text: r.text });
        }
        if (fullText) textOnlyContent.push({ type: 'text', text: fullText });
        if (textOnlyContent.length > 0) {
          childMessages.push({ role: 'assistant', content: textOnlyContent });
        }
        // 没有调用 a_submission，但可能是 LLM 直接回复了
        submission = {
          summary: '子模型已完成工作（未调用提交工具）',
          details: fullText || '未生成输出',
        };
        break;
      }

      // 构建 assistant 消息（含 reasoning part，thinking 模式回传必需）
      const assistantContent: any[] = [];
      if (reasoningParts.length > 0) {
        for (const r of reasoningParts) assistantContent.push({ type: 'reasoning', text: r.text });
      }
      if (fullText) assistantContent.push({ type: 'text', text: fullText });
      for (const tc of calls) {
        // 解包 _raw/input 等包装参数（模型格式漂移），让消息记录与执行都用扁平参数
        tc.input = unwrapToolArgs(tc.input);
        assistantContent.push({
          type: 'tool-call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input,
        });
        // 工具调用写入消息流
        recordToolCall(agent.name, tc.toolName, tc.toolCallId, (tc.input ?? {}) as Record<string, unknown>);
      }
      childMessages.push({ role: 'assistant', content: assistantContent });

      // 执行工具调用
      for (const tc of calls) {
        if (submission) break; // a_submission 已触发

        const impl = childTools[tc.toolName];
        if (!impl?.execute) {
          const errText = `❌ 错误: 未找到工具 ${tc.toolName}`;
          recordToolResult(agent.name, tc.toolName, tc.toolCallId, errText);
          childMessages.push({
            role: 'tool',
            content: [{
              type: 'tool-result',
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              output: { type: 'text', value: errText },
            }],
          });
          // 中途折叠：工具结果累积后实时检查，不等当前轮次结束
          await maybeCompactChildContext(agent, childMessages);
          continue;
        }
        try {
          const output = await impl.execute(
            tc.input as any,
            { toolCallId: tc.toolCallId, messages: childMessages },
          );
          const outputStr = String(output ?? '');

          // doc_pool 挂钩：读阶段记录 / 被修改文件移除（子模型关联了文件池时生效）
          docPoolStore.onToolResult(agent.name, tc.toolName, tc.input, outputStr, tc.toolCallId);

          // 重要：检查 a_submission 是否在 execute 中触发了回调
          if (submission) break;

          // 重要：检查 a_submission 是否在 execute 中触发了回调
          // 重要：检查 a_submission 是否在 execute 中触发了回调
          if (submission) break;

          // 工具结果写入消息流
          recordToolResult(agent.name, tc.toolName, tc.toolCallId, outputStr);

          childMessages.push({
            role: 'tool',
            content: [{
              type: 'tool-result',
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              output: { type: 'text', value: outputStr },
            }],
          });
          // 中途折叠：工具结果累积后实时检查，不等当前轮次结束
          await maybeCompactChildContext(agent, childMessages);
        } catch (err: any) {
          if (submission) break;
          const errMsg = `执行错误: ${err.message}`;
          recordToolResult(agent.name, tc.toolName, tc.toolCallId, errMsg);
          childMessages.push({
            role: 'tool',
            content: [{
              type: 'tool-result',
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              output: { type: 'text', value: errMsg },
            }],
          });
          // 中途折叠：工具结果累积后实时检查，不等当前轮次结束
          await maybeCompactChildContext(agent, childMessages);
        }
      }
    }
    // 中断时补充 system 消息（便条窗体可看到停止原因）
    if (abortController.signal.aborted) {
      recordSystem(agent.name, '⏹ 已停止（用户中断）');
    } else if (submission) {
      recordSystem(agent.name, `📤 子模型「${agent.name}」完成：${submission.summary}`);
    }

    // ── 记录结果 ──
    const resultStr = JSON.stringify(submission);
    subAgentManager.setSubmission(agent.name, resultStr);
    return resultStr;

  } catch (err: any) {
    // 用户停止（abort）视为正常结束：状态标记为 error（UI 显示「已停止」）并写入消息流
    if (abortController.signal.aborted || err?.name === 'AbortError' || String(err?.message || '').includes('abort')) {
      recordSystem(agent.name, '⏹ 已停止（用户中断）');
      subAgentManager.setError(agent.name, '已停止（用户中断）');
      return JSON.stringify({ summary: '已停止', details: '子模型执行被用户中断' });
    }
    const errorMsg = `子模型执行出错: ${err.message}`;
    recordSystem(agent.name, `❌ ${errorMsg}`);
    subAgentManager.setError(agent.name, errorMsg);
    return JSON.stringify({ summary: '执行失败', details: errorMsg });
  } finally {
    // 执行结束，清掉 controller 引用（防止 agent_fire 误 abort 已结束的执行）
    if (agent.abortController === abortController) {
      agent.abortController = undefined;
    }
    // 执行结束，清掉 executionPromise 引用（agent_query 截停等待已完成，避免误等旧 promise）
    if (ref?.current && agent.executionPromise === ref.current) {
      agent.executionPromise = undefined;
    }
    // 上下文本地化：无论提交 / 中断 / 出错，都把对话历史落盘（按 owner 会话分区），供下次派活延续
    if (agent.mode === 'mission' && childMessages.length > 0) {
      subagentContextStore.save(agent.name, {
        name: agent.name,
        mode: agent.mode,
        tools: agent.tools ?? [],
        systemPrompt: agent.systemPrompt,
        context: agent.context,
        requirement: agent.requirement,
        maxRounds: agent.maxRounds,
        createdAt: agent.createdAt,
        messages: slimMessages(childMessages),
      }, ownerSid);
    }
  }
}

// ── Instructor 执行引擎 ──

/** 内置默认 instructor 提示词（src/prompts/INSTRUCTOR.md 缺失/解析失败时回退） */
const DEFAULT_INSTRUCTOR_PROMPT = `你是一个开发指导助手。你的任务是按照以下要求发散思维：

{{requirement}}

每次你收到主模型的最新输出后，基于它进行发散思考，提出下一步开发的建议方向。
你的输出会作为用户消息注入主模型，推动开发进程。
请保持思维的发散性、创造性和建设性。

注意：
- 每次只提交一轮思考结果
- 不需要使用工具，直接输出文本
- 使用 markdown 格式输出，让内容更易读
- 输出应简洁有深度，不要过长
{{extraInstruction}}`;

/**
 * 加载 instructor 提示词模板（src/prompts/INSTRUCTOR.md），替换占位符。
 * 每次执行时读盘，便于用户编辑文件后即时生效；文件缺失时回退内置默认。
 */
export function loadInstructorPrompt(requirement: string, extraInstruction: string): string {
  const render = (tpl: string) =>
    tpl.replaceAll('{{requirement}}', requirement).replaceAll('{{extraInstruction}}', extraInstruction);
  try {
    const promptPath = path.join(__dirname, '..', '..', '..', 'prompts', 'INSTRUCTOR.md');
    if (fs.existsSync(promptPath)) {
      let tpl = fs.readFileSync(promptPath, 'utf-8').replace(/<!--[\s\S]*?-->/g, ''); // 剥离 HTML 注释（占位符说明等编辑辅助文字不进模型上下文）
      if (tpl.includes('{{requirement}}')) return render(tpl.trim());
    }
  } catch { /* 读盘失败回退默认 */ }
  return render(DEFAULT_INSTRUCTOR_PROMPT);
}


/**
 * 执行 instructor 模式：主模型每轮工作完成后，发散思维提出建议。
 * instructor 有自己独立的消息历史，每次调用时追加主模型最新输出，
 * 生成建议后返回给主模型。
 *
 * @param agent - instructor agent 状态
 * @param lastAssistantOutput - 主模型上一轮最后输出的文本
 * @returns 要注入主模型的文本，或 null 表示无输出
 */
export async function executeInstructorAgent(
  agent: SubAgentState,
  lastAssistantOutput: string,
): Promise<string | null> {
  subAgentManager.updateStatus(agent.name, 'running');

  // 每次执行使用独立的 AbortController（fire / agent 退出时可中断后台流）；
  // 上一次执行结束后旧 signal 作废
  agent.instructorAbortController?.abort();
  const abortController = new AbortController();
  agent.instructorAbortController = abortController;

  try {
    const requirement = agent.requirement || '对下一步开发提出建设性建议';
    const extraInstruction = agent.systemPrompt ? '\n\n额外指导：\n' + agent.systemPrompt : '';

    // 提示词模板来自 src/prompts/INSTRUCTOR.md（可自定义，每次执行读盘），缺失时回退内置默认
    const systemPrompt = loadInstructorPrompt(requirement, extraInstruction);

    // ── 根据轮次注入周期性提醒 ──
    const roundCount = agent.instructorRoundCount || 0;
    const periodicHints: string[] = [];
    if (roundCount > 0 && roundCount % 8 === 0) {
      periodicHints.push(`【系统提醒】已到第 ${roundCount + 1} 轮，请提醒主模型清理 2 轮前的工具调用结果，保持上下文整洁。`);
    } else if (roundCount > 0 && roundCount % 3 === 0) {
      periodicHints.push(`【系统提醒】已到第 ${roundCount + 1} 轮，请提醒主模型运行测试，确保功能正确性。`);
    }

    // 构建 instructor 独立消息列表
    const msgs: ModelMessage[] = [
      ...(agent.instructorMessages || []),
      ...periodicHints.map(h => ({ role: 'user' as const, content: h })),
      { role: 'user' as const, content: `主模型最新输出：

${lastAssistantOutput}` },
    ];

    const result = await streamText({
      model: getModel(),
      system: systemPrompt,
      messages: msgs,
      abortSignal: abortController.signal,
    });

    let fullText = '';
    for await (const chunk of result.textStream) {
      // 中断信号到达时停止收集（AbortError 由下方 catch 统一处理）
      if (abortController.signal.aborted) break;
      fullText += chunk;
    }

    if (!fullText.trim()) {
      subAgentManager.updateStatus(agent.name, 'done');
      return null;
    }

    // 收集 reasoning（thinking 模式：历史回传时必须带 reasoning_content，否则上游 400）
    let reasoningParts: { type: 'reasoning'; text: string }[] = [];
    try {
      reasoningParts = (await result.reasoning) as { type: 'reasoning'; text: string }[];
    } catch { /* reasoning 获取失败不影响主流程 */ }

    // 保存到 instructor 自己的历史（截断到最近 6 条 = 3 轮对话，防止上下文被旧轮次淹没）
    const assistantContent: any[] = [];
    if (reasoningParts.length > 0) {
      for (const r of reasoningParts) assistantContent.push({ type: 'reasoning', text: r.text });
    }
    assistantContent.push({ type: 'text', text: fullText });
    const newHistory = [
      ...msgs,
      { role: 'assistant' as const, content: assistantContent },
    ];
    agent.instructorMessages = newHistory.length > 6
      ? newHistory.slice(-6)
      : newHistory;
    agent.instructorRoundCount = (agent.instructorRoundCount || 0) + 1;

    subAgentManager.updateStatus(agent.name, 'done');
    return fullText;

  } catch (err: any) {
    // 中断视为正常结束（fire / agent 退出），不产生建议也不污染状态
    if (err?.name === 'AbortError' || err?.message?.includes('abort') || abortController.signal.aborted) {
      subAgentManager.updateStatus(agent.name, 'done');
      return null;
    }
    // 上游/网络错误：静默复位状态（下次主模型轮次仍可触发），错误细节留到 error 字段
    agent.error = `instructor 出错: ${err.message}`;
    subAgentManager.updateStatus(agent.name, 'done');
    return null;
  } finally {
    // 执行结束，清掉引用（agent 销毁时不再误 abort 已结束的流）
    if (agent.instructorAbortController === abortController) {
      agent.instructorAbortController = undefined;
    }
  }
}

/**
 * 安全截停子模型的当前执行：abort 正在运行的流（mission/clone 走 abortController、
 * instructor 走 instructorAbortController），并等待 executionPromise 完全结束——
 * 旧执行在 finally 里保存上下文本地化，避免与新循环并发写。
 * 纯逻辑函数，供 agent_query 与测试直接使用。
 */
export async function abortAndWaitChildExecution(agent: SubAgentState): Promise<void> {
  agent.abortController?.abort();
  agent.instructorAbortController?.abort();
  if (agent.executionPromise) {
    try { await agent.executionPromise; } catch { /* 忽略结束状态 */ }
  }
}

/**
 * 构建 agent_query 提问时的子模型消息列表。
 * 与 executeChildAgent 对齐：提问时携带子模型自身的工作上下文，而非从零开始——
 *   clone 模式：主模型完整消息
 *   mission 模式：持久化对话历史（subagentContextStore 落盘的上次派活上下文），无历史时回退 spawn 时的 context
 *   instructor 模式：instructor 独立消息历史
 * 最后追加主模型的 question。
 */
export function buildQueryChildMessages(
  agent: SubAgentState,
  mainMessages: ModelMessage[],
  question: string,
): ModelMessage[] {
  const childMessages: ModelMessage[] = [];
  if (agent.mode === 'clone') {
    childMessages.push(...mainMessages);
  } else if (agent.mode === 'mission') {
    // 上下文延续：加载持久化历史（上次派活对话），让提问基于子模型自己的工作背景
    const persisted = subagentContextStore.load(agent.name, agent.ownerSessionId || subagentContextStore.getSessionId());
    if (persisted && Array.isArray(persisted.messages) && persisted.messages.length > 0) {
      const cleaned = cleanPersistedMessages(persisted.messages);
      if (cleaned.length > 0) {
        childMessages.push(...(cleaned as ModelMessage[]));
      }
    }
    // 首次提问（尚未派过活）：回退到 spawn 时的原始上下文，避免空上下文提问
    if (childMessages.length === 0 && agent.context) {
      childMessages.push({ role: 'user', content: agent.context });
    }
  } else if (agent.mode === 'instructor') {
    const hist = agent.instructorMessages || [];
    if (hist.length > 0) childMessages.push(...hist);
  }
  childMessages.push({ role: 'user', content: question });
  return childMessages;
}

/**
 * 向子模型发起查询（agent_query 核心）：
 * 1. 安全截停正在运行的执行（abort + 等待 executionPromise 完全结束，含 finally 的上下文本地化落盘，
 *    避免截停后立即启动查询循环与旧执行并发写上下文）
 * 2. 把 question 以 user 消息注入子模型对话流（buildQueryChildMessages 已把 question 追加为末条 user 消息）
 * 3. 运行带工具的短循环，取子模型返回的第一条文本作为结果（纯工具调用轮会继续直到出现文本，
 *    最多 MAX_QUERY_ROUNDS 轮防失控）
 * @returns 子模型的第一条文本回答
 */
export async function queryChildAgent(
  agent: SubAgentState,
  mainMessages: ModelMessage[],
  mainSystemPrompt: string,
  question: string,
): Promise<string> {
  const ownerSid = agent.ownerSessionId || subagentContextStore.getSessionId();

  // ── 1. 安全截停正在运行的执行（abort + 等待收尾保存上下文，避免并发写） ──
  await abortAndWaitChildExecution(agent);

  const toolDesc = await buildToolIdentityDesc(agent.tools ?? []);

  // ── 2. 以 user 消息注入 question（携带子模型自身工作上下文） ──
  const childMessages = buildQueryChildMessages(agent, mainMessages, question);

  let systemPrompt: string;
  if (agent.mode === 'mission' && agent.systemPrompt) {
    systemPrompt = `${toolDesc}\n\n${agent.systemPrompt}`;
  } else {
    systemPrompt = `${toolDesc}\n\n${mainSystemPrompt}`;
  }

  // 截停会令旧执行标记 error（已停止），查询开始前清掉，状态置 running
  agent.error = undefined;
  subAgentManager.updateStatus(agent.name, 'running');

  try {
    // ── 3. 带工具短循环：收集第一条文本 ──
    const childTools = await buildChildTools(agent.tools ?? [], () => {});
    const modelChildTools = (await getStripToolExecutes())(childTools);

    let firstText = '';
    const MAX_QUERY_ROUNDS = 5; // 子模型可能为回答问题先读文件/搜索，但最多 N 轮防失控
    for (let round = 0; round < MAX_QUERY_ROUNDS && !firstText; round++) {
      const result = await streamText({
        model: getModel(),
        system: systemPrompt,
        messages: childMessages,
        tools: modelChildTools, // 剥离 execute，避免 AI SDK 内部自动执行工具导致双重执行
      });

      // 收集文本
      let fullText = '';
      for await (const chunk of result.textStream) {
        fullText += chunk;
      }

      // 收集工具调用
      const finalResult = await result;
      const calls = (await finalResult.toolCalls) ?? [];

      // 收集 reasoning（thinking 模式：历史回传时必须带 reasoning_content，否则上游 400）
      let reasoningParts: { type: 'reasoning'; text: string }[] = [];
      try {
        reasoningParts = (await result.reasoning) as { type: 'reasoning'; text: string }[];
      } catch { /* reasoning 获取失败不影响主流程 */ }

      if (fullText) {
        firstText = fullText; // 第一条文本即答案
        recordAssistant(agent.name, fullText);
      }

      // 构建 assistant 消息（含 reasoning + 工具调用），push 进对话流（问答保持连贯）
      const assistantContent: any[] = [];
      if (reasoningParts.length > 0) {
        for (const r of reasoningParts) assistantContent.push({ type: 'reasoning', text: r.text });
      }
      if (fullText) assistantContent.push({ type: 'text', text: fullText });
      for (const tc of calls) {
        // 解包 _raw/input 等包装参数（模型格式漂移），让消息记录与执行都用扁平参数
        tc.input = unwrapToolArgs(tc.input);
        assistantContent.push({
          type: 'tool-call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input,
        });
        recordToolCall(agent.name, tc.toolName, tc.toolCallId, (tc.input ?? {}) as Record<string, unknown>);
      }
      if (assistantContent.length > 0) childMessages.push({ role: 'assistant', content: assistantContent });

      // 执行工具调用（子模型可能为回答问题先读文件/搜索）
      for (const tc of calls) {
        const impl = childTools[tc.toolName];
        if (!impl?.execute) {
          const errText = `❌ 错误: 未找到工具 ${tc.toolName}`;
          recordToolResult(agent.name, tc.toolName, tc.toolCallId, errText);
          childMessages.push({
            role: 'tool',
            content: [{ type: 'tool-result', toolCallId: tc.toolCallId, toolName: tc.toolName, output: { type: 'text', value: errText } }],
          });
          continue;
        }
        try {
          const output = await impl.execute(
            tc.input as any,
            { toolCallId: tc.toolCallId, messages: childMessages },
          );
          const outputStr = String(output ?? '');
          // doc_pool 挂钩：读阶段记录 / 被修改文件移除（子模型关联了文件池时生效）
          docPoolStore.onToolResult(agent.name, tc.toolName, tc.input, outputStr, tc.toolCallId);
          recordToolResult(agent.name, tc.toolName, tc.toolCallId, outputStr);
          childMessages.push({
            role: 'tool',
            content: [{ type: 'tool-result', toolCallId: tc.toolCallId, toolName: tc.toolName, output: { type: 'text', value: outputStr } }],
          });
        } catch (err: any) {
          const errMsg = `执行错误: ${err.message}`;
          recordToolResult(agent.name, tc.toolName, tc.toolCallId, errMsg);
          childMessages.push({
            role: 'tool',
            content: [{ type: 'tool-result', toolCallId: tc.toolCallId, toolName: tc.toolName, output: { type: 'text', value: errMsg } }],
          });
        }
      }

      // 既无文本也无工具调用 → 无法继续，退出
      if (!fullText && calls.length === 0) break;
    }

    return firstText || '(子模型未产生文本输出)';
  } catch (err: any) {
    return `查询出错: ${err.message}`;
  } finally {
    subAgentManager.updateStatus(agent.name, 'done');
    // 问答写入子模型对话流（mission 模式）：让下次派活/提问延续本次问答
    if (agent.mode === 'mission' && childMessages.length > 0) {
      subagentContextStore.save(agent.name, {
        name: agent.name,
        mode: agent.mode,
        tools: agent.tools ?? [],
        systemPrompt: agent.systemPrompt,
        context: agent.context,
        requirement: agent.requirement,
        maxRounds: agent.maxRounds,
        createdAt: agent.createdAt,
        messages: slimMessages(childMessages),
      }, ownerSid);
    }
  }
}
















































































