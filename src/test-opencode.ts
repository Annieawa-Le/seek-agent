// test-opencode.ts — 验证 OpenCode Go/Zen 连通性（走 model-provider 真实链路）
import 'dotenv/config';
import { streamText } from 'ai';
import { getModel, setOpenCodeSessionId } from './model-provider';

const baseUrl = process.env.OPENAI_BASE_URL || '';
const modelName = process.env.OPENAI_MODEL || 'deepseek-v4-flash';

async function testOpenCode() {
  if (!baseUrl.includes('opencode')) {
    console.log(`⚠️ OPENAI_BASE_URL 当前不指向 OpenCode：${baseUrl || '(未设置)'}`);
    console.log('   先在 .env 中启用 OpenCode 的 BASE_URL / API_KEY，再运行本脚本。');
    return;
  }

  // 与 agent.ts 一致：会话 ID 随会话稳定，随请求头发给上游
  setOpenCodeSessionId(process.env.AGENT_SESSION_ID || 'session-opencode-selftest');

  console.log(`🔍 测试 OpenCode 连接：${baseUrl} / ${modelName}`);
  try {
    const { textStream } = await streamText({
      model: getModel(modelName),
      prompt: '解释什么是 React hooks',
    });
    for await (const chunk of textStream) {
      process.stdout.write(chunk);
    }
    console.log('\n✅ 连接正常');
  } catch (error) {
    console.error('❌ 错误:', error);
    if (error instanceof Error) {
      console.error('错误消息:', error.message);
      console.error('错误堆栈:', error.stack);
    }
  }
}

testOpenCode();
