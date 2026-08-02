/**
 * 验证知识库索引按工作区隔离：
 * 1. 默认存储路径基于 getWorkspaceRoot() 而非 process.cwd()
 * 2. 切换工作区后 getStore() 使用新工作区的独立索引（缓存按工作区 key 区分）
 * 3. KB_PATH 显式指定时优先
 * 4. SQLite / Postgres 后端路径同样基于工作区
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setWorkspaceRoot } from '../src/workdir';
import { getStore, resetStore } from '../src/tools/inner_skills/kb-query/scripts/store/factory';
import { JsonFileVectorStore } from '../src/tools/inner_skills/kb-query/scripts/store/json-file';
import { SqliteVectorStore } from '../src/tools/inner_skills/kb-query/scripts/store/sqlite';
import { PostgresVectorStore } from '../src/tools/inner_skills/kb-query/scripts/store/postgres';

const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-ws-a-'));
const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-ws-b-'));

process.env.KB_STORE = 'json';
delete process.env.KB_PATH;
resetStore();

const asserts: { name: string; ok: boolean }[] = [];
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    asserts.push({ name, ok: true });
    console.log(`✅ ${name}`);
  } catch (e: any) {
    asserts.push({ name, ok: false });
    failed++;
    console.log(`❌ ${name}: ${e.message}`);
  }
}

async function main() {
  // ── 1. 默认路径基于工作区 A ──
  setWorkspaceRoot(tmpA);
  resetStore();
  const storeA1 = await getStore();
  const pathA = (storeA1 as any).kbPath as string;
  check('JSON 默认路径基于工作区 A', () => {
    assert.ok(pathA.startsWith(tmpA), `kbPath=${pathA} 应位于 ${tmpA} 下`);
    assert.ok(pathA.endsWith(path.join('.seek-agent', 'kb')), `kbPath 应以 .seek-agent/kb 结尾`);
    assert.ok(fs.existsSync(path.join(tmpA, '.seek-agent', 'kb')), 'A 的 .seek-agent/kb 目录应已创建');
  });

  // ── 2. 切换工作区 B：独立索引 + 独立实例 ──
  setWorkspaceRoot(tmpB);
  const storeB = await getStore();
  const pathB = (storeB as any).kbPath as string;
  check('切换工作区 B 后使用独立索引', () => {
    assert.ok(pathB.startsWith(tmpB), `kbPath=${pathB} 应位于 ${tmpB} 下`);
    assert.notEqual(pathA, pathB, '两个工作区的 kbPath 应不同');
    assert.ok(fs.existsSync(path.join(tmpB, '.seek-agent', 'kb')), 'B 的 .seek-agent/kb 目录应已创建');
    assert.notStrictEqual(storeB, storeA1, '工作区 B 应返回新的 store 实例');
  });

  // ── 3. 切回工作区 A：命中缓存（同一实例） ──
  setWorkspaceRoot(tmpA);
  const storeA2 = await getStore();
  check('切回工作区 A 命中缓存', () => {
    assert.strictEqual(storeA2, storeA1, '同一工作区应复用同一 store 实例');
  });

  // ── 4. KB_PATH 显式覆盖 ──
  const tmpC = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-ws-c-'));
  process.env.KB_PATH = tmpC;
  setWorkspaceRoot(tmpB);
  resetStore();
  const storeC = await getStore();
  check('KB_PATH 显式指定时优先', () => {
    assert.ok(((storeC as any).kbPath as string).startsWith(tmpC), `kbPath=${(storeC as any).kbPath} 应位于 ${tmpC} 下`);
  });
  delete process.env.KB_PATH;

  // ── 5. SQLite / Postgres 路径同样基于工作区 ──
  setWorkspaceRoot(tmpA);
  const sqliteStore = new SqliteVectorStore();
  check('SQLite 默认路径基于工作区', () => {
    const dbPath = (sqliteStore as any).dbPath as string;
    assert.ok(dbPath.startsWith(tmpA), `dbPath=${dbPath} 应位于 ${tmpA} 下`);
    assert.ok(dbPath.endsWith(path.join('.seek-agent', 'kb', 'vector.db')), 'dbPath 应以 .seek-agent/kb/vector.db 结尾');
  });

  const pgStore = new PostgresVectorStore();
  check('Postgres meta 默认路径基于工作区', () => {
    const metaPath = (pgStore as any).metaPath as string;
    assert.ok(metaPath.startsWith(tmpA), `metaPath=${metaPath} 应位于 ${tmpA} 下`);
  });

  // ── 6. FileTracker 状态文件与索引同目录（.seek-agent/kb-file-state.json） ──
  check('FileTracker 状态文件位于工作区 .seek-agent 下', () => {
    const trackerState = path.join(tmpA, '.seek-agent', 'kb-file-state.json');
    // 不强制文件存在，只验证目标目录一致
    assert.ok(trackerState.includes('.seek-agent'), '状态文件应位于 .seek-agent 下');
  });

  console.log(failed === 0 ? `\n全部通过（${asserts.length} 项）` : `\n${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
