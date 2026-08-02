/**
 * Store 工厂 — 根据环境变量自动选择后端
 *
 * KB_STORE 可选值:
 *   - "json"     (默认) JSON 文件存储，零依赖
 *   - "sqlite"   SQLite + sqlite-vec，需要 better-sqlite3
 *   - "postgres" PostgreSQL + pgvector，需要 pg 和已安装扩展的 PG 服务
 */

import type { VectorStore } from './interface';
import { JsonFileVectorStore } from './json-file';
import type { SqliteVectorStore as SqliteStoreType } from './sqlite';
import type { PostgresVectorStore as PostgresStoreType } from './postgres';
import { getWorkspaceRoot } from '../../../../../workdir';

/** 按「后端类型 + 工作区/显式路径」缓存 store 实例：切换工作区后自动使用新工作区的索引 */
const _instances = new Map<string, VectorStore>();

/** 缓存键：后端类型 + 工作区根目录（或显式 KB_PATH） */
function storeKey(): string {
  const type = getStoreType();
  const base = process.env.KB_PATH || getWorkspaceRoot();
  return `${type}|${base}`;
}

function detectStoreType(): string {
  return (process.env.KB_STORE || 'json').toLowerCase().trim();
}

export function getStoreType(): string {
  const type = detectStoreType();
  switch (type) {
    case 'postgres':
    case 'pg':
      return 'postgres';
    case 'sqlite':
    case 'sqlite3':
      return 'sqlite';
    default:
      return 'json';
  }
}

export function getStoreConnectionString(): string {
  return process.env.PG_URL || process.env.KB_PG_URL || 'postgresql://localhost:5432/seek_kb';
}

/**
 * 获取 VectorStore 实例（按工作区缓存）
 * 首次调用时根据环境变量自动选择并初始化后端。
 * dim 为向量维度，如果提供则建表时直接指定，否则从首条数据推断。
 */
export async function getStore(dim?: number): Promise<VectorStore> {
  const key = storeKey();
  const cached = _instances.get(key);
  if (cached) return cached;

  const type = getStoreType();
  const basePath = process.env.KB_PATH || undefined;

  switch (type) {
    case 'postgres': {
      const { PostgresVectorStore } = await import('./postgres');
      const store = new PostgresVectorStore(getStoreConnectionString(), basePath);
      await store.init(dim);
      _instances.set(key, store);
      break;
    }
    case 'sqlite': {
      const { SqliteVectorStore } = await import('./sqlite');
      const store = new (SqliteVectorStore as any)(basePath) as SqliteStoreType;
      await store.init(dim);
      _instances.set(key, store as unknown as VectorStore);
      break;
    }
    default: {
      const store = new JsonFileVectorStore(basePath);
      await store.init(dim);
      _instances.set(key, store);
      break;
    }
  }

  return _instances.get(key)!;
}

/** 重置全部缓存实例（切换后端或重建索引时使用） */
export function resetStore(): void {
  _instances.clear();
}




