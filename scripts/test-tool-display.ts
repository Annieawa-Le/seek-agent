/**
 * tool-display-config 显示名占位符逻辑验证
 * 运行：pnpm tsx scripts/test-tool-display.ts
 */
import { formatToolDisplayName } from '../electron/renderer/src/utils/tool-display-config.ts';

let pass = 0;
let fail = 0;
function check(name: string, actual: string, expected: string) {
  const ok = actual === expected;
  if (ok) pass++;
  else {
    fail++;
    console.log(`✗ ${name}: got "${actual}", want "${expected}"`);
  }
}

check('read_lines 全字段', formatToolDisplayName('read_lines', { filePath: 'src/agent.ts', startLine: 1, endLine: 50 }), 'read_lines src/agent.ts:1-50');
check('read_file 路径', formatToolDisplayName('read_file', { filePath: 'src/tools/index.ts' }), 'read_file src/tools/index.ts');
check('modify_patch 数字行号', formatToolDisplayName('modify_patch', { filePath: 'a.ts', startLine: 3, endLine: 8 }), 'modify_patch a.ts:3-8');
check('字段缺失移除空段', formatToolDisplayName('read_lines', { startLine: 1, endLine: 50 }), 'read_lines:1-50');
check('字符串空值当缺失', formatToolDisplayName('search_web', { query: '' }), 'search_web');
check('未配置回退原名', formatToolDisplayName('undo_patch', {}), 'undo_patch');
check('无 args 也回退原名', formatToolDisplayName('memory_clear'), 'memory_clear');
check('对象序列化', formatToolDisplayName('create_file', { filePath: 'x', fileName: 'y.ts' }), 'create_file x/y.ts');
check('超长值截断', formatToolDisplayName('execute_command', { command: 'a'.repeat(50) }), `execute_command ${'a'.repeat(40)}…`);
check('中文值', formatToolDisplayName('agent_task', { name: '小码' }), 'agent_task 小码');
check('浏览器导航', formatToolDisplayName('browser_navigate', { url: 'https://example.com' }), 'browser_navigate https://example.com');

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
