/**
 * 共享的 OpenAI 兼容 provider 工厂。
 *
 * 访问 OpenCode Go / Zen 时需要声明客户端身份并携带稳定会话 ID
 * （见 https://opencode.ai/docs/go「在哪里使用？」）。AI SDK 内部的 header
 * 合并会吞掉 provider 的 headers 选项，因此用自定义 fetch 注入。
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const OPENCODE_CLIENT_UA = 'seek-agent/1.0';

/** 进程内稳定的会话 ID（每段对话一致，便于上游路由与提示词缓存） */
const OPENCODE_SESSION_ID =
  process.env.AGENT_SESSION_ID || `session-${Math.random().toString(36).substring(2, 10)}`;

function createOpenCodeFetch(): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('User-Agent', OPENCODE_CLIENT_UA);
    headers.set('x-opencode-session', OPENCODE_SESSION_ID);
    return fetch(input, { ...init, headers });
  };
}

/** 创建 provider：仅当 baseURL 指向 OpenCode 时注入客户端标识头 */
export function createProvider() {
  const baseUrl = process.env.OPENAI_BASE_URL || '';
  return createOpenAICompatible({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: baseUrl,
    name: 'opencode',
    ...(baseUrl.includes('opencode') ? { fetch: createOpenCodeFetch() } : {}),
  });
}
