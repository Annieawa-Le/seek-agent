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

// ── OpenCode Go / Zen 客户端标识 ──
// OpenCode 要求接入方声明自身客户端身份，并为每段对话携带稳定的会话 ID
// （见 https://opencode.ai/docs/go「在哪里使用？」）：
//   - 使用专属 user agent 标识，而不是通用 SDK / HTTP 库名称
//   - 在 x-opencode-session 请求头中发送稳定会话 ID，便于上游路由与提示词缓存
const OPENCODE_CLIENT_UA = 'seek-agent/1.0';

let openCodeSessionId: string | null = null;

/**
 * 设置 OpenCode 请求头中携带的会话 ID（每段对话稳定）。
 * fetch 注入层每次请求实时读取，无需重建 provider。
 */
export function setOpenCodeSessionId(id: string): void {
  openCodeSessionId = id;
}

function resolveOpenCodeSessionId(): string {
  if (!openCodeSessionId) {
    openCodeSessionId = process.env.AGENT_SESSION_ID
      || `session-${Math.random().toString(36).substring(2, 10)}`;
  }
  return openCodeSessionId;
}

/**
 * OpenCode 请求头注入。
 * AI SDK 内部的 header 合并会把 provider 的 headers 选项吞掉（实测 User-Agent
 * 会被覆盖成通用 SDK 名），因此用自定义 fetch 在请求发出前强制写入。
 */
function createOpenCodeFetch(): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('User-Agent', OPENCODE_CLIENT_UA);
    headers.set('x-opencode-session', resolveOpenCodeSessionId());
    return fetch(input, { ...init, headers });
  };
}


function buildProvider() {
  const baseUrl = process.env.OPENAI_BASE_URL || '';

  if (baseUrl.includes('opencode')) {
    return createOpenAICompatible({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: baseUrl,
      name: 'opencode',
      fetch: createOpenCodeFetch(),
    });
  }

  // 本地 Ollama / vLLM 等 OpenAI 兼容端点
  if (baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1')) {
    return createOpenAICompatible({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: baseUrl,
      name: 'ollama',
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
  liteProvider = null;
  liteModel = null;
}

/**
 * 轻量模型实例（做梦沉淀等后台任务用）。
 * 读取 LITE_MODEL / LITE_MODEL_BASE_URL / LITE_MODEL_API_KEY：
 *   - LITE_MODEL 未配置 → 回退主模型（getModel）
 *   - 配置了但 BASE_URL 未配置 → 复用 OPENAI_BASE_URL
 * 独立缓存，与主模型互不干扰。
 */
let liteProvider: ReturnType<typeof createDeepSeek | typeof createOpenAICompatible> | null = null;
let liteModel: ModelInstance | null = null;

function buildLiteProvider() {
  const baseUrl = process.env.LITE_MODEL_BASE_URL || process.env.OPENAI_BASE_URL || '';
  const apiKey = process.env.LITE_MODEL_API_KEY || process.env.OPENAI_API_KEY;

  if (baseUrl.includes('opencode')) {
    return createOpenAICompatible({
      apiKey,
      baseURL: baseUrl,
      name: 'opencode',
      fetch: createOpenCodeFetch(),
    });
  }

  // 本地 Ollama / vLLM 等 OpenAI 兼容端点
  if (baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1')) {
    return createOpenAICompatible({
      apiKey,
      baseURL: baseUrl,
      name: 'ollama',
    });
  }

  return createDeepSeek({
    apiKey,
    baseURL: baseUrl || undefined,
  });
}

/** 获取轻量模型实例；未配置 LITE_MODEL 时回退主模型 */
export function getLiteModel(): ModelInstance {
  const liteName = process.env.LITE_MODEL;
  if (!liteName) return getModel();

  if (!liteProvider) liteProvider = buildLiteProvider();
  if (!liteModel) liteModel = liteProvider(liteName);
  return liteModel;
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







