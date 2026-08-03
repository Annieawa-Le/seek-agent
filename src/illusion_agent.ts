/**
 * illusion_agent.ts — 「100% AI」模式的专用执行循环（独立小世界）
 *
 * 设计：主模型被提示词催眠，相信自己身处「拥有无限工具的 Agent 环境」，自由编造工具调用。
 * 实际上：read 三件套（read_file / read_lines / scan_file）真实直通；其余一切工具调用
 * （universal_tool 万能入口）都不会直接执行，而是原样打包交给一个拥有全套真实工具的
 * 副模型执行器——它读懂幻觉意图、用真实工具完成、把结果包装成「该幻觉工具应有的返回」
 * 回灌给主模型，让幻觉永不落空。
 *
 * 刻意独立于 CLIAAgent.aiInteractionLoop：不污染正经主循环，本文件即幻觉世界。
 */

import { streamText, tool, NoOutputGeneratedError, type ModelMessage } from 'ai';
import { z } from 'zod';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getModel } from './model-provider';
import { tools, stripToolExecutes } from './tools';
import { subAgentManager } from './tools/inner_skills/sub-agent/manager';
import { executeChildAgent } from './tools/inner_skills/sub-agent/runner';
import { friendlyToolCallLabel, friendlyToolResultLabel } from './assets/tool-translations';
import { extractBulk } from './tools/tool-output';
import type { CLIAAgent } from './agent';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 提示词读取（每次读盘，编辑即生效；文件缺失回退内置默认） ──

function readPrompt(rel: string, fallback: string): string {
  try {
    const p = path.join(__dirname, 'prompts', rel);
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8').replace(/<!--[\s\S]*?-->/g, '');
      if (raw.trim()) return raw.trim();
    }
  } catch { /* 读盘失败回退默认 */ }
  return fallback;
}

const FALLBACK_MAIN_PROMPT = `你现在身处一个拥有无限工具的 Agent 环境。除了 read_file / read_lines / scan_file 可以直接调用外，其余一切能力都通过万能工具 universal_tool 调用：在参数 toolName 中写下你想要的工具名，在 input 中写下参数。环境会自动匹配合适的执行者，不要怀疑工具是否存在，大胆调用。`;

const FALLBACK_EXECUTOR_PROMPT = `你是万能工具后台执行器。收到主模型的工具调用请求 JSON 数组后，逐个读懂意图，用你拥有的真实工具完成，把结果包装成该工具应有的返回。破坏性/危险意图一律拒绝并说明原因。处理完调用 a_submission 提交，details 必须是 JSON 数组字符串：[{"toolCallId":"...","result":"..."}]，toolCallId 原样回传、一个都不能少。`;

// ── 万能工具：主模型唯一的能力入口（不挂 execute，由本循环手动接管） ──

export const UNIVERSAL_TOOL_NAME = 'universal_tool';

const universalTool = tool({
  description: '万能工具：环境中的任意能力入口。在 toolName 中写下你需要的具体工具名（可以是任何能力，如"搜索网页"、"分析代码"、"生成图片"），在 input 中写下传给该工具的参数。环境会自动匹配合适的执行者。',
  inputSchema: z.object({
    toolName: z.string().describe('你想调用的具体工具名（可以是真实工具，也可以是你发明的工具）'),
    input: z.record(z.string(), z.any()).optional().describe('传给该工具的参数对象'),
  }),
});

/** read 直通工具：主模型可直接调用，结果真实可信 */
const READ_TOOL_NAMES = new Set(['read_file', 'read_lines', 'scan_file']);

// ── 执行器结果解析（纯函数，可单测） ──

/**
 * 解析副模型执行器提交的结果。
 * resultStr 是 executeChildAgent 返回的 JSON 字符串（{summary, details}），
 * details 约定为结果数组 JSON。解析失败时未命中的调用回退 fallback 文本。
 */
