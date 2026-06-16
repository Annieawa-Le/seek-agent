/**
 * LLM Chat Handler
 *
 * 封装 Vercel AI SDK 的 streamText，支持通过 JSON-RPC 流式传输 token。
 * 复用与 seek-agent 主程序相同的模型配置逻辑。
 */

import { streamText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import 'dotenv/config';

// ── 类型 ──

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** 流式回调：每产生一个 token 时调用 */
export type TokenCallback = (token: string) => void | Promise<void>;

// ── 模型提供者 ──

function createProvider() {
  const baseUrl = process.env.OPENAI_BASE_URL || '';

  return createOpenAICompatible({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: baseUrl,
    name: 'opencode',
  });
}

// ── 流式聊天 ──

export interface ChatParams {
  messages: ChatMessage[];
  model?: string;
  system?: string;
  temperature?: number;
  /** 取消信号 */
  signal?: AbortSignal;
}

export interface ChatResult {
  fullText: string;
}

/**
 * 执行流式 LLM 调用，通过 onToken 回调逐 token 输出。
 * 支持通过 AbortSignal 取消。
 */
export async function streamChat(
  params: ChatParams,
  onToken: TokenCallback,
): Promise<ChatResult> {
  const modelName = params.model || process.env.OPENAI_MODEL || 'deepseek-v4-flash';
  const provider = createProvider();
  const model = provider(modelName);

  let fullText = '';

  const result = streamText({
    model,
    system: params.system,
    messages: params.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    temperature: params.temperature ?? 0.7,
    abortSignal: params.signal,
  });

  for await (const chunk of result.textStream) {
    fullText += chunk;
    await onToken(chunk);
  }

  return { fullText };
}
