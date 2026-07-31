/**
 * memory-core.ts — 对话记忆核心存储层
 *
 * 借鉴 shards 的双层记忆架构，针对编程助手场景裁剪：
 *   - 工作记忆（working）：当前对话焦点 / 进行中的任务状态，加权淘汰
 *     每条记忆带 weight（权重，决定存活期）与 lastAccess（最近访问时间），
 *     淘汰公式 score = (now - lastAccess) / weight，权重越低越久没碰的越先被踢。
 *   - 长期记忆（long-term）：跨会话的持久知识（规则 / 决策 / 事实），
 *     向量 + 关键词混合检索，写入前做向量去重。
 *
 * 持久化到工作区 .seek-agent/memory/*.json，同步读写，变更即时落盘。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getWorkspaceRoot } from '../workdir';
import { embedder } from './inner_skills/kb-query/scripts/embedder';
import { cosineSimilarity } from './inner_skills/kb-query/scripts/cosine';

// ═════════════════════════════════════════════════════
// 类型定义
// ═════════════════════════════════════════════════════

export interface WorkingMemoryItem {
  id: number;
  content: string;
  weight: number;
  lastAccess: number;
}

export interface LongTermMemoryItem {
  id: number;
  content: string;
  embedding: number[];
  createdAt: number;
  source?: string;
}

export interface MemoryRecallResult {
  content: string;
  score: number;
  createdAt: number;
  source?: string;
}

export interface RememberOutcome {
  added: boolean;
  reason: string;
  item?: LongTermMemoryItem;
}

// ═════════════════════════════════════════════════════
// 路径与工具函数
// ═════════════════════════════════════════════════════

function memoryDir(): string {
  return path.join(getWorkspaceRoot(), '.seek-agent', 'memory');
}

function workingFile(): string {
  return path.join(memoryDir(), 'working.json');
}

function longTermFile(): string {
  return path.join(memoryDir(), 'long-term.json');
}

function ensureDir(): void {
  fs.mkdirSync(memoryDir(), { recursive: true });
}

function safeWeight(weight: number): number {
  return weight <= 0 ? 0.0001 : weight;
}

/** 简单分词：英文单词（含数字下划线）+ 中文单字，去重 */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens = lower.match(/[a-z0-9_]+|[\u4e00-\u9fa5]/g) || [];
  return [...new Set(tokens)].filter((t) => t.length > 1 || /[\u4e00-\u9fa5]/.test(t));
}

// ═════════════════════════════════════════════════════
// 工作记忆（短期）— WeightedLRU 淘汰
// ═════════════════════════════════════════════════════

export class WorkingMemoryStore {
  private items = new Map<number, WorkingMemoryItem>();
  private nextId = 1;
  readonly capacity = 30;

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(workingFile(), 'utf-8');
      const data = JSON.parse(raw);
      if (Array.isArray(data.items)) {
        for (const it of data.items) {
          if (it && typeof it.id === 'number' && typeof it.content === 'string') {
            this.items.set(it.id, {
              id: it.id,
              content: it.content,
              weight: safeWeight(it.weight ?? 1),
              lastAccess: it.lastAccess ?? Date.now(),
            });
          }
        }
      }
      this.nextId = data.nextId && data.nextId > 0
        ? data.nextId
        : (this.items.size > 0 ? Math.max(...this.items.keys()) + 1 : 1);
    } catch {
      // 首次运行或文件损坏：以空记忆启动
    }
  }

  private save(): void {
    ensureDir();
    fs.writeFileSync(
      workingFile(),
      JSON.stringify({ nextId: this.nextId, items: [...this.items.values()] }, null, 2),
      'utf-8',
    );
  }

  list(): WorkingMemoryItem[] {
    return [...this.items.values()].sort((a, b) => b.lastAccess - a.lastAccess);
  }

  get(id: number): WorkingMemoryItem | undefined {
    return this.items.get(id);
  }

  add(content: string, weight: number): WorkingMemoryItem {
    const item: WorkingMemoryItem = {
      id: this.nextId++,
      content,
      weight: safeWeight(weight),
      lastAccess: Date.now(),
    };
    this.items.set(item.id, item);
    this.evict();
    this.save();
    return item;
  }

  update(id: number, content?: string, weight?: number): boolean {
    const it = this.items.get(id);
    if (!it) return false;
    if (content !== undefined && content !== null) it.content = content;
    if (weight !== undefined && weight !== null) it.weight = safeWeight(weight);
    it.lastAccess = Date.now();
    this.save();
    return true;
  }

  touch(id: number): boolean {
    const it = this.items.get(id);
    if (!it) return false;
    it.lastAccess = Date.now();
    this.save();
    return true;
  }

  remove(id: number): boolean {
    const ok = this.items.delete(id);
    if (ok) this.save();
    return ok;
  }

  clear(): void {
    this.items.clear();
    this.nextId = 1;
    this.save();
  }

  get size(): number {
    return this.items.size;
  }

  /** WeightedLRU 淘汰：score = (now - lastAccess) / weight，淘汰 score 最大者 */
  private evict(): void {
    if (this.items.size <= this.capacity) return;
    const now = Date.now();
    let maxScore = -1;
    let toEvict: number | null = null;
    for (const [id, it] of this.items) {
      const score = (now - it.lastAccess) / it.weight;
      if (score > maxScore) {
        maxScore = score;
        toEvict = id;
      }
    }
    if (toEvict !== null) this.items.delete(toEvict);
  }
}

