/**
 * PostgresVectorStore — PostgreSQL + pgvector + pg_trgm 向量存储
 *
 * 依赖: pg
 * 需要 PostgreSQL 服务端安装 pgvector 和 pg_trgm 扩展。
 * 适合大规模（>50000 chunks）生产部署。
 *
 * 参考: https://github.com/Bluemangoo/shards 的记忆架构
 */

import { mkdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Chunk, SearchResult, VectorStore } from './interface';

const KB_DIR = '.seek-agent/kb';
const META_FILE = 'pg-meta.json';

interface PgClient {
  query(text: string, params?: any[]): Promise<{ rows: any[]; rowCount: number }>;
  end(): Promise<void>;
}

export class PostgresVectorStore implements VectorStore {
  private connectionString: string;
  private client: PgClient | null = null;
  private metaPath: string;
  private embeddingDim = 0;
  private loaded = false;

  constructor(connectionString?: string, basePath?: string) {
    this.connectionString = connectionString || process.env.PG_URL || 'postgresql://localhost:5432/seek_kb';
    const base = basePath ? path.join(basePath, KB_DIR) : path.resolve(KB_DIR);
    this.metaPath = path.join(base, META_FILE);
  }

  async init(dim?: number): Promise<void> {
    if (dim) this.embeddingDim = dim;
    await mkdir(path.dirname(this.metaPath), { recursive: true });
    await this.connectAndMigrate();
  }

