/**
 * runner.ts — 子模型执行引擎
 *
 * 独立运行子模型的 LLM 调用循环，支持工具调用。
 * 子模型拥有自己的消息列表、工具列表和系统提示词。
 * 当子模型调用 a_submission 时，循环结束并返回提交内容。
 *
 * ── 与主工具系统的关系 ──
 * 子模型直接使用全局注册的工具（add_patch / del_patch / modify_patch 等），
 * 不维护独立暂存区。所有工具调用直接作用于主系统的文件 IO 和 diff 持久化。
 */

import { streamText, tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import { getModel } from '../../../model-provider';
import { subAgentManager } from './manager';
import type { SubAgentState, SubmissionPayload } from './types';

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

/** 生成身份转换 + 可用工具描述 */
function buildToolIdentityDesc(tools: string[]): string {
  const toolList = tools.length > 0 ? tools.join('、') : '无';
  return `你现在的身份已经转变成了一位助手，你现在可用的工具有：${toolList}。`;
}

// ── 公共工具函数 ──

/** 组装子模型可用的工具列表（含 a_submission 终端工具） */
function buildChildTools(
  assignedToolNames: string[],
  onSubmission: (payload: SubmissionPayload) => void,
): Record<string, any> {
  const childTools: Record<string, any> = {};
  const registry = getGlobalTools();

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

// ── 全局工具注册表（懒惰获取，避免循环依赖） ──
function getGlobalTools(): Record<string, any> {
  // 动态引入主系统的工具容器
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { tools } = require('../../index') as { tools: Record<string, any> };
    return tools;
  } catch {
    return {};
  }
}

// ── 执行引擎 ──

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
  subAgentManager.updateStatus(agent.name, 'running');

  try {
    // ── 构建子模型消息列表 ──
    const childMessages: ModelMessage[] = [];

    const toolDesc = buildToolIdentityDesc(agent.tools ?? []);

    if (agent.mode === 'clone') {
      // clone：继承主模型完整上下文 + 身份注入 + 任务
      childMessages.push(...mainMessages);
      childMessages.push({ role: 'user', content: toolDesc });
      childMessages.push({ role: 'user', content: task });
    } else if (agent.mode === 'mission') {
      // mission：自定义系统提示（含身份描述）+ 上下文和任务
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

    const childTools = buildChildTools(agent.tools ?? [], (payload) => {
      submission = payload;
    });

    // ── LLM 循环 ──
    let loopCount = 0;
    const MAX_LOOPS = 20; // 防止无限循环

    while (!submission && loopCount < MAX_LOOPS) {
      loopCount++;

      const result = await streamText({
        model: getModel(),
        system: childSystemPrompt,
        messages: childMessages,
        tools: childTools,
      });

      // 收集文本
      let fullText = '';
      for await (const chunk of result.textStream) {
        fullText += chunk;
      }

      // 收集工具调用
      const finalResult = await result;
      const calls = await finalResult.toolCalls ?? [];

      if (calls.length === 0) {
        // 纯文本回复——没有工具调用，视为最终输出
        if (fullText) {
          childMessages.push({ role: 'assistant', content: fullText });
        }
        // 没有调用 a_submission，但可能是 LLM 直接回复了
        submission = {
          summary: '子模型已完成工作（未调用提交工具）',
          details: fullText || '未生成输出',
        };
        break;
      }

      // 构建 assistant 消息
      const assistantContent: any[] = [];
      if (fullText) assistantContent.push({ type: 'text', text: fullText });
      for (const tc of calls) {
        assistantContent.push({
          type: 'tool-call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input,
        });
      }
      childMessages.push({ role: 'assistant', content: assistantContent });

      // 执行工具调用
      for (const tc of calls) {
        if (submission) break; // a_submission 已触发

        const impl = childTools[tc.toolName];
        if (!impl?.execute) {
          childMessages.push({
            role: 'tool',
            content: [{
              type: 'tool-result',
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              output: { type: 'text', value: `❌ 错误: 未找到工具 ${tc.toolName}` },
            }],
          });
          continue;
        }

        try {
          const output = await impl.execute(
            tc.input as any,
            { toolCallId: tc.toolCallId, messages: childMessages },
          );
          const outputStr = String(output ?? '');

          // 重要：检查 a_submission 是否在 execute 中触发了回调
          if (submission) break;

          childMessages.push({
            role: 'tool',
            content: [{
              type: 'tool-result',
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              output: { type: 'text', value: outputStr },
            }],
          });
        } catch (err: any) {
          if (submission) break;
          childMessages.push({
            role: 'tool',
            content: [{
              type: 'tool-result',
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              output: { type: 'text', value: `执行错误: ${err.message}` },
            }],
          });
        }
      }
    }

    if (loopCount >= MAX_LOOPS && !submission) {
      submission = {
        summary: '子模型执行达到最大循环次数',
        details: '子模型未能及时调用 a_submission 提交结果，已强制终止。',
      };
    }

    // ── 记录结果 ──
    const resultStr = JSON.stringify(submission);
    subAgentManager.setSubmission(agent.name, resultStr);
    return resultStr;

  } catch (err: any) {
    const errorMsg = `子模型执行出错: ${err.message}`;
    subAgentManager.setError(agent.name, errorMsg);
    return JSON.stringify({ summary: '执行失败', details: errorMsg });
  }
}

// ── Instructor 执行引擎 ──

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

  try {
    const requirement = agent.requirement || '对下一步开发提出建设性建议';
    const extraPrompt = agent.systemPrompt ? `

额外指导：
${agent.systemPrompt}` : '';

    const systemPrompt = `你是一个开发指导助手。你的任务是按照以下要求发散思维：

${requirement}

每次你收到主模型的最新输出后，基于它进行发散思考，提出下一步开发的建议方向。
你的输出会作为用户消息注入主模型，推动开发进程。
请保持思维的发散性、创造性和建设性。

注意：
- 每次只提交一轮思考结果
- 不需要使用工具，直接输出文本
- 使用 markdown 格式输出，让内容更易读
- 输出应简洁有深度，不要过长${extraPrompt}`;

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
    });

    let fullText = '';
    for await (const chunk of result.textStream) {
      fullText += chunk;
    }

    if (!fullText.trim()) {
      subAgentManager.updateStatus(agent.name, 'done');
      return null;
    }

    // 保存到 instructor 自己的历史（截断到最近 6 条 = 3 轮对话，防止上下文被旧轮次淹没）
    const newHistory = [
      ...msgs,
      { role: 'assistant' as const, content: fullText },
    ];
    agent.instructorMessages = newHistory.length > 6
      ? newHistory.slice(-6)
      : newHistory;
    agent.instructorRoundCount = (agent.instructorRoundCount || 0) + 1;

    subAgentManager.updateStatus(agent.name, 'done');
    return fullText;

  } catch (err: any) {
    const errorMsg = `instructor 出错: ${err.message}`;
    subAgentManager.setError(agent.name, errorMsg);
    return null;
  }
}

/**
 * 向子模型发起轻量查询（不调工具，只回答问题）
 * 返回子模型的文本回答
 */
export async function queryChildAgent(
  agent: SubAgentState,
  mainMessages: ModelMessage[],
  mainSystemPrompt: string,
  question: string,
): Promise<string> {
  const toolDesc = buildToolIdentityDesc(agent.tools ?? []);

  // 构建上下文
  const childMessages: ModelMessage[] = [];
  if (agent.mode === 'clone') {
    childMessages.push(...mainMessages);
  }

  let systemPrompt: string;
  if (agent.mode === 'mission' && agent.systemPrompt) {
    systemPrompt = `${toolDesc}\n\n${agent.systemPrompt}`;
  } else {
    systemPrompt = `${toolDesc}\n\n${mainSystemPrompt}`;
  }

  childMessages.push({ role: 'user', content: question });

  try {
    const { streamText } = await import('ai');
    const result = await streamText({
      model: getModel(),
      system: systemPrompt,
      messages: childMessages,
    });

    let fullText = '';
    for await (const chunk of result.textStream) {
      fullText += chunk;
    }
    return fullText || '(无回答)';
  } catch (err: any) {
    return `查询出错: ${err.message}`;
  }
}

