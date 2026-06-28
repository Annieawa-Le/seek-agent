/**
 * JsonFileVectorStore — 纯 JSON 文件 + 内存向量搜索
 *
 * 零依赖，适合小规模（<10000 chunks）知识库。
 * 数据存储在 .seek-agent/kb/ 目录下。
 */

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { cosineSimilarity } from '../cosine';
import type { Chunk, SearchResult, VectorStore } from './interface';

const KB_DIR = '.seek-agent/kb';
const CHUNKS_FILE = 'chunks.json';
const META_FILE = 'meta.json';

interface Meta {
  embeddingDim: number;
  totalChunks: number;
  lastUpdated: string;
  files: string[];
}

export class JsonFileVectorStore implements VectorStore {
  private chunks: Chunk[] = [];
  private meta: Meta = { embeddingDim: 0, totalChunks: 0, lastUpdated: '', files: [] };
  private kbPath: string;
  private loaded = false;

  constructor(basePath?: string) {
    this.kbPath = basePath ? path.join(basePath, KB_DIR) : path.resolve(KB_DIR);
  }

  async init(dim?: number): Promise<void> {
    if (dim) this.meta.embeddingDim = dim;
    await mkdir(this.kbPath, { recursive: true });
    await this.loadFromDisk();
  }

  private async loadFromDisk(): Promise<void> {
    const chunksPath = path.join(this.kbPath, CHUNKS_FILE);
    const metaPath = path.join(this.kbPath, META_FILE);

    try {
      if (existsSync(chunksPath)) {
        const data = await readFile(chunksPath, 'utf-8');
        this.chunks = JSON.parse(data);
      }
      if (existsSync(metaPath)) {
        const data = await readFile(metaPath, 'utf-8');
        this.meta = JSON.parse(data);
      }
    } catch {
      this.chunks = [];
      this.meta = { embeddingDim: 0, totalChunks: 0, lastUpdated: '', files: [] };
    }
    this.loaded = true;
  }

  private async saveToDisk(): Promise<void> {
    const chunksPath = path.join(this.kbPath, CHUNKS_FILE);
    const metaPath = path.join(this.kbPath, META_FILE);

    this.meta.totalChunks = this.chunks.length;
    this.meta.lastUpdated = new Date().toISOString();

    await writeFile(chunksPath, JSON.stringify(this.chunks, null, 1), 'utf-8');
    await writeFile(metaPath, JSON.stringify(this.meta, null, 2), 'utf-8');
  }

  async insert(chunk: Chunk): Promise<void> {
    if (!this.loaded) await this.loadFromDisk();
    // 去重：同文件同名同范围的不重复插入
    const dup = this.chunks.find(
      c => c.id === chunk.id || (
        c.metadata.filePath === chunk.metadata.filePath &&
        c.metadata.name === chunk.metadata.name &&
        c.metadata.type === chunk.metadata.type
      )
    );
    if (dup) {
      // 覆盖
      Object.assign(dup, chunk);
    } else {
      this.chunks.push(chunk);
    }
  }

  async insertBatch(chunks: Chunk[]): Promise<void> {
    for (const c of chunks) {
      await this.insert(c);
    }
    await this.saveToDisk();
  }

  async search(query: { embedding: number[]; topK?: number }): Promise<SearchResult[]> {
    if (!this.loaded) await this.loadFromDisk();
    const topK = query.topK ?? 5;

    const scored = this.chunks
      .map(c => ({ chunk: c, score: cosineSimilarity(query.embedding, c.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return scored;
  }

  async hybridSearch(query: { embedding: number[]; text: string; topK?: number }): Promise<SearchResult[]> {
    if (!this.loaded) await this.loadFromDisk();
    const topK = query.topK ?? 5;

    // 关键词匹配：简单分词后计算文本重合度
    const keywords = query.text.toLowerCase().split(/[\s,.;:!?()\[\]{}"'/\\<>《》【】]+/).filter(Boolean);
    const uniqueKeys = [...new Set(keywords)];

    const scored = this.chunks.map(c => {
      const vecScore = cosineSimilarity(query.embedding, c.embedding);
      // 文本关键词匹配：命中关键词比例
      const lowerContent = c.content.toLowerCase();
      const hits = uniqueKeys.filter(k => lowerContent.includes(k)).length;
      const keywordScore = uniqueKeys.length > 0 ? hits / uniqueKeys.length : 0;

      // RRF 融合：vec 权重 0.7，keyword 权重 0.3
      const combined = vecScore * 0.7 + keywordScore * 0.3;
      return { chunk: c, score: combined };
    });

    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  async delete(filter: { filePath?: string; type?: string }): Promise<number> {
    if (!this.loaded) await this.loadFromDisk();
    const before = this.chunks.length;
    this.chunks = this.chunks.filter(c => {
      if (filter.filePath && c.metadata.filePath !== filter.filePath) return true;
      if (filter.type && c.metadata.type !== filter.type) return true;
      return false;
    });
    const deleted = before - this.chunks.length;
    if (deleted > 0) await this.saveToDisk();
    return deleted;
  }

  async clear(): Promise<void> {
    this.chunks = [];
    this.meta = { embeddingDim: 0, totalChunks: 0, lastUpdated: '', files: [] };
    await this.saveToDisk();

    // 清理目录中残留文件
    try {
      const files = await readdir(this.kbPath);
      for (const f of files) {
        await unlink(path.join(this.kbPath, f));
      }
    } catch {
      // ignore
    }
  }

  async stats(): Promise<{ totalChunks: number; storeType: string; embeddingDim: number; files: string[]; lastUpdated: string }> {
    if (!this.loaded) await this.loadFromDisk();
    // 统计涉及的源文件
    const files = [...new Set(this.chunks.map(c => c.metadata.filePath))].sort();
    return {
      totalChunks: this.chunks.length,
      storeType: 'json-file',
      embeddingDim: this.meta.embeddingDim,
      files,
      lastUpdated: this.meta.lastUpdated || 'never',
    };
  }
}


