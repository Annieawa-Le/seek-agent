/**
 * test-mode-integration.ts — 模式系统端到端集成自测
 * 验证：真实 hook 链组合（createMessageHook + modePreProcessHook）、
 * kb 模式在完整链中的检索注入与幂等、/mode 指令切换与 prompt 刷新联动
 *
 * 运行：npx tsx scripts/test-mode-integration.ts
 */
import { createMessageHook } from '../src/message_managing';
import { composeHooks } from '../src/memory_agent';
import { modePreProcessHook, KB_INJECT_PREFIX } from '../src/modes/preprocess';
import { registerBuiltinModes } from '../src/modes';
import { setActiveModes, getActiveModeNames } from '../src/modes/registry';
import { ModeCommand } from '../src/command/commands/mode.command';

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  [OK] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` -- ${detail}` : ''}`); }
}

// ── 1) 真实 hook 链组合 ──
console.log('1) 完整 hook 链（createMessageHook + modePreProcessHook）');
registerBuiltinModes();
const hookChain = composeHooks(
  createMessageHook(),
  modePreProcessHook,
);

// 构造带 [工作记忆] + user 消息的列表
const wmMsg = { role: 'user' as const, content: '[工作记忆] 当前焦点：模式系统实现' };
const userMsg = { role: 'user' as const, content: 'CLIAAgent 的主循环是怎么组织的？' };
const init = [wmMsg, userMsg];

setActiveModes(['kb']);
const out1 = await hookChain(init);
const kbInjected = out1.filter((m) => typeof m.content === 'string' && (m.content as string).startsWith(KB_INJECT_PREFIX));
assert('kb 模式注入检索结果', kbInjected.length === 1, `实际 ${kbInjected.length}`);
assert('注入在 user 消息之前', out1.indexOf(kbInjected[0] as any) < out1.indexOf(userMsg as any));

// 模拟工具循环：注入后的消息列表再次过链（应幂等，不重复检索）
const out2 = await hookChain(out1);
const kbInjected2 = out2.filter((m) => typeof m.content === 'string' && (m.content as string).startsWith(KB_INJECT_PREFIX));
assert('工具循环中幂等（仍 1 条）', kbInjected2.length === 1, `实际 ${kbInjected2.length}`);

// 新用户消息 → 重新检索
const userMsg2 = { role: 'user' as const, content: '那工具缓存呢？' };
const out3 = await hookChain([...out2, userMsg2]);
const kbInjected3 = out3.filter((m) => typeof m.content === 'string' && (m.content as string).startsWith(KB_INJECT_PREFIX));
assert('新消息触发新检索（2 条注入）', kbInjected3.length === 2, `实际 ${kbInjected3.length}`);

// 无模式时透传
setActiveModes([]);
const out4 = await hookChain(init);
const kbInjected4 = out4.filter((m) => typeof m.content === 'string' && (m.content as string).startsWith(KB_INJECT_PREFIX));
assert('退出模式后不注入', kbInjected4.length === 0);

// ── 2) /mode 指令（mock ctx） ──
console.log('2) /mode 指令执行');
let reloaded = false;
let printed: string[] = [];
const mockCtx = {
  ui: { addAgentMessage: (s: string) => printed.push(s) },
  agent: { reloadPrompt: () => { reloaded = true; } },
} as any;

setActiveModes([]);
ModeCommand.execute('/mode', mockCtx);
assert('/mode 无参显示当前模式', printed.some((s) => s.includes('快速模式')));

printed = [];
reloaded = false;
ModeCommand.execute('/mode list', mockCtx);
assert('/mode list 列出 kb', printed.some((s) => s.includes('kb')));
assert('/mode list 列出 manager', printed.some((s) => s.includes('manager')));
assert('/mode list 列出 worker', printed.some((s) => s.includes('worker')));

printed = [];
reloaded = false;
ModeCommand.execute('/mode kb', mockCtx);
assert('/mode kb 切换成功', getActiveModeNames().join(',') === 'kb');
assert('切换后触发 reloadPrompt', reloaded);
assert('提示当前模式', printed.some((s) => s.includes('知识库模式')));

printed = [];
ModeCommand.execute('/mode nope', mockCtx);
assert('未知模式报错', printed.some((s) => s.includes('未知模式')));
assert('未知模式不改变激活', getActiveModeNames().join(',') === 'kb');

printed = [];
ModeCommand.execute('/mode default', mockCtx);
assert('/mode default 退出', getActiveModeNames().length === 0);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
