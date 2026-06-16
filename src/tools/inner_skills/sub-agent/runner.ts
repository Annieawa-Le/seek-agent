/**
 * runner.ts — 子模型执行引擎
 *
 * 独立运行子模型的 LLM 调用循环，支持工具调用。
 * 子模型拥有自己的消息列表、工具列表和系统提示词。
 * 当子模型调用 a_submission 时，循环结束并返回提交内容。
 */

import { streamText, tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import { getModel } from '../../../model-provider';
import { getToolRegistry, subAgentManager } from './manager';
import { type PendingPatch } from '../../patch-staging';
import type { SubAgentState, SubmissionPayload } from './types';
import { applyPatchesToFile } from '../../file-manipulation';

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

// ── listen 模式系统提示词 ──

const LISTEN_SYSTEM_PROMPT = `您是一个专门分析工具调用的监听型 AI 助手。
您的工作是分析主模型在某一轮中调用的工具记录，并按照指定的格式返回分析结果。
请仔细分析提供的工具调用数据，关注指定的分析方面。

## 输出规则
- 只有当发现**值得注意的问题或重要发现**时，才调用 a_submission 工具提交分析结果
- 对于 add_patch / del_patch / modify_patch 等文件修改操作：
  * 如果是**小问题**（缩进错误、命名不规范、注释错误等），直接调用 revise_patch 自主修复，**不要调用 a_submission**
  * 如果是**无法确认的破损**（逻辑疑似错误、改动意图不明确、可能破坏功能等），调用 a_submission 向主模型报告并等待指示
  * 如果一切正常，**什么都不做**
- 频繁提交无价值的分析结果会干扰主模型工作，请保持克制`;


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
  localPatchStaging?: import('../../patch-staging').PatchStaging,
): Record<string, any> {
  const childTools: Record<string, any> = {};
  const registry = getToolRegistry();

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

  // 加载被分配的工具
  for (const toolName of assignedToolNames) {
    if (toolName === 'a_submission') continue;
    const impl = registry[toolName];
    if (impl) {
      childTools[toolName] = impl;
    }
  }
  // 如果子模型有独立暂存区，用本地版本替换全局 patch 工具
  if (localPatchStaging) {
    const PATCH_TOOL_NAMES = ['add_patch','del_patch','modify_patch','ensure_patch','pop_patch','check_patch','revise_patch'];
    for (const name of PATCH_TOOL_NAMES) {
      if (!assignedToolNames.includes(name)) continue;
      childTools[name] = buildLocalPatchTool(name, localPatchStaging);
    }
  }

  return childTools;
}

// ── 执行引擎 ──

/**
* 使用子模型的独立暂存区构建本地 patch 工具
*/
function buildLocalPatchTool(
  toolName: string,
  staging: import('../../patch-staging').PatchStaging,
): any {
  switch (toolName) {
    case 'add_patch':
      return tool({
        description: '[本地暂存] 向子模型的独立暂存区添加插入行操作。暂存区中的修改不会立即应用到文件，需要 ensure_patch 确认。',
        inputSchema: z.object({
          filePath: z.string(),
          lineIndex: z.number(),
          Lines: z.array(z.string()),
        }),
        execute: async ({ filePath, lineIndex, Lines }) => {
          if (!filePath?.trim()) return '错误：文件路径不能为空';
          const path = require('path');
          const resolvedPath = path.resolve(filePath);
          const desc = `插入 ${Lines?.length || 0} 行到行 ${lineIndex}`;
          staging.add({
            type: 'add',
            rawFilePath: filePath,
            resolvedPath,
            description: desc,
            params: { lineIndex, Lines },
            createdAt: Date.now(),
            sessionId: staging.getSessionId(),
          });
          return `[本地暂存] ${desc}\n■ 暂存区现有 ${staging.size} 个待应用的修改`;
        },
      });

    case 'del_patch':
      return tool({
        description: '[本地暂存] 向子模型的独立暂存区添加删除行操作。',
        inputSchema: z.object({
          filePath: z.string(),
          lineIndex: z.array(z.array(z.number())),
        }),
        execute: async ({ filePath, lineIndex }) => {
          if (!filePath?.trim()) return '错误：文件路径不能为空';
          const path = require('path');
          const resolvedPath = path.resolve(filePath);
          const desc = `删除 ${lineIndex?.length || 0} 个范围`;
          staging.add({
            type: 'del',
            rawFilePath: filePath,
            resolvedPath,
            description: desc,
            params: { lineIndex },
            createdAt: Date.now(),
            sessionId: staging.getSessionId(),
          });
          return `[本地暂存] ${desc}\n■ 暂存区现有 ${staging.size} 个待应用的修改`;
        },
      });

    case 'modify_patch':
      return tool({
        description: '[本地暂存] 向子模型的独立暂存区添加修改行操作。',
        inputSchema: z.object({
          filePath: z.string(),
          startLine: z.number(),
          endLine: z.number(),
          replaceLines: z.array(z.string()),
        }),
        execute: async ({ filePath, startLine, endLine, replaceLines }) => {
          if (!filePath?.trim()) return '错误：文件路径不能为空';
          const path = require('path');
          const resolvedPath = path.resolve(filePath);
          const desc = `修改行 ${startLine}-${endLine}`;
          staging.add({
            type: 'modify',
            rawFilePath: filePath,
            resolvedPath,
            description: desc,
            params: { startLine, endLine, replaceLines },
            createdAt: Date.now(),
            sessionId: staging.getSessionId(),
          });
          return `[本地暂存] ${desc}\n■ 暂存区现有 ${staging.size} 个待应用的修改`;
        },
      });

    case 'ensure_patch':
      return tool({
        description: '[本地暂存] 应用或放弃子模型的独立暂存区中的所有修改。应用后直接写入文件。',
        inputSchema: z.object({
          apply: z.boolean(),
        }),
        execute: async ({ apply }) => {
          if (staging.isEmpty()) {
            return '[本地暂存区] 为空，无需操作。';
          }
          const count = staging.size;
          if (!apply) {
            staging.clear();
            return `[本地暂存] 已放弃 ${count} 个修改。`;
          }
          // 直接应用所有暂存修改到文件
          const patches = staging.getAll();
          const allResults: string[] = [];
          let totalFailed = 0;

          const byFile = new Map<string, PendingPatch[]>();
          for (const p of patches) {
            const key = p.resolvedPath;
            if (!byFile.has(key)) byFile.set(key, []);
            byFile.get(key)!.push(p);
          }

          allResults.push(`[本地暂存] 开始应用 ${patches.length} 个修改到 ${byFile.size} 个文件...`);

          let fileIdx = 0;
          for (const [filePath, filePatches] of byFile) {
            fileIdx++;
            try {
              const fileResults = await applyPatchesToFile(filePath, filePatches);
              allResults.push(`  📄 [${fileIdx}] ${filePath}`);
              allResults.push(...fileResults);
            } catch (err: any) {
              totalFailed += filePatches.length;
              allResults.push(`  ❌ [${fileIdx}] ${filePath}: ${err.message}`);
            }
          }

          staging.clear();
          const applied = patches.length - totalFailed;
          allResults.push(`[本地暂存] 已完成：${applied} 个应用成功，${totalFailed} 个失败。`);
          return allResults.join('\n');
        },
      });


    case 'check_patch':
      return tool({
        description: '[本地暂存] 查看子模型暂存区中指定序号的 patch 详情。',
        inputSchema: z.object({
          index: z.number().int().positive(),
        }),
        execute: async ({ index }) => {
          const patches = staging.getAll();
          if (index < 1 || index > patches.length) {
            return `❌ 序号 ${index} 超出范围，暂存区共有 ${patches.length} 个 patch。`;
          }
          const p = patches[index - 1];
          let result = `📋 第 ${index} 个 patch 详情：\n工具: ${p.type}\n文件: ${p.rawFilePath}\n描述: ${p.description}\n参数: ${JSON.stringify(p.params, null, 2)}`;
          if (p.resultMessage) result += `\n📤 原始返回:\n${p.resultMessage}`;
          return result;
        },
      });

    case 'revise_patch':
      return tool({
        description: '[本地暂存] 替换子模型暂存区中指定序号的 patch。',
        inputSchema: z.object({
          index: z.number().int().positive(),
          tool: z.enum(['add_patch', 'del_patch', 'modify_patch']),
          filePath: z.string(),
          lineIndex: z.union([z.number().int(), z.array(z.array(z.number().int()))]).optional(),
          Lines: z.array(z.string()).optional(),
          startLine: z.number().int().optional(),
          endLine: z.number().int().optional(),
          replaceLines: z.array(z.string()).optional(),
        }),
        execute: async ({ index, tool: toolName, filePath, lineIndex, Lines, startLine, endLine, replaceLines }) => {
          const patches = staging.getAll();
          if (index < 1 || index > patches.length) {
            return `❌ 序号 ${index} 超出范围，暂存区共有 ${patches.length} 个 patch。`;
          }
          const removed = staging.removeAt(index);
          if (!removed) return `❌ 移除序号 ${index} 的 patch 失败。`;
          let desc = '';
          switch (toolName) {
            case 'add_patch': {
              const li = lineIndex as number ?? -1;
              const lines = Lines ?? [];
              desc = li === -1 ? `在末尾追加 ${lines.length} 行` : `在第 ${li} 行前插入 ${lines.length} 行`;
              staging.add({ type: 'add', rawFilePath: filePath, resolvedPath: filePath, description: desc, params: { lineIndex: li, Lines: lines }, createdAt: Date.now(), sessionId: staging.getSessionId() });
              break;
            }
            case 'del_patch': {
              const li = lineIndex as [number, number][];
              if (!li?.length) return '❌ del_patch 需要 lineIndex';
              desc = `删除 ${li.length} 个范围`;
              staging.add({ type: 'del', rawFilePath: filePath, resolvedPath: filePath, description: desc, params: { lineIndex: li }, createdAt: Date.now(), sessionId: staging.getSessionId() });
              break;
            }
            case 'modify_patch': {
              const sl = startLine ?? 0;
              const el = endLine ?? 0;
              const rl = replaceLines ?? [];
              desc = `修改行 ${sl}-${el}`;
              staging.add({ type: 'modify', rawFilePath: filePath, resolvedPath: filePath, description: desc, params: { startLine: sl, endLine: el, replaceLines: rl }, createdAt: Date.now(), sessionId: staging.getSessionId() });
              break;
            }
          }
          return `✅ [本地暂存] 已替换第 ${index} 个 patch 为 [${toolName.toUpperCase()}] ${desc}\n■ 暂存区现有 ${staging.size} 个待应用的修改`;
        },
      });
    case 'pop_patch':
      return tool({
        description: '[本地暂存] 从子模型的独立暂存区中弹出最近添加的一个修改。',
        inputSchema: z.object({}),
        execute: async () => {
          const popped = staging.pop();
          if (!popped) return '[本地暂存区] 为空，无可撤销的操作。';
          return `[本地暂存] 已撤销: ${popped.description}\n■ 暂存区还有 ${staging.size} 个待应用的修改`;
        },
      });

    default:
      return null;
  }
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
    }, agent.patchStaging);

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
        // 此时将文本作为提交内容
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

