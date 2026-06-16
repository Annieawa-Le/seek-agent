// test-opencode.ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, streamText } from 'ai';
import 'dotenv/config'; // 如果使用 dotenv

async function testOpenCode() {
  console.log('🔍 开始测试 OpenCode Go 连接...');
  
  const opencode = createOpenAICompatible({
    name: 'opencode',
    baseURL: 'https://opencode.ai/zen/go/v1',
    apiKey: "sk-6kiLywjeXOjxQ7tCo1hNhRVTFMjbrwbYUqh08NCeZX9EmlNGw4cFSQI9LzIbTtoW",
  });

  try {
    console.log('📡 发送请求...');
    const { textStream } = await streamText({
      model: opencode('deepseek-v4-flash'),
      prompt: '解释什么是 React hooks',
    });

    for await (const chunk of textStream) {
      process.stdout.write(chunk);
    }
  } catch (error) {
    console.error('❌ 错误:', error);
    // 打印更详细的错误信息
    if (error instanceof Error) {
      console.error('错误消息:', error.message);
      console.error('错误堆栈:', error.stack);
    }
  }
}

testOpenCode();