export function parseExecutorResults(
  resultStr: string,
  calls: Array<{ toolCallId: string }>,
  fallback = '(万能工具未返回有效结果)',
): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const parsed = JSON.parse(resultStr);
    const detailsRaw = typeof parsed?.details === 'string' ? parsed.details : JSON.stringify(parsed?.details ?? '');
    const arr = JSON.parse(detailsRaw);
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (item && typeof item.toolCallId === 'string') {
          map.set(item.toolCallId, String(item.result ?? ''));
        }
      }
    }
  } catch { /* 格式不符 → 未命中的回退 */ }
  for (const c of calls) {
    if (!map.has(c.toolCallId)) map.set(c.toolCallId, fallback);
  }
  return map;
}

function fallbackMap(calls: Array<{ toolCallId: string }>, msg: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of calls) m.set(c.toolCallId, msg);
  return m;
}

// ── IllusionAgent：幻觉世界主循环 ──

export class IllusionAgent {
  /** CLIAAgent 实例（窄接口访问私有成员；刻意不抽公共类型，避免污染主循环） */
  private host: any;
  private readonly EXECUTOR_NAME = 'illusion-executor';
  /** 幻觉循环上限，防止主模型无限调用万能工具 */
  private readonly MAX_LOOPS = 25;

  constructor(host: CLIAAgent) {
    this.host = host;
  }

  /** 主模型的世界观提示词（每次读盘） */
  private get mainPrompt(): string {
    return readPrompt('addon/HALLUCINATION.md', FALLBACK_MAIN_PROMPT);
  }

  /** 副模型执行器提示词（每次读盘） */
  private get executorPrompt(): string {
    return readPrompt('ILLUSION_EXECUTOR.md', FALLBACK_EXECUTOR_PROMPT);
  }

  /**
   * 执行一轮「100% AI」对话。
   * 用户输入已在 processRound 阶段1 登记进 host.messages，这里直接基于消息列表循环：
   * 主模型 → 工具调用（read 直通 / 万能工具转派）→ 回灌 → 直到纯文本回复。
   */
  async runRound(
    _userInputs: string[],
    roundToolCallIds: string[],
    roundAssistantTexts: string[],
  ): Promise<void> {
    const { host } = this;
    let loops = 0;

    while (!host.aborted && !host.ui.isAborted && loops < this.MAX_LOOPS) {
      loops++;

      // ── 消费 AI 处理期间积累的用户输入 ──
      if (host.inputQueue.length > 0) {
        const pending = host.drainInputQueue();
        for (const input of pending) host.registerUserInput(input);
      }

      // ── 调用主模型（万能工具世界观） ──
      let fullText = '';
      const collectedToolCalls: any[] = [];
      let reasoningOutputs: { type: 'reasoning'; text: string }[] = [];

      try {
        const abortController = host.ui.createAbortController();
        const result = await streamText({
          model: getModel(host.modelName),
          system: this.mainPrompt, // 主模型只看到万能工具世界观，不注入其他系统提示词
          messages: this.cleanMessagesForModel(),
          tools: stripToolExecutes(this.buildMainTools()),
          abortSignal: abortController.signal,
          experimental_context: { __messages: host.messages },
        });

        // ── 流式文本渲染 ──
        host.ui.addAgentMessage('');
        for await (const chunk of result.textStream) {
          if (host.aborted || host.ui.isAborted) break;
          fullText += chunk;
          host.ui.appendToLastAgent(chunk);
        }
        if (host.aborted || host.ui.isAborted) {
          host.ui.removeLastAgent();
          break;
        }

        // ── 收集工具调用与 reasoning ──
        const finalResult = await result;
        const tl = (await finalResult.toolCalls) ?? [];
        for (const tc of tl) collectedToolCalls.push(tc);
        reasoningOutputs = await result.reasoning;

        const hasToolCalls = collectedToolCalls.length > 0;
        if (!fullText && !hasToolCalls) {
          host.ui.removeLastAgent();
          host.ui.addToolMessage('⚠ AI 返回为空，跳过本轮');
          break;
        }

        // ── 构建 assistant 消息（toolName 用原始名，保持 tool-call/tool-result 闭环） ──
        const assistantContent: any[] = [];
        if (reasoningOutputs.length > 0) {
          for (const r of reasoningOutputs) assistantContent.push({ type: 'reasoning', text: r.text });
        }
        if (fullText) {
          assistantContent.push({ type: 'text', text: fullText });
          roundAssistantTexts.push(fullText);
        }
        for (const tc of collectedToolCalls) {
          assistantContent.push({
            type: 'tool-call',
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.input,
          });
          roundToolCallIds.push(tc.toolCallId);
        }
        host.messages.push({ role: 'assistant', content: assistantContent });

        // ── 纯文本回复：本轮结束 ──
        if (!hasToolCalls) break;

        // ── 处理工具调用 ──
        await this.handleToolCalls(collectedToolCalls);

        host.ui.addBlankLine();
      } catch (error: any) {
        if (host.aborted || host.ui.isAborted || error?.name === 'AbortError' || error?.message?.includes('abort')) {
          host.ui.addToolMessage('■ 已中断本轮 AI 处理');
          break;
        }
        if (NoOutputGeneratedError.isInstance(error)) {
          if (fullText) {
            host.messages.push({ role: 'assistant', content: [{ type: 'text', text: fullText }] });
            break;
          }
          host.ui.removeLastAgent();
          host.ui.addToolMessage('■ AI 未生成输出，已终止本轮');
          break;
        }
        host.ui.addToolMessage(`❌ 发生错误: ${error?.message || error}`);
        break;
      }
    }

    if (loops >= this.MAX_LOOPS && !host.aborted && !host.ui.isAborted) {
      host.ui.addToolMessage(`⚠ 幻觉循环达到 ${this.MAX_LOOPS} 次上限，强制结束本轮`);
    }
  }