/**
 * 执行 listen 模式的分析
 * listen 模式不需要完整的 LLM 循环，而是基于工具调用数据进行分析
 */
export async function executeListenAgent(
  agent: SubAgentState,
  toolCallsData: string,
  task: string,
): Promise<string | null> {
  subAgentManager.updateStatus(agent.name, 'running');

  try {
    const toolDesc = buildToolIdentityDesc(agent.tools ?? []);
    const systemPrompt = `${toolDesc}

${LISTEN_SYSTEM_PROMPT}

需要分析的方面: ${agent.analyzeTarget || '通用分析'}
返回格式模板: ${agent.returnTemplate || '请分析并提供改进建议'}`;

    const messages: ModelMessage[] = [
      { role: 'user', content: `请分析以下工具调用数据：\n\n${toolCallsData}\n\n任务: ${task}` },
    ];

    // 确保 tools 是数组（容错旧会话残留的 undefined）
    let submission: SubmissionPayload | null = null;
    const safeTools = agent.tools ?? [];
    const agentTools = [...safeTools];
    if (!agentTools.includes('check_patch')) agentTools.push('check_patch');
    if (!agentTools.includes('revise_patch')) agentTools.push('revise_patch');
    const childTools = buildChildTools(agentTools, (payload) => {
      submission = payload;
    });

    const result = await streamText({
      model: getModel(),
      system: systemPrompt,
      messages,
      tools: childTools,
    });

    let fullText = '';
    for await (const chunk of result.textStream) {
      fullText += chunk;
    }

    // 检查工具调用
    const finalResult = await result;
    const calls = await finalResult.toolCalls ?? [];

    if (calls.length > 0) {
      for (const tc of calls) {
        if (submission) break;
        const impl = childTools[tc.toolName];
        if (impl?.execute) {
          try {
            await impl.execute(tc.input as any, { toolCallId: tc.toolCallId, messages });
          } catch { /* ignore */ }
        }
      }
    }

    if (!submission) {
      // 监听 agent 没有调用 a_submission = 一切正常，不提交
      subAgentManager.updateStatus(agent.name, 'done');
      return null;
    }

    const resultStr = JSON.stringify(submission);
    subAgentManager.setSubmission(agent.name, resultStr);
    return resultStr;

  } catch (err: any) {
    const errorMsg = `监听分析出错: ${err.message}`;
    subAgentManager.setError(agent.name, errorMsg);
    return JSON.stringify({ summary: '分析失败', details: errorMsg });
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
























