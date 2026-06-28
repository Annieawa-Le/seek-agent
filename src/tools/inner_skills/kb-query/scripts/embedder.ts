/**
 * Embedder — OpenAI 兼容格式的 embedding API 封装
 *
 * 兼容: Ollama / DeepSeek / OpenAI / 阿里通义 / 任意 OpenAI 兼容接口
 *
 * 环境变量:
 *   EMBEDDING_BASE_URL  — API 地址（默认 http://localhost:11434/v1）
 *   EMBEDDING_API_KEY   — API Key（Ollama 本地可填 "ollama"）
 *   EMBEDDING_MODEL     — 模型名（默认 nomic-embed-text）
 *   EMBEDDING_DIM       — 向量维度（可选，指定后可跳过自动探测）
 *   EMBEDDING_BATCH_SIZE — 批大小（默认 10）
 */

interface EmbeddingResponse {
  data: { embedding: number[]; index: number }[];
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
}

export class Embedder {
  private baseUrl: string;
  private apiKey: string;
  public model: string;
  private batchSize: number;

  constructor() {
    this.baseUrl = (process.env.EMBEDDING_BASE_URL || 'http://localhost:11434/v1').replace(/\/+$/, '');
    this.apiKey = process.env.EMBEDDING_API_KEY || 'ollama';
    this.model = process.env.EMBEDDING_MODEL || 'nomic-embed-text';
    this.batchSize = parseInt(process.env.EMBEDDING_BATCH_SIZE || '10', 10);
  }

  /**
   * 将文本转为 embedding 向量
   */
  async embed(text: string): Promise<number[]> {
    if (!text || text.trim().length === 0) {
      return new Array(await this.getDim()).fill(0);
    }
    const results = await this.embedBatch([text]);
    return results[0];
  }

  /**
   * 批量将文本转为 embedding 向量
   * 自动分批，避免 API 超长
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const batchResults = await this.callApi(batch);
      results.push(...batchResults);
    }

    return results;
  }

  private async callApi(texts: string[]): Promise<number[][]> {
    const url = `${this.baseUrl}/embeddings`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'User-Agent': 'seek-agent-kb-query/1.0',
      },
      body: JSON.stringify({
        input: texts,
        model: this.model,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Embedding API 错误 [${response.status}]: ${body}`);
    }

    const data: EmbeddingResponse = await response.json();

    return data.data
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding);
  }

  /**
   * 获取向量维度
   * 优先使用 EMBEDDING_DIM 环境变量（免探测），否则调用 API 探测
   */
  async getDim(): Promise<number> {
    const explicitDim = process.env.EMBEDDING_DIM;
    if (explicitDim) {
      const d = parseInt(explicitDim, 10);
      if (!isNaN(d) && d > 0) return d;
    }
    const vec = await this.embed('test');
    return vec.length;
  }
}

/** 全局单例 */
export const embedder = new Embedder();