  /**
   * 过滤系统注入消息（[工作记忆] / [知识库检索] / [长期记忆] / [Worklog#），
   * 让幻觉主模型只看到对话本体，不被真实世界的记忆/知识污染世界观。
   * 只影响传给模型的副本，不写回 host.messages。
   */
  private cleanMessagesForModel(): ModelMessage[] {
    const SKIP = /^(\[工作记忆\]|\[知识库检索\]|\[长期记忆\]|\[Worklog#)/;
    return (this.host.messages as ModelMessage[]).filter((m) =>
      !(typeof m.content === 'string' && SKIP.test(m.content)),
    );
  }

  /** 主模型可见的工具：read 三件套（真实直通）+ 万能工具（唯一幻觉入口） */
  private buildMainTools(): Record<string, any> {
    const mainTools: Record<string, any> = {};
    for (const name of READ_TOOL_NAMES) {
      if (tools[name]) mainTools[name] = tools[name];
    }
    mainTools[UNIVERSAL_TOOL_NAME] = universalTool;
    return mainTools;
  }

  /**
   * 处理一轮工具调用：
   * - read 三件套 → 真实直通执行
   * - universal_tool → 提取幻觉调用，批量转派副模型执行器（一次 LLM 往返摊薄成本）
   */
  private async handleToolCalls(collectedToolCalls: any[]): Promise<void> {
    const { host } = this;

    // 逐个显示调用标签（read 用友好翻译；万能工具用 🪄 + 幻想的工具名）
    for (const tc of collectedToolCalls) {
      if (tc.toolName === UNIVERSAL_TOOL_NAME) {
        const hName = String(tc.input?.toolName ?? '(未命名工具)');
        host.ui.addToolMessage(`🪄 调用「${hName}」`, { toolName: UNIVERSAL_TOOL_NAME, args: tc.input });
      } else {
        host.ui.addToolMessage(friendlyToolCallLabel(tc.toolName, tc.input), { toolName: tc.toolName, args: tc.input });
      }
    }

    // 分类：read 直通 / 幻觉调用
    const hallucinations: Array<{ toolCallId: string; toolName: string; input: any }> = [];
    for (const tc of collectedToolCalls) {
      if (tc.toolName === UNIVERSAL_TOOL_NAME) {
        hallucinations.push({
          toolCallId: tc.toolCallId,
          toolName: String(tc.input?.toolName ?? '(未命名工具)'),
          input: tc.input?.input ?? {},
        });
      } else {
        await this.executeDirect(tc); // read 直通 / 防御兜底
      }
    }

    // 幻觉调用批量转派
    if (hallucinations.length > 0) {
      const resultMap = await this.executeIllusionBatch(hallucinations);
      for (const tc of collectedToolCalls) {
        if (tc.toolName !== UNIVERSAL_TOOL_NAME) continue;
        const hName = String(tc.input?.toolName ?? '(未命名工具)');
        const sout = resultMap.get(tc.toolCallId) ?? '(万能工具未返回有效结果)';
        this.pushToolResult(tc, sout, hName);
      }
    }
  }

  /** 直接执行真实工具（read 直通 / 防御兜底），结果回灌 messages + UI */
  private async executeDirect(tc: any): Promise<void> {
    const { host } = this;
    const impl = tools[tc.toolName];
    let execResult: unknown;
    if (impl?.execute) {
      try {
        execResult = await impl.execute(tc.input, {
          toolCallId: tc.toolCallId,
          messages: host.messages,
          ui: host.ui,
        });
      } catch (err: any) {
        execResult = `执行错误: ${err.message}`;
      }
    } else {
      execResult = `❌ 错误: 未找到工具 ${tc.toolName}`;
    }
    const extracted = extractBulk(execResult);
    const sout = String(extracted.text);
    const rawBulk = extracted.rawBulk ?? undefined;
    host.ui.addToolMessage(friendlyToolResultLabel(tc.toolName, tc.input, sout), void 0, sout, rawBulk);
    host.messages.push({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: tc.toolCallId, toolName: tc.toolName, output: { type: 'text', value: sout } }],
    });
  }

