/**
 * _test_agent.mjs — Agent 通信诊断测试
 *
 * 模拟 Electron 主进程行为：
 * 1. spawn agent 子进程 (npx.cmd tsx src/electron-entry.ts)
 * 2. 等待 init-done 信号
 * 3. 发送用户输入
 * 4. 收集输出并分析
 */

import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, appendFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname);

const LOG_FILE = resolve(ROOT, '_test_agent.log');

function log(msg) {
  console.log(msg);
  appendFileSync(LOG_FILE, msg + '\n');
}

// 清空日志
writeFileSync(LOG_FILE, '');

log('='.repeat(60));
log(' Seek Agent 通信诊断测试');
log('='.repeat(60));
log(`项目根目录: ${ROOT}`);
log('');

const agentEntry = resolve(ROOT, 'src', 'electron-entry.ts');
log(`启动命令: npx.cmd tsx "${agentEntry}"`);
log('');

const child = spawn('npx.cmd tsx "' + agentEntry + '"', {
  cwd: ROOT,
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: true,
  env: { ...process.env, ELECTRON_MODE: '1' },
});

let initDone = false;
let inputSent = false;
const allMessages = [];
const allStderr = [];
let buffer = '';
let startTime = Date.now();
const TIMEOUT = 20_000;

log('[test] Agent 进程已启动 (PID: ' + child.pid + ')');
log('');

child.stdout.on('data', (data) => {
  buffer += data.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed);
      allMessages.push(parsed);

      // 只打印关键消息类型，不打印 append 细节
      if (parsed.type !== 'append') {
        log(`[stdout] ← ${trimmed}`);
      }

      if (parsed.type === 'init-done') {
        initDone = true;
        log('');
        log('[test] ✅ 收到 init-done 信号，Agent 已就绪');
        log('');

        const inputMsg = JSON.stringify({
          type: 'input',
          content: '你好，请介绍一下自己',
          id: '1',
        });
        log(`[stdin]  → ${inputMsg}`);
        child.stdin.write(inputMsg + '\n');
        inputSent = true;
        log('');
      }
    } catch (e) {
      log(`[stdout:raw] ← ${trimmed}`);
    }
  }
});

child.stderr.on('data', (data) => {
  const text = data.toString();
  allStderr.push(text);
  if (!text.includes('ExperimentalWarning') && !text.includes('--experimental-loader')) {
    log(`[stderr] ${text.trim()}`);
  }
});

child.on('exit', (code, signal) => {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log('');
  log(`[test] Agent 进程已退出 (code: ${code}, signal: ${signal}, 耗时: ${elapsed}s)`);
});

child.on('error', (err) => {
  log('[test] ❌ 进程启动失败: ' + err.message);
});

setTimeout(() => {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log('');
  log('='.repeat(60));
  log(` 测试结束 (耗时: ${elapsed}s)`);
  log('='.repeat(60));
  log('');

  log('── 诊断报告 ──');
  log('');

  if (initDone) {
    log('✅ [通信] init-done 已收到 — Agent 启动正常');
  } else {
    log('❌ [通信] 未收到 init-done — Agent 可能未正常启动');
  }

  if (inputSent) {
    log('✅ [通信] 用户输入已发送到 stdin');
  } else {
    log('⚠️ [通信] 用户输入未发送 (可能是因为未收到 init-done)');
  }

  const msgTypes = allMessages.map(m => m.type);
  const uniqueTypes = [...new Set(msgTypes)];
  log(`\n📊 收到消息类型: ${uniqueTypes.join(', ') || '(无)'}`);
  log(`📊 总消息数: ${allMessages.length}`);

  // append 数量
  const appendMsgs = allMessages.filter(m => m.type === 'append');
  if (appendMsgs.length > 0) {
    const fullContent = appendMsgs.map(m => m.content).join('');
    log(`📊 append 流式消息: ${appendMsgs.length} 条, 总内容长度: ${fullContent.length}`);
    log(`📝 完整回复内容:\n${fullContent}`);
  }

  const agentMessages = allMessages.filter(m => m.type === 'message' && m.role === 'agent');
  if (agentMessages.length > 0) {
    log('');
    log(`✅ [回复] 收到 ${agentMessages.length} 条 agent message 消息`);
    for (const msg of agentMessages) {
      log(`   - content 长度: ${(msg.content || '').length}`);
      log(`     内容预览: ${(msg.content || '').substring(0, 100)}`);
    }
  } else {
    log('');
    log('❌ [回复] 未收到任何 agent message 类型消息');
  }

  const stateMsgs = allMessages.filter(m => m.type === 'state');
  if (stateMsgs.length > 0) {
    log(`\n📊 state 消息: ${stateMsgs.length} 条 (最后一条 processing=${stateMsgs[stateMsgs.length-1].processing})`);
  }

  const errorLines = allStderr.filter(s => s.toLowerCase().includes('error') || s.toLowerCase().includes('exception'));
  if (errorLines.length > 0) {
    log(`\n⚠️ stderr 中发现 ${errorLines.length} 个错误/异常`);
    for (const line of errorLines.slice(0, 5)) {
      log(`   ${line.substring(0, 300)}`);
    }
  } else {
    log('\n✅ stderr 无错误/异常');
  }

  log('');
  log('='.repeat(60));
  log(`完整日志已保存到: ${LOG_FILE}`);

  try { child.stdin.end(); } catch {}
  try { child.kill(); } catch {}
  process.exit(0);
}, TIMEOUT);

process.on('SIGINT', () => {
  log('\n[test] 收到中断信号，清理中...');
  try { child.kill(); } catch {}
  process.exit(1);
});
