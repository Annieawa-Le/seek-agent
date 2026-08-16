/**
 * 验证文件池（doc_pool）核心逻辑：
 * 1. 工具分类 / 路径提取 / 结果提取
 * 2. scanReadPhase 读阶段识别（读取记录、写/TODO 结束读阶段、写文件列表）
 * 3. docPoolStore.associateAndScan 填充池 + 修改过的文件移除（累积语义）
 * 4. onToolResult 实时挂钩（读阶段记录 / 写文件移除 / 读阶段结束后不记录）
 * 5. buildInjectionMessage 注入消息构建
 * 6. unlinkAgent 只解除关联（池与磁盘文件保留）
 * 7. 持久化：落盘 subagent-docs / 跨实例恢复（模拟重启）
 */
import {
  isReadTool,
  isWriteTool,
  isTodoTool,
  extractFilePath,
  extractResultText,
  scanReadPhase,
  buildInjectionMessage,
  normKey,
  DocPoolStore,
  docPoolStore,
} from '../src/tools/doc-pool-store';
import { setWorkspaceRoot, resetWorkspaceRoot } from '../src/workdir';
import * as fs from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seek-docpool-'));
setWorkspaceRoot(tmp);
docPoolStore.setSessionId('test-sid');

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── 1. 分类与提取 ──
console.log('\n[1] 工具分类 / 路径提取 / 结果提取');
assert(isReadTool('read_file') && isReadTool('read_lines') && isReadTool('scan_file'), 'read_file/read_lines/scan_file 是读取工具');
assert(isReadTool('explorer-read-file'), 'explorer-read-file 是读取工具');
assert(!isReadTool('add_patch'), 'add_patch 不是读取工具');
assert(isWriteTool('add_patch') && isWriteTool('modify_patch') && isWriteTool('create_file') && isWriteTool('replace_file'), '写入工具识别');
assert(isTodoTool('create_todo') && isTodoTool('finish_step'), 'TODO 工具识别');
assert(!isWriteTool('read_file'), 'read_file 不是写入工具');
assert(extractFilePath('read_file', { filePath: 'src/a.ts' }) === 'src/a.ts', 'read_file 路径提取');
assert(extractFilePath('create_file', { filePath: 'src/b.ts' }) === 'src/b.ts', 'create_file 完整路径提取');
assert(extractFilePath('read_file', {}) === undefined, '无路径返回 undefined');
assert(extractResultText('hello') === 'hello', '字符串结果');
assert(extractResultText({ type: 'text', value: '内容' }) === '内容', 'text 对象结果');

// ── 2. scanReadPhase 读阶段识别 ──
console.log('\n[2] scanReadPhase');
const msgs: any[] = [
  // 读阶段：两个读取
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'read_file', input: { filePath: 'src/a.ts' } }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'read_file', output: { type: 'text', value: '文件A内容' } }] },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c2', toolName: 'read_lines', input: { filePath: 'src/b.ts', startLine: 1, endLine: 10 } }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c2', toolName: 'read_lines', output: { type: 'text', value: '文件B前10行' } }] },
  // 写入工具：结束读阶段 + 文件记录
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c3', toolName: 'modify_patch', input: { filePath: 'src/a.ts' } }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c3', toolName: 'modify_patch', output: { type: 'text', value: 'ok' } }] },
  // 写入之后继续读取：不再记录
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c4', toolName: 'read_file', input: { filePath: 'src/c.ts' } }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c4', toolName: 'read_file', output: { type: 'text', value: '文件C' } }] },
];
const scanned = scanReadPhase(msgs);
assert(scanned.readEntries.length === 2, `读阶段记录 2 个读取（实际 ${scanned.readEntries.length}）`);
assert(scanned.readEntries[0].filePath === 'src/a.ts' && scanned.readEntries[0].result === '文件A内容', '首条读取内容完整');
assert(scanned.readEntries[1].filePath === 'src/b.ts', '第二条读取（read_lines）记录');
assert(scanned.readEntries.some((e) => e.filePath === 'src/c.ts') === false, '写工具之后的读取不记录');
assert(scanned.writtenFiles.includes('src/a.ts') && !scanned.writtenFiles.includes('src/b.ts'), '写工具文件进入 writtenFiles');

