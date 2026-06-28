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

let _instance: VectorStore | null = null;

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
 * 获取 VectorStore 单例
 * 首次调用时根据环境变量自动选择并初始化后端。
 * dim 为向量维度，如果提供则建表时直接指定，否则从首条数据推断。
 */
export async function getStore(dim?: number): Promise<VectorStore> {
  if (_instance) return _instance;

  const type = getStoreType();
  const basePath = process.env.KB_PATH || undefined;

  switch (type) {
    case 'postgres': {
      const { PostgresVectorStore } = await import('./postgres');
      const store = new PostgresVectorStore(getStoreConnectionString(), basePath);
      await store.init(dim);
      _instance = store;
      break;
    }
    case 'sqlite': {
      const { SqliteVectorStore } = await import('./sqlite');
      const store = new (SqliteVectorStore as any)(basePath) as SqliteStoreType;
      await store.init(dim);
      _instance = store as unknown as VectorStore;
      break;
    }
    default: {
      const store = new JsonFileVectorStore(basePath);
      await store.init(dim);
      _instance = store;
      break;
    }
  }

  return _instance!;
}

/** 重置单例（切换后端或重建索引时使用） */
export function resetStore(): void {
  _instance = null;
}

