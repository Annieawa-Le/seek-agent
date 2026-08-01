/**
 * test-mode-system.ts — 模式系统 P0 自测
 * 验证：注册/激活/叠加/移除、工具门（白名单/黑名单）、prompt 拼接、async hook 链、指令匹配
 *
 * 运行：npx tsx scripts/test-mode-system.ts
 */
import {
  registerMode,
  getMode,
  listModes,
  setActiveModes,
  addActiveMode,
  removeActiveMode,
  getActiveModeNames,
  getActiveModes,
  checkToolGate,
  describeActive,
} from '../src/modes/registry';
import { composeHooks } from '../src/memory_agent';
import { ModeCommand } from '../src/command/commands/mode.command';

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── 注册测试模式 ──
registerMode({
  name: 'kb',
  label: '知识库模式',
  description: '强制检索',
  icon: '📚',
  promptAddon: '【知识库模式】回答前必须先检索知识库。',
  allowTools: ['kb_query', 'kb_status', 'read_file'],
});
registerMode({
  name: 'manager',
  label: 'Manager 模式',
  description: '子 agent 编排',
  icon: '🧑💼',
  denyTools: ['collab_send'],
});

console.log('1) 注册与查询');
assert('getMode(kb) 存在', !!getMode('kb'));
assert('listModes 含 2 个', listModes().length === 2, `实际 ${listModes().length}`);
assert('getMode(未知) 为 undefined', getMode('nope') === undefined);

console.log('2) 激活/叠加/移除');
assert('初始无激活', getActiveModeNames().length === 0);
assert('setActiveModes([kb]) ok', setActiveModes(['kb']).ok);
assert('激活为 kb', getActiveModeNames().join(',') === 'kb');
assert('describeActive 含模式名', describeActive().includes('知识库模式'));
assert('未知模式拒绝', !setActiveModes(['nope']).ok);
assert('default 清空', setActiveModes(['default']).ok && getActiveModeNames().length === 0);
assert('+kb 叠加', addActiveMode('kb').ok && getActiveModeNames().join(',') === 'kb');
assert('+manager 叠加', addActiveMode('manager').ok && getActiveModeNames().join(',') === 'kb,manager');
assert('-kb 移除', removeActiveMode('kb').ok && getActiveModeNames().join(',') === 'manager');
setActiveModes([]);

console.log('3) 工具门');
assert('无模式全放行', checkToolGate('anything').allowed);
setActiveModes(['kb']);
assert('白名单内放行', checkToolGate('kb_query').allowed);
assert('白名单外拒绝', !checkToolGate('execute_command').allowed);
assert('拒绝带原因', checkToolGate('execute_command').reason?.includes('白名单') === true);
setActiveModes(['manager']);
assert('黑名单拒绝', !checkToolGate('collab_send').allowed);
assert('黑名单外放行', checkToolGate('collab_send2').allowed);
setActiveModes([]);

console.log('4) 指令匹配');
assert('/mode 匹配', ModeCommand.match('/mode'));
assert('mode list 匹配', ModeCommand.match('mode list'));
assert('/mode kb 匹配', ModeCommand.match('/mode kb'));
assert('其他输入不匹配', !ModeCommand.match('/clear'));

console.log('5) async hook 链（composeHooks）');
const syncHook = (msgs: any[]) => [...msgs, { role: 'user', content: 'sync' }];
const asyncHook = async (msgs: any[]) => {
  await new Promise((r) => setTimeout(r, 5));
  return [...msgs, { role: 'user', content: 'async' }];
};
const composed = composeHooks(syncHook as any, asyncHook as any);
const out = await composed([]);
assert('组合结果含 sync+async', out.length === 2 && out[0].content === 'sync' && out[1].content === 'async');

console.log('6) prompt 拼接（withModePrompts 逻辑复现）');
setActiveModes(['kb']);
const base = 'BASE_PROMPT';
const parts = getActiveModes().map((m) => m.promptAddon).filter(Boolean) as string[];
const finalPrompt = parts.length ? `${base}\n\n${parts.join('\n\n')}` : base;
assert('kb promptAddon 拼入', finalPrompt.includes('知识库模式') && finalPrompt.startsWith('BASE_PROMPT'));
setActiveModes([]);
const finalEmpty = getActiveModes().map((m) => m.promptAddon).filter(Boolean).length
  ? 'x' : base;
assert('无模式时 base 原样', finalEmpty === base);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);