// TODO 工具结束读阶段
const todoMsgs: any[] = [
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'read_file', input: { filePath: 'x.ts' } }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'read_file', output: { type: 'text', value: 'X' } }] },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't2', toolName: 'create_todo', input: {} }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't2', toolName: 'create_todo', output: { type: 'text', value: 'ok' } }] },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't3', toolName: 'read_file', input: { filePath: 'y.ts' } }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't3', toolName: 'read_file', output: { type: 'text', value: 'Y' } }] },
];
const todoScan = scanReadPhase(todoMsgs);
assert(todoScan.readEntries.length === 1 && todoScan.readEntries[0].filePath === 'x.ts', 'TODO 工具结束读阶段');

// ── 3. associateAndScan 填充池 + 修改文件移除 ──
console.log('\n[3] associateAndScan（doc_pool 调用路径）');
const pool = docPoolStore.associateAndScan('渲染组', '渲染修复员', msgs);
// a.ts 读后被 modify_patch 修改 → 移除；b.ts 保留 → 池剩 1 个文件 1 条片段
assert(pool.files.size === 1, `池含 1 个文件（a.ts 被修改移除，实际 ${pool.files.size}）`);
assert(pool.entries.length === 1, `池含 1 条片段（实际 ${pool.entries.length}）`);
assert(pool.files.has(normKey('src/a.ts')) === false, '被修改的文件 a.ts 已从池移除');
assert(pool.files.has(normKey('src/b.ts')) === true, '未修改的文件 b.ts 保留');
assert(pool.agentName === '渲染修复员', '池关联子模型名正确');
assert(docPoolStore.getPool('渲染组') === pool, 'getPool 命中');
assert(docPoolStore.listPools().includes('渲染组'), 'listPools 列出池');
assert(docPoolStore.describePool('渲染组').includes('src/b.ts'), 'describePool 摘要含文件');
assert(docPoolStore.describePool('不存在的池').includes('不存在'), 'describePool 未命中提示');

// 累积语义：同名池再次关联（恢复磁盘池 + 扫描去重）仍 1 条，不清空
docPoolStore.associateAndScan('渲染组', '渲染修复员', msgs);
assert(docPoolStore.getPool('渲染组')!.entries.length === 1, '再次关联不清空（累积语义）');

// ── 4. onToolResult 实时挂钩 ──
console.log('\n[4] onToolResult 实时挂钩');
const pool2 = docPoolStore.associateAndScan('后端组', '后端开发', []);
// 读阶段读取
docPoolStore.onToolResult('后端开发', 'read_file', { filePath: 'src/api.ts' }, 'API定义', 'r1');
docPoolStore.onToolResult('后端开发', 'read_lines', { filePath: 'src/db.ts' }, 'DB片段', 'r2');
assert(pool2.files.size === 2, `实时挂钩记录 2 个文件（实际 ${pool2.files.size}）`);
assert(pool2.entries.length === 2, `实时挂钩记录 2 条片段（实际 ${pool2.entries.length}）`);
// 写入工具：移除文件 + 结束读阶段
docPoolStore.onToolResult('后端开发', 'modify_patch', { filePath: 'src/api.ts' }, 'ok', 'w1');
assert(pool2.files.has('src/api.ts') === false, '被修改的文件从池移除');
assert(pool2.entries.length === 1, '移除后剩 1 条片段');
// 读阶段结束后的读取不再记录
docPoolStore.onToolResult('后端开发', 'read_file', { filePath: 'src/new.ts' }, '新文件', 'r3');
assert(pool2.files.has('src/new.ts') === false, '写工具之后的读取不记录');
// 非关联 agent 不影响
const poolBefore = pool2.entries.length;
docPoolStore.onToolResult('路人甲', 'read_file', { filePath: 'src/other.ts' }, 'X', 'rx');
assert(pool2.entries.length === poolBefore, '未关联 agent 的读取不记录');
// TODO 工具结束读阶段（不记录读取）
const pool3 = docPoolStore.associateAndScan('临时池', '临时工', []);
docPoolStore.onToolResult('临时工', 'create_todo', {}, 'ok', 'todo1');
docPoolStore.onToolResult('临时工', 'read_file', { filePath: 'z.ts' }, 'Z', 'rz');
assert(pool3.entries.length === 0, 'TODO 之后读取不记录');

// ── 5. buildInjectionMessage ──
console.log('\n[5] buildInjectionMessage 注入构建');
const inject = buildInjectionMessage(pool2);
assert(inject.startsWith('【文件池：后端组】'), '注入消息带池名前缀');
assert(inject.includes('src/db.ts'), '注入包含文件路径');
assert(inject.includes('DB片段'), '注入包含文件内容');
assert(inject.includes('参考文件片段'), '注入带说明头');

