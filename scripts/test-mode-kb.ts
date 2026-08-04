/**
 * test-mode-kb.ts — 知识库模式 P1 自测
 * 验证：内置模式注册、kb preProcess 注入与幂等、注入位置、工具门不受影响
 *
 * 运行：npx tsx scripts/test-mode-kb.ts
 */
import { registerBuiltinModes } from '../src/modes';
import { listModes, setActiveModes, checkToolGate, getActiveModeNames } from '../src/modes/registry';
import { buildKbPreProcess, KB_INJECT_PREFIX, modePreProcessHook } from '../src/modes/preprocess';

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  [OK] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` -- ${detail}` : ''}`); }
}

console.log('1) 内置模式注册');
registerBuiltinModes();
const names = listModes().map((m) => m.name);
assert('注册 4 个内置模式', names.join(',') === 'kb,manager,worker,hallucination', `实际 ${names.join(',')}`);
assert('kb 有 preProcess', !!listModes().find((m) => m.name === 'kb')?.preProcess);
assert('kb 有 promptAddon', !!listModes().find((m) => m.name === 'kb')?.promptAddon);
assert('kb promptAddon 含检索要求', (listModes().find((m) => m.name === 'kb')?.promptAddon ?? '').includes('知识库模式'));
assert('manager 用 mainReplacement（替换 MAIN.md）', !!listModes().find((m) => m.name === 'manager')?.mainReplacement);
assert('manager 不再附加 promptAddon', !listModes().find((m) => m.name === 'manager')?.promptAddon);
assert('worker 用 mainReplacement（替换 MAIN.md）', !!listModes().find((m) => m.name === 'worker')?.mainReplacement);
assert('worker 不再附加 promptAddon', !listModes().find((m) => m.name === 'worker')?.promptAddon);
assert('kb 保持附加型 promptAddon', !!listModes().find((m) => m.name === 'kb')?.promptAddon && !listModes().find((m) => m.name === 'kb')?.mainReplacement);

console.log('2) 工具门与模式无关（kb 不设白名单）');
setActiveModes(['kb']);
assert('kb 模式下 execute_command 仍放行', checkToolGate('execute_command').allowed);
assert('kb 模式下 read_file 放行', checkToolGate('read_file').allowed);
setActiveModes([]);

console.log('3) kb preProcess 注入与幂等');
const hook = buildKbPreProcess(2);
const userMsg = { role: 'user' as const, content: 'agent 的工具循环是怎么工作的？' };
const wmMsg = { role: 'user' as const, content: '[工作记忆] 一些上下文' };

const out1 = await hook([wmMsg, userMsg]);
const injected = out1.filter((m) => typeof m.content === 'string' && (m.content as string).startsWith(KB_INJECT_PREFIX));
assert('第一次调用注入检索结果', injected.length === 1, `实际 ${injected.length}`);
const injectIdx = out1.findIndex((m) => typeof m.content === 'string' && (m.content as string).startsWith(KB_INJECT_PREFIX));
const userIdx = out1.findIndex((m) => m === userMsg);
assert('注入位置在 user 消息之前', injectIdx !== -1 && injectIdx < userIdx, `inject=${injectIdx} user=${userIdx}`);
assert('注入内容含检索结果标记', typeof injected[0]?.content === 'string' && (injected[0]!.content as string).includes('检索结果'));
assert('注入内容含工作记忆段', typeof injected[0]?.content === 'string' && (injected[0]!.content as string).includes('【工作记忆】'));
assert('注入内容含长期记忆段', typeof injected[0]?.content === 'string' && (injected[0]!.content as string).includes('【长期记忆】'));
assert('注入内容含知识库段', typeof injected[0]?.content === 'string' && (injected[0]!.content as string).includes('【知识库】'));

const out2 = await hook([wmMsg, userMsg]);
const injected2 = out2.filter((m) => typeof m.content === 'string' && (m.content as string).startsWith(KB_INJECT_PREFIX));
assert('幂等：同一 user 消息不重复注入', injected2.length === 0, `实际 ${injected2.length}`);

console.log('4) modePreProcessHook 动态分发');
setActiveModes(['kb']);
const out3 = await modePreProcessHook([wmMsg, userMsg]);
const injected3 = out3.filter((m) => typeof m.content === 'string' && (m.content as string).startsWith(KB_INJECT_PREFIX));
assert('分发器触发 kb preProcess', injected3.length === 1);
setActiveModes([]);
const out4 = await modePreProcessHook([wmMsg, userMsg]);
const injected4 = out4.filter((m) => typeof m.content === 'string' && (m.content as string).startsWith(KB_INJECT_PREFIX));
assert('无激活模式时分发器透传', injected4.length === 0);
assert('激活名正确', getActiveModeNames().length === 0);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);