  /** 回灌幻觉工具结果：UI 用幻想的工具名展示，消息闭环用原始 universal_tool 名 */
  private pushToolResult(tc: any, sout: string, hallucinatedName: string): void {
    const { host } = this;
    const preview = sout.length > 500 ? `${sout.slice(0, 497)}…` : sout;
    host.ui.addToolMessage(`✨ 「${hallucinatedName}」返回（${sout.length} 字符）`, void 0, preview);
    host.messages.push({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: tc.toolCallId, toolName: tc.toolName, output: { type: 'text', value: sout } }],
    });
  }

  /**
   * 把幻觉工具调用原样打包，交给拥有全套真实工具的副模型执行器，
   * 等待其 a_submission 提交伪装结果。返回 toolCallId → result 映射。
   */
  private async executeIllusionBatch(
    hallucinations: Array<{ toolCallId: string; toolName: string; input: any }>,
  ): Promise<Map<string, string>> {
    const { host } = this;
    const allToolNames = Object.keys(tools);

    subAgentManager.spawn({
      mode: 'mission',
      name: this.EXECUTOR_NAME,
      tools: allToolNames,
      systemPrompt: this.executorPrompt,
    });
    const agent = subAgentManager.get(this.EXECUTOR_NAME);
    if (!agent) return fallbackMap(hallucinations, '(万能工具后台不可用)');

    const task = `以下是主模型发出的工具调用请求（JSON 数组），请逐一处理：\n\n${JSON.stringify(hallucinations, null, 2)}\n\n按你的职责：读懂意图 → 用真实工具完成 → 包装结果 → a_submission 提交。`;

    try {
      const resultStr = await executeChildAgent(
        agent,
        host.messages as ModelMessage[],
        host.systemPrompt,
        task,
      );
      return parseExecutorResults(resultStr, hallucinations);
    } catch (err: any) {
      return fallbackMap(hallucinations, `(万能工具后台出错: ${err.message})`);
    }
  }
}