// ═════════════════════════════════════════════════════
// 长期记忆（持久知识）— 向量 + 关键词混合检索
// ═════════════════════════════════════════════════════

export class LongTermMemoryStore {
  private items: LongTermMemoryItem[] = [];
  private nextId = 1;

  /** 去重相似度阈值：超过则视为重复，跳过写入 */
  readonly duplicateThreshold = 0.94;

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(longTermFile(), 'utf-8');
      const data = JSON.parse(raw);
      if (Array.isArray(data.items)) {
        this.items = data.items.filter(
          (it: any) => it && typeof it.id === 'number' && typeof it.content === 'string',
        );
      }
      this.nextId = data.nextId && data.nextId > 0
        ? data.nextId
        : (this.items.length > 0 ? Math.max(...this.items.map((i) => i.id)) + 1 : 1);
    } catch {
      // 首次运行或文件损坏：以空记忆启动
    }
  }

  private save(): void {
    ensureDir();
    fs.writeFileSync(
      longTermFile(),
      JSON.stringify({ nextId: this.nextId, items: this.items }, null, 2),
      'utf-8',
    );
  }

  get count(): number {
    return this.items.length;
  }

  list(): Omit<LongTermMemoryItem, 'embedding'>[] {
    return this.items
      .map(({ embedding: _e, ...rest }) => rest)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 写入一条长期记忆：向量化 → 与现有记忆比较相似度 → 重复则跳过。
   * embedding 不可用时抛错（由工具层提示配置）。
   */
  async remember(content: string, source?: string): Promise<RememberOutcome> {
    const vec = await embedder.embed(content);

    let bestSim = 0;
    for (const it of this.items) {
      const sim = cosineSimilarity(vec, it.embedding);
      if (sim > bestSim) bestSim = sim;
    }
    if (bestSim >= this.duplicateThreshold) {
      return { added: false, reason: `与已有记忆重复（相似度 ${bestSim.toFixed(3)}），已跳过` };
    }

    const item: LongTermMemoryItem = {
      id: this.nextId++,
      content,
      embedding: vec,
      createdAt: Date.now(),
      source,
    };
    this.items.push(item);
    this.save();
    return { added: true, reason: '', item };
  }

  /**
   * 混合检索：向量相似度（0.7）+ 关键词命中率（0.3）。
   * embedding 不可用时自动降级为纯关键词检索。
   */
  async recall(query: string, topK = 5): Promise<MemoryRecallResult[]> {
    let queryVec: number[] | null = null;
    try {
      queryVec = await embedder.embed(query);
    } catch {
      queryVec = null;
    }

    const tokens = tokenize(query);
    const scored = this.items.map((it) => {
      const vecSim = queryVec ? cosineSimilarity(queryVec, it.embedding) : 0;
      const kwScore = tokens.length > 0
        ? tokens.filter((t) => it.content.toLowerCase().includes(t)).length / tokens.length
        : 0;
      const score = queryVec ? 0.7 * vecSim + 0.3 * kwScore : kwScore;
      return {
        content: it.content,
        score,
        createdAt: it.createdAt,
        source: it.source,
      };
    });

    return scored
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  remove(id: number): boolean {
    const idx = this.items.findIndex((it) => it.id === id);
    if (idx === -1) return false;
    this.items.splice(idx, 1);
    this.save();
    return true;
  }

  clear(): void {
    this.items = [];
    this.nextId = 1;
    this.save();
  }
}

// ── 模块级单例 ──
export const workingMemory = new WorkingMemoryStore();
export const longTermMemory = new LongTermMemoryStore();
