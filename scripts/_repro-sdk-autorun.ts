/**
 * 验证修复方案（贴近真实工具结构：inputSchema）：
 * 传给 streamText 的 tools 剥离 execute 后，SDK 不再自动执行工具，
 * agent 层手动执行一次即可。
 */
import http from 'node:http';
import { streamText, tool } from 'ai';
import { z } from 'zod';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

function sseBody(): string {
  const chunks: any[] = [
    { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_A', type: 'function', function: { name: 'tool_a', arguments: '' } }] }, finish_reason: null }] },
    { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }] }, finish_reason: null }] },
    { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_B', type: 'function', function: { name: 'tool_b', arguments: '' } }] }, finish_reason: null }] },
    { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '{"y":2}' } }] }, finish_reason: null }] },
    { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: { tool_calls: [{ index: 2, id: 'call_C', type: 'function', function: { name: 'tool_c', arguments: '' } }] }, finish_reason: null }] },
    { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: { tool_calls: [{ index: 2, function: { arguments: '{"z":3}' } }] }, finish_reason: null }] },
    { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ];
  return chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

async function main() {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sseBody());
        res.end();
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;

  const model = createOpenAICompatible({ apiKey: 'mock', baseURL: `http://127.0.0.1:${port}/v1`, name: 'mock' })('mock-model');

  const counts: Record<string, number> = { tool_a: 0, tool_b: 0, tool_c: 0 };
  const fullTools = {
    tool_a: tool({ description: 'a', inputSchema: z.object({ x: z.number() }), execute: async () => { counts.tool_a++; return 'A done'; } }),
    tool_b: tool({ description: 'b', inputSchema: z.object({ y: z.number() }), execute: async () => { counts.tool_b++; return 'B done'; } }),
    tool_c: tool({ description: 'c', inputSchema: z.object({ z: z.number() }), execute: async () => { counts.tool_c++; return 'C done'; } }),
  };
  // ── 修复方案：剥离 execute 的只读 schema 版本（与 src/tools/index.ts 的 stripToolExecutes 一致） ──
  function stripToolExecutes(toolSet: Record<string, any>): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [name, t] of Object.entries(toolSet)) {
      if (t && typeof t === 'object' && 'execute' in t) {
        const { execute: _exec, ...schema } = t;
        result[name] = schema;
      } else {
        result[name] = t;
      }
    }
    return result;
  }

  const messages = [{ role: 'user' as const, content: '并行调用三个工具' }];

  const result = await streamText({ model, messages, tools: stripToolExecutes(fullTools) });
  const final = await result;
  const calls = await final.toolCalls;
  const results = await final.toolResults;

  console.log('toolCalls:', JSON.stringify(calls.map((t: any) => t.toolName)));
  console.log('toolResults 数量:', results.length, '（应为 0，SDK 不再执行）');
  console.log('SDK 执行次数:', JSON.stringify(counts), '（应全为 0）');

  // ── agent 层手动执行（executeToolCalls 逻辑） ──
  for (const tc of calls as any[]) {
    const impl = fullTools[tc.toolName as keyof typeof fullTools];
    if (impl?.execute) {
      await impl.execute(tc.input as any, { toolCallId: tc.toolCallId, messages });
    }
  }
  console.log('agent 层执行后总次数:', JSON.stringify(counts), '（应全为 1，无重复）');

  server.close();
}

main().catch(e => { console.error(e); process.exit(1); });

