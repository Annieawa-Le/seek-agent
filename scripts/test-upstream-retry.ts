/**
 * 上游错误重试回归测试
 *
 * 验证 CLIAAgent 主循环（aiInteractionLoop）在上游返回错误码（HTTP 状态码）时：
 *   1. 不抛出、不终止 —— 主循环保持存活
 *   2. 自动退避重发，最多 MAX_UPSTREAM_RETRIES 次
 *   3. 上游恢复后能正常拿到回复并写入上下文
 *   4. 上游持续报错时重试耗尽后优雅结束（不崩溃）
 *
 * 用一个本地假上游（前 N 次返回 503，之后返回正常 SSE）驱动真实主循环。
 */
import http from 'node:http';
import { CLIAAgent } from '../src/agent';
import { resetModel } from '../src/model-provider';

const unhandled: any[] = [];
process.on('unhandledRejection', (r) => { unhandled.push(r); });

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

const SSE =
  'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"你"},"finish_reason":null}]}\n\n' +
  'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"好"},"finish_reason":null}]}\n\n' +
  'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: [DONE]\n\n';

/** 前 failCount 次请求返回 503，之后返回正常 SSE */
function startFlakyUpstream(failCount: number) {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits++;
    if (hits <= failCount) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream down', type: 'server_error' } }));
    } else {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(SSE);
    }
  });
  return new Promise<{ port: number; hits: () => number; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: (server.address() as any).port,
      hits: () => hits,
      close: () => server.close(),
    }));
  });
}

/** 只实现主循环会用到的最小 UI 面 */
function makeStubUI() {
  const toolMessages: string[] = [];
  const ui: any = {
    isAborted: false,
    isThinkingActive: () => false,
    createAbortController: () => new AbortController(),
    setContextLength: () => undefined,
    addToolMessage: (m: string) => { toolMessages.push(String(m)); },
    stopThinkingSpinner: () => undefined,
    startThinkingSpinner: () => undefined,
    startThinking: () => undefined,
    endThinking: () => undefined,
    feedThinking: () => undefined,
    addAgentMessage: () => undefined,
    appendToLastAgent: () => undefined,
    removeLastAgent: () => undefined,
    collapseToolMessages: () => undefined,
    addUserMessage: () => undefined,
    addInstructorMessage: () => undefined,
    setProcessing: () => undefined,
    clearMessages: () => undefined,
  };
  return { ui, toolMessages };
}

/** 跑一次主循环，返回观测结果 */
async function runLoop(baseUrl: string) {
  process.env.OPENAI_BASE_URL = baseUrl;
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_MODEL = 'm';
  process.env.AGENT_SESSION_ID = 'new-retrytest';
  // 清掉上一场景缓存的 provider/模型，确保新 baseURL 生效（model-provider 为单例缓存）
  resetModel();

  const { ui, toolMessages } = makeStubUI();
  const agent: any = new CLIAAgent(ui, 'test-system-prompt');
  agent.thinkingEnabled = false;
  agent.messages = [{ role: 'user', content: 'hi' }];

  let threw: any = null;
  try {
    await agent.aiInteractionLoop([], []);
  } catch (e) { threw = e; }

  const texts: string[] = [];
  for (const m of agent.messages) {
    if (m.role !== 'assistant') continue;
    const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
    for (const p of parts) if (p?.type === 'text' && p.text) texts.push(p.text);
  }
  return {
    threw,
    assistantText: texts.join(''),
    toolMessages,
    roles: agent.messages.map((m: any) => m.role),
  };
}

async function main() {
  console.log('上游错误重试回归测试\n');

  // ── 场景1：上游前 2 次报错，第 3 次恢复 → 应重试 2 次后成功 ──
  {
    console.log('场景1：上游失败 2 次后恢复');
    const up = await startFlakyUpstream(2);
    const r = await runLoop(`http://127.0.0.1:${up.port}/v1`);
    check('主循环未抛出异常', r.threw === null, r.threw ? String(r.threw?.message) : '');
    check('上游共收到 3 次请求（1 原始 + 2 重试）', up.hits() === 3, `hits=${up.hits()}`);
    check('最终拿到上游回复「你好」', r.assistantText === '你好', `got=${JSON.stringify(r.assistantText)}`);
    check('产生重试提示消息', r.toolMessages.some((m) => m.includes('上游返回错误')), r.toolMessages.join(' | '));
    if (up.hits() !== 3 || r.assistantText !== '你好') {
      console.log(`  [诊断] hits=${up.hits()} roles=${r.roles.join(',')} msgs=${JSON.stringify(r.toolMessages)}`);
    }
    up.close();
  }

  // ── 场景2：上游持续报错 → 重试耗尽后优雅结束，不崩溃 ──
  {
    console.log('\n场景2：上游持续报错');
    const up = await startFlakyUpstream(999);
    const r = await runLoop(`http://127.0.0.1:${up.port}/v1`);
    check('主循环未抛出异常', r.threw === null, r.threw ? String(r.threw?.message) : '');
    check('上游共收到 6 次请求（1 原始 + 上限 5 重试）', up.hits() === 6, `hits=${up.hits()}`);
    check('重试耗尽给出终止提示', r.toolMessages.some((m) => m.includes('已重试 5 次')), r.toolMessages.join(' | '));
    check('未产生 assistant 正文', r.assistantText === '', `got=${JSON.stringify(r.assistantText)}`);
    console.log(`  [诊断] hits=${up.hits()} msgs=${JSON.stringify(r.toolMessages)}`);
    up.close();
  }

  // 上游失败流被丢弃时 AI SDK 会遗留 promise 拒绝；线上由入口级 unhandledRejection 兜底
  // （src/electron-entry.ts / src/index.ts），此处仅上报数量供观察，不作为失败判据。
  console.log(`\n[信息] 失败流遗留 SDK rejection：${unhandled.length} 条（已由入口级兜底处理）`);
  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });

