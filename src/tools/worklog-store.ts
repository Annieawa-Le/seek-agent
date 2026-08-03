/**
 * worklog-store.ts — Worklog 归档存储（记忆消退路径的"归档"层）
 *
 * 消退路径：活跃消息 → [Worklog] 梗概 → 归档行（worklog_recall 取梗概 / work_recall 取原文）
 *
 * 存储：按 sessionId 分区，落盘到 {workspace}/sessions/worklogs/{sessionId}.json。
 * 被压缩轮次的原始消息完整保留于此，不作为活跃消息，但可随时召回。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getWorkspaceRoot } from '../workdir';

export interface WorklogEntry {
  /** 归档 id，形如 W12 */
  id: string;
  /** 标题（≤20 字，人类可读） */
  title: string;
  /** 结构化梗概（压缩产物，供 worklog_recall 召回） */
  summary: string;
  /** 被压缩轮次的原始消息（完整保留，供 work_recall 召回原文） */
  archivedMessages: unknown[];
  createdAt: string;
}

const WORKLOGS_SUBDIR = 'sessions/worklogs';

class WorklogStore {
  private sessionId = '';
  /** sessionId -> entries（内存态，加载自磁盘文件） */
  private entries = new Map<string, WorklogEntry>();

  /** agent 启动/切换会话时调用，切换后自动从磁盘加载对应归档 */
  setSessionId(id: string): void {
    if (id !== this.sessionId) {
      this.sessionId = id;
      this.load();
    }
  }

  getSessionId(): string {
    return this.sessionId;
  }

  private get filePath(): string {
    const safe = (this.sessionId || 'default').replace(/[\\/:*?"<>|]/g, '_');
    return path.join(getWorkspaceRoot(), WORKLOGS_SUBDIR, `${safe}.json`);
  }

  private load(): void {
    this.entries = new Map();
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as { entries?: WorklogEntry[] };
        for (const e of raw.entries ?? []) {
          if (e?.id) this.entries.set(e.id, e);
        }
      }
    } catch {
      // 归档文件损坏时从空开始，不影响主流程
    }
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        this.filePath,
        JSON.stringify({ sessionId: this.sessionId, entries: [...this.entries.values()] }, null, 2),
        'utf-8',
      );
    } catch {
      // 落盘失败不影响主流程（内存态仍可用）
    }
  }

  /** 分配下一个自增 id（基于现有最大编号） */
  nextId(): string {
    let max = 0;
    for (const id of this.entries.keys()) {
      const n = parseInt(id.replace(/^W/, ''), 10);
      if (!Number.isNaN(n) && n > max) max = n;
    }
    return `W${max + 1}`;
  }

  add(entry: WorklogEntry): void {
    this.entries.set(entry.id, entry);
    this.persist();
  }

  get(id: string): WorklogEntry | undefined {
    return this.entries.get(id);
  }

  /** 按标题关键词模糊查找 */
  findByTitle(keyword: string): WorklogEntry | undefined {
    return this.list().find((e) => e.title.includes(keyword));
  }

  list(): WorklogEntry[] {
    return [...this.entries.values()].sort((a, b) =>
      a.id.localeCompare(b.id, undefined, { numeric: true }),
    );
  }

  clear(): void {
    this.entries = new Map();
    this.persist();
  }
}

/** 全局单例（Electron 每会话一个 agent 进程，进程内单例安全） */
export const worklogStore = new WorklogStore();