  private async connectAndMigrate(): Promise<void> {
    try {
      const { default: pg } = await import('pg');
      this.client = new pg.Client({ connectionString: this.connectionString }) as any;

      // 读取自定义连接字符串参数
      const url = new URL(this.connectionString);
      const schema = url.searchParams.get('schema') || 'public';

      await this.client.query(`SET search_path TO "${schema}"`);

      // 创建扩展
      await this.client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await this.client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');

      // 建表（参考 shards 的 long_term_memory 表结构）
      await this.client.query(`
        CREATE TABLE IF NOT EXISTS kb_chunks (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          embedding vector(${this.embeddingDim || 768}),
          file_path TEXT NOT NULL,
          chunk_type TEXT NOT NULL,
          chunk_name TEXT,
          start_line INTEGER,
          end_line INTEGER,
          description TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      // 创建索引（幂等）
      await this.client.query(`
        CREATE INDEX IF NOT EXISTS idx_kb_file_path ON kb_chunks(file_path);
        CREATE INDEX IF NOT EXISTS idx_kb_chunk_type ON kb_chunks(chunk_type);
      `);

      // HNSW 索引（向量检索核心）
      try {
        await this.client.query(`
          CREATE INDEX IF NOT EXISTS idx_kb_embedding_hnsw
          ON kb_chunks USING hnsw (embedding vector_cosine_ops)
          WITH (m = 16, ef_construction = 200);
        `);
      } catch {
        // 维度变更时可能需要重建
      }

      // Trigram 索引（关键词检索）
      try {
        await this.client.query(`
          CREATE INDEX IF NOT EXISTS idx_kb_content_trgm
          ON kb_chunks USING gin (content gin_trgm_ops);
        `);
      } catch {
        // pg_trgm 未启用时静默跳过
      }

      this.loaded = true;
    } catch (e: any) {
      throw new Error(`PostgreSQL 初始化失败: ${e.message}。请安装依赖: pnpm add pg，并确保 PostgreSQL 已安装 pgvector 和 pg_trgm 扩展`);
    }
  }

  private async getClient(): Promise<PgClient> {
    if (!this.client) await this.init();
    return this.client!;
  }

  async insert(chunk: Chunk): Promise<void> {
    this.embeddingDim = chunk.embedding.length;
    const client = await this.getClient();
    const vecStr = `[${chunk.embedding.join(',')}]`;

    // 使用 INSERT ... ON CONFLICT 实现 upsert
    await client.query(`
      INSERT INTO kb_chunks (id, content, embedding, file_path, chunk_type, chunk_name, start_line, end_line, description)
      VALUES ($1, $2, $3::vector, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (id) DO UPDATE SET
        content = EXCLUDED.content,
        embedding = EXCLUDED.embedding,
        start_line = EXCLUDED.start_line,
        end_line = EXCLUDED.end_line,
        description = EXCLUDED.description,
        created_at = NOW()
    `, [
      chunk.id, chunk.content, vecStr,
      chunk.metadata.filePath, chunk.metadata.type,
      chunk.metadata.name || null,
      chunk.metadata.startLine || null,
      chunk.metadata.endLine || null,
      chunk.metadata.description || null,
    ]);
  }

  async insertBatch(chunks: Chunk[]): Promise<void> {
    const client = await this.getClient();
    // 事务批量插入
    await client.query('BEGIN');
    try {
      for (const c of chunks) {
        await this.insert(c);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  }

  async search(query: { embedding: number[]; topK?: number }): Promise<SearchResult[]> {
    const client = await this.getClient();
    const topK = query.topK ?? 5;
    const vecStr = `[${query.embedding.join(',')}]`;

    // 使用 pgvector 的余弦距离算子 <=>
    const result = await client.query(`
      SELECT id, content, file_path, chunk_type, chunk_name, start_line, end_line, description, created_at,
             1 - (embedding <=> $1::vector) AS score
      FROM kb_chunks
      ORDER BY embedding <=> $1::vector
      LIMIT $2
    `, [vecStr, topK]);

    return result.rows.map(r => ({
      chunk: this.rowToChunk(r),
      score: r.score,
    }));
  }

  async hybridSearch(query: { embedding: number[]; text: string; topK?: number }): Promise<SearchResult[]> {
    const client = await this.getClient();
    const topK = query.topK ?? 5;
    const vecStr = `[${query.embedding.join(',')}]`;

    // 参考 shards 的 RRF（Reciprocal Rank Fusion）混合检索
    // 向量搜索 + trigram 关键词搜索，用 RRF 分数融合
    const result = await client.query(`
      WITH vector_search AS (
        SELECT id, content, file_path, chunk_type, chunk_name, start_line, end_line, description, created_at,
               1 - (embedding <=> $1::vector) AS vec_score,
               ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS vec_rank
        FROM kb_chunks
        WHERE 1 - (embedding <=> $1::vector) > 0.3
        LIMIT 50
      ),
      keyword_search AS (
        SELECT id, content, file_path, chunk_type, chunk_name, start_line, end_line, description, created_at,
               similarity(content, $2) AS kw_score,
               ROW_NUMBER() OVER (ORDER BY similarity(content, $2) DESC) AS kw_rank
        FROM kb_chunks
        WHERE content % $2
        LIMIT 50
      )
      SELECT COALESCE(v.id, k.id) AS id,
             COALESCE(v.content, k.content) AS content,
             COALESCE(v.file_path, k.file_path) AS file_path,
             COALESCE(v.chunk_type, k.chunk_type) AS chunk_type,
             COALESCE(v.chunk_name, k.chunk_name) AS chunk_name,
             COALESCE(v.start_line, k.start_line) AS start_line,
             COALESCE(v.end_line, k.end_line) AS end_line,
             COALESCE(v.description, k.description) AS description,
             COALESCE(v.created_at, k.created_at) AS created_at,
             (COALESCE(1.0 / (60 + v.vec_rank), 0.0) + COALESCE(1.0 / (60 + k.kw_rank), 0.0)) AS rrf_score
      FROM vector_search v
      FULL OUTER JOIN keyword_search k ON v.id = k.id
      ORDER BY rrf_score DESC
      LIMIT $3
    `, [vecStr, query.text, topK]);

    return result.rows.map(r => ({
      chunk: this.rowToChunk(r),
      score: r.rrf_score,
    }));
  }

  async delete(filter: { filePath?: string; type?: string }): Promise<number> {
    const client = await this.getClient();
    const conditions: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (filter.filePath) {
      conditions.push(`file_path = $${idx++}`);
      params.push(filter.filePath);
    }
    if (filter.type) {
      conditions.push(`chunk_type = $${idx++}`);
      params.push(filter.type);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await client.query(`DELETE FROM kb_chunks ${where}`, params);
    return result.rowCount || 0;
  }

  async clear(): Promise<void> {
    const client = await this.getClient();
    await client.query('TRUNCATE kb_chunks');
  }

  async stats(): Promise<{ totalChunks: number; storeType: string; embeddingDim: number; files: string[]; lastUpdated: string }> {
    const client = await this.getClient();

    const countResult = await client.query('SELECT COUNT(*)::int AS cnt FROM kb_chunks');
    const count = countResult.rows[0].cnt;

    const fileResult = await client.query('SELECT DISTINCT file_path FROM kb_chunks ORDER BY file_path');
    const files = fileResult.rows.map((r: any) => r.file_path);

    const lastResult = await client.query('SELECT created_at FROM kb_chunks ORDER BY created_at DESC LIMIT 1');

    // 获取 embedding 维度
    try {
      const dimResult = await client.query("SELECT vector_dims(embedding) AS dim FROM kb_chunks LIMIT 1");
      this.embeddingDim = dimResult.rows[0]?.dim || this.embeddingDim;
    } catch {
      // 空表时忽略
    }

    return {
      totalChunks: count,
      storeType: 'postgres',
      embeddingDim: this.embeddingDim,
      files,
      lastUpdated: lastResult.rows[0]?.created_at || 'never',
    };
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.end();
      this.client = null;
    }
  }

  private rowToChunk(row: any): Chunk {
    // 从 PG 返回的 vector 是类似 [0.1,0.2,...] 的字符串
    let embedding: number[];
    if (typeof row.embedding === 'string') {
      embedding = JSON.parse(row.embedding);
    } else if (row.embedding) {
      embedding = Array.from(row.embedding);
    } else {
      embedding = [];
    }

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