// ── 6. unlinkAgent ──
console.log('\n[6] unlinkAgent 关联清理');
docPoolStore.unlinkAgent('后端开发');
// unlink 只解除实时挂钩关联：池保留（团队知识不随成员销毁）
assert(docPoolStore.getPool('后端组') !== undefined, 'unlink 后池仍保留（不销毁）');
assert(docPoolStore.listPools().includes('后端组'), 'listPools 仍含后端组');
const beforeLen = docPoolStore.getPool('后端组')!.entries.length;
docPoolStore.onToolResult('后端开发', 'read_file', { filePath: 'src/xx.ts' }, 'X', 'rx2');
assert(docPoolStore.getPool('后端组')!.entries.length === beforeLen, 'unlink 后挂钩不再记录（关联已解除）');

// ── 7. 持久化：落盘 subagent-docs + 跨实例恢复（模拟重启） ──
console.log('\n[7] 持久化（subagent-docs）');
const persistStore = new DocPoolStore();
persistStore.setSessionId('test-sid');
const pPool = persistStore.associateAndScan('持久池', '持久员', []);
persistStore.onToolResult('持久员', 'read_file', { filePath: 'src/persist.ts' }, '持久内容', 'p1');
persistStore.onToolResult('持久员', 'read_file', { filePath: 'src/persist2.ts' }, '持久内容2', 'p2');
const poolFilePath = path.join(tmp, 'sessions', 'test-sid', 'subagent-docs', 'doc-pool-持久池.json');
assert(fs.existsSync(poolFilePath), '池已落盘到 sessions/{sid}/subagent-docs/');
const disk = JSON.parse(fs.readFileSync(poolFilePath, 'utf-8'));
assert(disk.poolName === '持久池' && disk.entries.length === 2, '磁盘文件含池名与 2 条片段');
// 模拟重启：新实例同名关联 → 从磁盘恢复
const freshStore = new DocPoolStore();
freshStore.setSessionId('test-sid');
const restored = freshStore.associateAndScan('持久池', '新持久员', []);
assert(restored.entries.length === 2, '新实例从磁盘恢复 2 条片段');
assert(restored.files.has(normKey('src/persist.ts')), '恢复后文件分组完整');
// 恢复后实时挂钩继续追加（跨重启的池可继续用）
freshStore.onToolResult('新持久员', 'read_file', { filePath: 'src/persist3.ts' }, '持久内容3', 'p3');
assert(restored.entries.length === 3, '恢复后可继续追加');
// 写工具修改 → 磁盘同步移除
freshStore.onToolResult('新持久员', 'modify_patch', { filePath: 'src/persist.ts' }, 'ok', 'w2');
assert(restored.files.has(normKey('src/persist.ts')) === false, '修改后的文件从磁盘池移除');
const disk2 = JSON.parse(fs.readFileSync(poolFilePath, 'utf-8'));
assert(disk2.entries.length === 2 && !disk2.entries.some((e: any) => e.filePath === 'src/persist.ts'), '磁盘文件已同步移除');

// ── 8. doc_pool 工具端到端（inner_skill 集成） ──
console.log('\n[8] doc_pool 工具集成');
const { docPoolTool } = await import('../src/tools/inner_skills/doc-pool/index');
const { subAgentManager } = await import('../src/tools/inner_skills/sub-agent/manager');
const { subagentContextStore } = await import('../src/tools/subagent-context-store');
subAgentManager.spawn({ mode: 'mission', name: '集成测试员', tools: ['read_file'] });
// 模拟持久化上下文（子模型已完成，含读阶段）
subagentContextStore.save('集成测试员', {
  name: '集成测试员',
  mode: 'mission',
  tools: ['read_file'],
  messages: [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'i1', toolName: 'read_file', input: { filePath: 'src/integ.ts' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'i1', toolName: 'read_file', output: { type: 'text', value: '集成内容' } }] },
  ],
});
const result = await docPoolTool.execute!({ pool_name: '集成组', name: '集成测试员' } as any, {} as any);
assert(String(result).includes('集成组') && String(result).includes('src/integ.ts'), 'doc_pool 工具返回池摘要');
assert(docPoolStore.getPool('集成组')!.entries.length === 1, 'doc_pool 工具从持久化上下文填充池');
// 清理
subAgentManager.fire('集成测试员');
subagentContextStore.remove('集成测试员');
docPoolStore.unlinkAgent('集成测试员');

// 清理工作区
resetWorkspaceRoot();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);







