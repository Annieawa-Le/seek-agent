/**
 * test-chat-thread.ts — 协作聊天渠道自测
 * 验证：thread 创建/追加/排序/截断、chat:send 命令格式解析
 *
 * 运行：npx tsx scripts/test-chat-thread.ts
 */
import {
  appendChatMessage,
  getChatThreads,
  getChatThread,
  clearChatThread,
} from '../src/modes/chat-thread';

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  [OK] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` -- ${detail}` : ''}`); }
}

console.log('1) thread 创建与追加');
clearChatThread('worker-a');
clearChatThread('sub-1');

appendChatMessage('worker-a', 'worker', 'manager', '【派活】帮我改一下 agent.ts');
const t1 = getChatThread('worker-a');
assert('thread 创建（worker 类型）', !!t1 && t1.peerType === 'worker');
assert('manager 消息记录', t1?.messages[0]?.role === 'manager' && (t1?.messages[0]?.content ?? '').includes('派活'));
assert('ts 已记录', typeof t1?.messages[0]?.ts === 'number' && t1!.messages[0].ts > 0);

appendChatMessage('worker-a', 'worker', 'peer', '【工作汇报】已完成，改动见 diff');
assert('peer 回复追加（2 条）', t1?.messages.length === 2 && t1!.messages[1].role === 'peer');

console.log('2) 子模型 thread');
appendChatMessage('sub-1', 'subagent', 'manager', '【派活】写个测试');
appendChatMessage('sub-1', 'subagent', 'peer', '【提交】概要: 完成\n详情: 17 项全过');
const t2 = getChatThread('sub-1');
assert('子模型 thread 类型', t2?.peerType === 'subagent');
assert('提交内容保存', (t2?.messages[1]?.content ?? '').includes('17 项全过'));

console.log('3) 排序与去重');
const threads = getChatThreads();
assert('两个 thread 都在', threads.length >= 2);
const subTs = getChatThread('sub-1')!.lastActiveAt;
const wTs = getChatThread('worker-a')!.lastActiveAt;
assert('sub-1 活跃时间不早于 worker-a（排序正确）', subTs >= wTs, `sub=${subTs} w=${wTs}`);

console.log('4) 上限截断');
clearChatThread('bulk');
for (let i = 0; i < 210; i++) {
  appendChatMessage('bulk', 'subagent', 'manager', `msg-${i}`);
}
const tb = getChatThread('bulk');
assert('超过 200 条被截断', tb?.messages.length === 200, `实际 ${tb?.messages.length}`);
assert('保留最新（msg-209）', tb?.messages[199]?.content === 'msg-209');

console.log('5) chat:send 命令格式解析（与 electron-entry 一致）');
const parseChatSend = (cmd: string) => {
  const rest = cmd.slice('chat:send '.length);
  const sep = rest.indexOf('|');
  return { peer: sep > 0 ? rest.slice(0, sep).trim() : rest.trim(), content: sep > 0 ? rest.slice(sep + 1) : '' };
};
const p1 = parseChatSend('chat:send worker-a|帮我看看 src/agent.ts');
assert('解析 peer', p1.peer === 'worker-a');
assert('解析 content 含空格', p1.content === '帮我看看 src/agent.ts');
const p2 = parseChatSend('chat:send sub-1|写测试');
assert('解析子模型', p2.peer === 'sub-1' && p2.content === '写测试');

clearChatThread('worker-a');
clearChatThread('sub-1');
clearChatThread('bulk');

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);



