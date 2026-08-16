/**
 * test-workdir-roots —— 多工作区支持测试
 * 1) workdir.ts 沙箱多根（setWorkspaceRootsOnly / assertPathInWorkspace / getWorkspaceRoots）
 * 2) workdir-roots 指令（match / execute / 静默模式 / 无效 payload / 查看模式）
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandRegistry } from '../src/command/registry';
import { WorkdirRootsCommand } from '../src/command/commands/workdir-roots.command';
import {
  getCwd,
  getWorkspaceRoot,
  getWorkspaceRoots,
  setWorkspaceRootsOnly,
  setWorkspaceRootOnly,
  resetWorkspaceRoot,
  assertPathInWorkspace,
} from '../src/workdir';
import { setExplorerRoot, getExplorerRoot } from '../src/tools/inner_skills/virtual-explorer/explorer-state';

let passed = 0;
let failed = 0;
function ok(name: string) {
  passed++;
  console.log(`  ✅ ${name}`);
}
function fail(name: string, err: unknown) {
  failed++;
  console.log(`  ❌ ${name}: ${err instanceof Error ? err.message : String(err)}`);
}
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

// ── 临时目录 ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seek-wd-'));
const dirA = path.join(tmp, 'projA');
const dirB = path.join(tmp, 'projB');
const dirC = path.join(tmp, 'projC');
for (const d of [dirA, dirB, dirC]) fs.mkdirSync(d, { recursive: true });

// mock ctx（指令 execute 需要 ui + agent）
function makeCtx() {
  const msgs: string[] = [];
  const ui = {
    addUserMessage: (m: string) => msgs.push(`U:${m}`),
    addAgentMessage: (m: string) => msgs.push(`A:${m}`),
  };
  const agent = { reloadPrompt: () => {} };
  return { ui, agent, msgs };
}

async function main() {
  console.log('── workdir.ts 沙箱多根 ──');

  await test('setWorkspaceRootsOnly 设置多根 + 活跃根（不改 cwd，cwd 由指令层负责）', () => {
    const cwdBefore = getCwd();
    setWorkspaceRootsOnly([dirA, dirB], dirB);
    assert.deepStrictEqual(getWorkspaceRoots(), [dirA, dirB]);
    assert.strictEqual(getWorkspaceRoot(), dirB);
    assert.strictEqual(getCwd(), cwdBefore, '沙箱函数不改 cwd');
  });

  await test('assertPathInWorkspace 在任意根下放行', () => {
    assert.doesNotThrow(() => assertPathInWorkspace(path.join(dirA, 'x', 'y.ts')));
    assert.doesNotThrow(() => assertPathInWorkspace(path.join(dirB, 'file.ts')));
  });

  await test('assertPathInWorkspace 根外拒绝', () => {
    assert.throws(() => assertPathInWorkspace(path.join(dirC, 'file.ts')), /工作区以外/);
    assert.throws(() => assertPathInWorkspace(tmp), /工作区以外/);
  });

  await test('活跃根不在列表时回退第一个', () => {
    setWorkspaceRootsOnly([dirA, dirB], dirC);
    assert.strictEqual(getWorkspaceRoot(), dirA);
  });

  await test('setWorkspaceRootOnly 单路径语义（兼容）', () => {
    setWorkspaceRootOnly(dirC);
    assert.deepStrictEqual(getWorkspaceRoots(), [dirC]);
    assert.strictEqual(getWorkspaceRoot(), dirC);
  });

  await test('resetWorkspaceRoot 恢复初始根', () => {
    setWorkspaceRootsOnly([dirA, dirB], dirB);
    resetWorkspaceRoot();
    assert.deepStrictEqual(getWorkspaceRoots(), [path.resolve(process.cwd())]);
    assert.strictEqual(getWorkspaceRoot(), path.resolve(process.cwd()));
  });

  console.log('── workdir-roots 指令 ──');

  const registry = new CommandRegistry().register(WorkdirRootsCommand);

  await test('match 识别 /workdir-roots 与裸命令', () => {
    assert.strictEqual(WorkdirRootsCommand.match('/workdir-roots'), true);
    assert.strictEqual(WorkdirRootsCommand.match('workdir-roots'), true);
    assert.strictEqual(WorkdirRootsCommand.match('/workdir'), false);
    assert.strictEqual(WorkdirRootsCommand.match('hello'), false);
  });

  await test('execute 静默设置多根并同步 explorer/cwd', () => {
    setWorkspaceRootsOnly([dirA], dirA);
    const ctx = makeCtx();
    const payload = JSON.stringify({ roots: [dirA, dirB], active: dirB });
    WorkdirRootsCommand.execute(`workdir-roots silent ${payload}`, ctx as any);
    assert.deepStrictEqual(getWorkspaceRoots(), [dirA, dirB]);
    assert.strictEqual(getWorkspaceRoot(), dirB);
    assert.strictEqual(getExplorerRoot(), dirB);
    assert.strictEqual(getCwd(), dirB);
    assert.strictEqual(ctx.msgs.length, 0, '静默模式不产生气泡');
  });

  await test('execute 无 payload 时展示当前状态', () => {
    setWorkspaceRootsOnly([dirA, dirB], dirA);
    const ctx = makeCtx();
    WorkdirRootsCommand.execute('workdir-roots', ctx as any);
    const agentMsg = ctx.msgs.find(m => m.startsWith('A:'));
    assert.ok(agentMsg && agentMsg.includes(dirA), `展示应包含根路径: ${agentMsg}`);
    assert.ok(agentMsg.includes(dirB));
  });

  await test('execute 无效 payload 报错', () => {
    const ctx = makeCtx();
    WorkdirRootsCommand.execute('workdir-roots not-json', ctx as any);
    assert.ok(ctx.msgs.some(m => m.includes('❌')), '应产生错误气泡');
  });

  await test('execute 空 roots 报错', () => {
    const ctx = makeCtx();
    WorkdirRootsCommand.execute('workdir-roots {"roots":[]}', ctx as any);
    assert.ok(ctx.msgs.some(m => m.includes('❌')), '应产生错误气泡');
  });

  await test('registry 全链路：tryExecute 处理 workdir-roots', async () => {
    const ctx = makeCtx();
    const payload = JSON.stringify({ roots: [dirB], active: dirB });
    const handled = await registry.tryExecute(`workdir-roots silent ${payload}`, ctx as any);
    assert.strictEqual(handled, true);
    assert.deepStrictEqual(getWorkspaceRoots(), [dirB]);
  });

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main();

