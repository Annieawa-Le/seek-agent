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
  filterToolsForActiveModes,
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
  allowTools: ['read_file', 'read_lines', 'search_all_file', 'spawn_agent', 'agent_task', 'list_workers', 'list_directory', 'memory_add', 'create_todo', 'browser_navigate', 'search_web', 'tavily_search'],
});
registerMode({
  name: 'denytest',
  label: '黑名单测试',
  description: 'deny 场景',
  denyTools: ['collab_send'],
});
assert('listModes 含 3 个', listModes().length === 3, `实际 ${listModes().length}`);
console.log('1) 注册与查询');
assert('getMode(kb) 存在', !!getMode('kb'));
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
assert('manager 白名单内放行(读)', checkToolGate('read_file').allowed);
assert('manager 白名单内放行(搜)', checkToolGate('search_all_file').allowed);
assert('manager 白名单内放行(编排)', checkToolGate('spawn_agent').allowed);
assert('manager 白名单内放行(记忆)', checkToolGate('memory_add').allowed);
assert('manager 白名单内放行(待办)', checkToolGate('create_todo').allowed);
assert('manager 白名单内放行(浏览器)', checkToolGate('browser_navigate').allowed);
assert('manager 白名单内放行(联网搜索)', checkToolGate('search_web').allowed);
assert('manager 白名单内放行(联网搜索tavily)', checkToolGate('tavily_search').allowed);
assert('manager 白名单外拒绝', !checkToolGate('add_patch').allowed);
assert('manager 拒绝带原因', checkToolGate('add_patch').reason?.includes('白名单') === true);
setActiveModes([]);
setActiveModes(['denytest']);
assert('黑名单拒绝', !checkToolGate('collab_send').allowed);
assert('黑名单外放行', checkToolGate('collab_send2').allowed);
setActiveModes([]);

console.log('6) filterToolsForActiveModes 工具集过滤');
const toolSet = { read_file: 1, search_all_file: 2, add_patch: 3, spawn_agent: 4, execute_command: 5, collab_send: 6, memory_add: 7, create_todo: 8, browser_navigate: 9 };
assert('无模式原样返回', filterToolsForActiveModes(toolSet) === toolSet);
setActiveModes(['manager']);
const filtered = filterToolsForActiveModes(toolSet);
assert('manager 过滤后仅白名单', Object.keys(filtered).sort().join(',') === 'browser_navigate,create_todo,memory_add,read_file,search_all_file,spawn_agent', `实际 ${Object.keys(filtered).join(',')}`);
assert('原对象不变', Object.keys(toolSet).length === 9);
setActiveModes(['denytest']);
const denied = filterToolsForActiveModes(toolSet);
assert('仅黑名单模式剔除黑名单工具', !('collab_send' in denied) && 'execute_command' in denied, `实际 ${Object.keys(denied).join(',')}`);
setActiveModes([]);

console.log('4) 指令匹配');
assert('/mode 匹配', ModeCommand.match('/mode'));
assert('mode list 匹配', ModeCommand.match('mode list'));
assert('/mode kb 匹配', ModeCommand.match('/mode kb'));
assert('其他输入不匹配', !ModeCommand.match('/clear'));

console.log('7) async hook 链（composeHooks）');
const syncHook = (msgs: any[]) => [...msgs, { role: 'user', content: 'sync' }];
const asyncHook = async (msgs: any[]) => {
  await new Promise((r) => setTimeout(r, 5));
  return [...msgs, { role: 'user', content: 'async' }];
};
const composed = composeHooks(syncHook as any, asyncHook as any);
const out = await composed([]);
assert('组合结果含 sync+async', out.length === 2 && out[0].content === 'sync' && out[1].content === 'async');

console.log('8) prompt 拼接（withModePrompts 逻辑复现）');
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















