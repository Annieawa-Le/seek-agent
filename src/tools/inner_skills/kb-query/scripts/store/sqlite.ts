/**
 * SqliteVectorStore — SQLite + sqlite-vec 向量存储
 *
 * 依赖: better-sqlite3, sqlite-vec
 * 零配置，文件存储，适合中等规模（<50000 chunks）知识库。
 * 数据存储在 .seek-agent/kb/vector.db
 */

import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { Chunk, SearchResult, VectorStore } from './interface';

const KB_DIR = '.seek-agent/kb';
const DB_FILE = 'vector.db';

interface BetterSqlite3 {
  (filename: string, options?: any): any;
  Database: new (filename: string, options?: any) => any;
}

export class SqliteVectorStore implements VectorStore {
  private dbPath: string;
  private db: any = null;
  private loaded = false;
  private embeddingDim = 0;

  constructor(basePath?: string) {
    const base = basePath ? path.join(basePath, KB_DIR) : path.resolve(KB_DIR);
    this.dbPath = path.join(base, DB_FILE);
  }

  async init(dim?: number): Promise<void> {
    if (dim) this.embeddingDim = dim;
    await mkdir(path.dirname(this.dbPath), { recursive: true });
    await this.initDb();
  }

  private async initDb(): Promise<void> {
    try {
      const betterSqlite3: any = await import('better-sqlite3');
      // 尝试加载 sqlite-vec
      let vecInit: any = null;
      try {
        vecInit = await import('sqlite-vec');
      } catch {
        // sqlite-vec 没有安装，回退到纯向量搜索（无索引）
      }

      this.db = new betterSqlite3.default(this.dbPath);
      // WAL 模式提高并发
      this.db.pragma('journal_mode = WAL');

      if (vecInit) {
        vecInit.default?.(this.db) || vecInit?.(this.db);
      }

      // 建表
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS kb_chunks (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          embedding BLOB NOT NULL,
          file_path TEXT NOT NULL,
          chunk_type TEXT NOT NULL,
          chunk_name TEXT,
          start_line INTEGER,
          end_line INTEGER,
          description TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_kb_file_path ON kb_chunks(file_path);
        CREATE INDEX IF NOT EXISTS idx_kb_chunk_type ON kb_chunks(chunk_type);
      `);

      // 如有 sqlite-vec，建虚拟表
      if (vecInit) {
        try {
          this.db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS kb_vectors USING vec0(
              id TEXT PRIMARY KEY,
              embedding FLOAT[${this.embeddingDim || 768}]
            );
          `);
        } catch {
          // 维度变更时需要重建，这里捕获异常
        }
      }

      this.loaded = true;
    } catch (e: any) {
      throw new Error(`SQLite 初始化失败: ${e.message}。请安装依赖: pnpm add better-sqlite3 sqlite-vec`);
    }
  }

  async insert(chunk: Chunk): Promise<void> {
    if (!this.loaded) await this.initDb();
    this.embeddingDim = chunk.embedding.length;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO kb_chunks (id, content, embedding, file_path, chunk_type, chunk_name, start_line, end_line, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      chunk.id,
      chunk.content,
      Buffer.from(new Float32Array(chunk.embedding).buffer),
      chunk.metadata.filePath,
      chunk.metadata.type,
      chunk.metadata.name || null,
      chunk.metadata.startLine || null,
      chunk.metadata.endLine || null,
      chunk.metadata.description || null,
    );
  }

  async insertBatch(chunks: Chunk[]): Promise<void> {
    const insert = this.db.transaction((items: Chunk[]) => {
      for (const c of items) {
        this.insert(c);
      }
    });
    insert(chunks);
  }

  async search(query: { embedding: number[]; topK?: number }): Promise<SearchResult[]> {
    if (!this.loaded) await this.initDb();
    const topK = query.topK ?? 5;

    const queryVec = new Float32Array(query.embedding);
    const allRows = this.db.prepare('SELECT * FROM kb_chunks').all();

    // 内存计算余弦相似度（sqlite-vec 索引尚未稳定，用内存计算更可靠）
    const scored = allRows.map((row: any) => {
      const stored = new Float32Array(row.embedding);
      let dot = 0, normA = 0, normB = 0;
      for (let i = 0; i < queryVec.length; i++) {
        dot += queryVec[i] * stored[i];
        normA += queryVec[i] * queryVec[i];
        normB += stored[i] * stored[i];
      }
      const score = Math.sqrt(normA) * Math.sqrt(normB) === 0 ? 0 :
        dot / (Math.sqrt(normA) * Math.sqrt(normB));

      return {
        chunk: this.rowToChunk(row),
        score,
      };
    });

    return scored.sort((a: SearchResult, b: SearchResult) => b.score - a.score).slice(0, topK);
  }

  async hybridSearch(query: { embedding: number[]; text: string; topK?: number }): Promise<SearchResult[]> {
    // 对 SQLite，关键词用 LIKE 近似
    const vecResults = await this.search({ embedding: query.embedding, topK: (query.topK ?? 5) * 2 });
    const keywords = query.text.toLowerCase().split(/[\s,.;:!?()\[\]{}"'/\\<>《》【】]+/).filter(Boolean);
    const uniqueKeys = [...new Set(keywords)];

    const scored = vecResults.map(r => {
      const lower = r.chunk.content.toLowerCase();
      const hits = uniqueKeys.filter(k => lower.includes(k)).length;
      const kwScore = uniqueKeys.length > 0 ? hits / uniqueKeys.length : 0;
      return { ...r, score: r.score * 0.7 + kwScore * 0.3 };
    });

    return scored.sort((a, b) => b.score - a.score).slice(0, query.topK ?? 5);
  }

  async delete(filter: { filePath?: string; type?: string }): Promise<number> {
    if (!this.loaded) await this.initDb();
    const conditions: string[] = [];
    const params: any[] = [];

    if (filter.filePath) {
      conditions.push('file_path = ?');
      params.push(filter.filePath);
    }
    if (filter.type) {
      conditions.push('chunk_type = ?');
      params.push(filter.type);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = this.db.prepare(`DELETE FROM kb_chunks ${where}`).run(...params);
    return result.changes;
  }

  async clear(): Promise<void> {
    if (!this.loaded) await this.initDb();
    this.db.exec('DELETE FROM kb_chunks');
  }

  async stats(): Promise<{ totalChunks: number; storeType: string; embeddingDim: number; files: string[]; lastUpdated: string }> {
    if (!this.loaded) await this.initDb();
    const count = this.db.prepare('SELECT COUNT(*) as cnt FROM kb_chunks').get().cnt;
    const fileRows = this.db.prepare('SELECT DISTINCT file_path FROM kb_chunks ORDER BY file_path').all();
    const files = fileRows.map((r: any) => r.file_path);
    const lastRow = this.db.prepare('SELECT created_at FROM kb_chunks ORDER BY created_at DESC LIMIT 1').get();
    return {
      totalChunks: count,
      storeType: 'sqlite',
      embeddingDim: this.embeddingDim,
      files,
      lastUpdated: lastRow?.created_at || 'never',
    };
  }

  private rowToChunk(row: any): Chunk {
    const embedding = Array.from(new Float32Array(row.embedding));
    return {
      id: row.id,
      content: row.content,
      embedding,
      metadata: {
        filePath: row.file_path,
        type: row.chunk_type as Chunk['metadata']['type'],
        name: row.chunk_name || undefined,
        startLine: row.start_line || undefined,
        endLine: row.end_line || undefined,
        description: row.description || undefined,
      },
    };
  }
}

