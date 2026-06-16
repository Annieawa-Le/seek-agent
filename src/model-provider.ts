/**
 * model-provider.ts — 统一的 AI 模型提供者
 *
 * 根据环境变量 OPENAI_BASE_URL 自动选择 provider：
 *   - 含 "deepseek" → createDeepSeek
 *   - 含 "opencode" → createOpenAICompatible (name="opencode")
 *   - 其他 → 默认 createDeepSeek（兼容 OpenAI 兼容接口）
 *
 * 单例模式，跨 agent.ts 和 memory_agent.ts 共享同一份模型实例。
 */

import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

type ModelInstance = ReturnType<ReturnType<typeof createDeepSeek>>;

let cachedProvider: ReturnType<typeof createDeepSeek | typeof createOpenAICompatible> | null = null;
let cachedModel: ModelInstance | null = null;

function buildProvider() {
  const baseUrl = process.env.OPENAI_BASE_URL || '';

  if (baseUrl.includes('opencode')) {
    return createOpenAICompatible({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: baseUrl,
      name: 'opencode',
    });
  }

  // 默认走 deepseek（包括 "deepseek" 或非 opencode 的其他端点）
  return createDeepSeek({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: baseUrl || undefined,
  });
}

/**
 * 返回一个模型实例，第二次调用直接返回缓存。
 * 适用于 agent.ts 的 streamText 调用。
 */
export function getModel(modelName?: string): ModelInstance {
  if (!cachedProvider) {
    cachedProvider = buildProvider();
  }
  const name = modelName || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  if (!cachedModel) {
    cachedModel = cachedProvider(name);
  }
  return cachedModel;
}

/**
 * 强制重新创建 provider（通常在 .env 热重载后使用）。
 */
export function resetModel(): void {
  cachedProvider = null;
  cachedModel = null;
}


// ── 系统 prompt 共享（让子 AI 调用复用主模型前缀，命中缓存） ──
let _systemPrompt = '';

/** 获取当前主模型使用的 system prompt */
export function getSystemPrompt(): string {
  return _systemPrompt;
}

/** 设置当前主模型使用的 system prompt（由 agent.ts 在初始化时调用） */
export function setSystemPrompt(prompt: string): void {
  _systemPrompt = prompt;
}

