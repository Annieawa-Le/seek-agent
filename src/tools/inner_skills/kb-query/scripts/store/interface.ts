/**
 * VectorStore — 向量存储统一接口
 *
 * 所有后端（JSON File / SQLite / PostgreSQL）都实现此接口，
 * 上层代码无需关心具体存储实现。
 */

export interface Chunk {
  id: string;
  content: string;
  embedding: number[];
  metadata: {
    filePath: string;
    type: 'file' | 'function' | 'class' | 'doc';
    name?: string;
    startLine?: number;
    endLine?: number;
    description?: string;
  };
}

export interface SearchResult {
  chunk: Chunk;
  score: number; // 相似度分数（0-1，越高越相似）
}

export interface VectorStore {
  /** 初始化存储（建表/建文件等）。dim 为向量维度，不传则从首条数据自动推断。 */
  init(dim?: number): Promise<void>;

  /** 插入单个 chunk */
  insert(chunk: Chunk): Promise<void>;

  /** 批量插入 chunks */
  insertBatch(chunks: Chunk[]): Promise<void>;

  /** 向量相似搜索 */
  search(query: {
    embedding: number[];
    topK?: number;
  }): Promise<SearchResult[]>;

  /** 混合搜索（向量 + 关键词）*/
  hybridSearch(query: {
    embedding: number[];
    text: string;
    topK?: number;
  }): Promise<SearchResult[]>;

  /** 按 metadata 过滤删除 */
  delete(filter: { filePath?: string; type?: string }): Promise<number>;

  /** 清空所有数据 */
  clear(): Promise<void>;

  /** 获取统计信息 */
  stats(): Promise<{
    totalChunks: number;
    storeType: string;
    embeddingDim: number;
    files: string[];
    lastUpdated: string;
  }>;
}

