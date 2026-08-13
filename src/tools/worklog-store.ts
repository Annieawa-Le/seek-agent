/**
 * worklog-store.ts — Worklog 归档存储（记忆消退路径的"归档"层）
 *
 * 消退路径：活跃消息 → [Worklog] 梗概 → 归档行（worklog_recall 取梗概 / work_recall 取原文）
 *
 * 存储：按 sessionId 分区，落盘到 {workspace}/sessions/{sessionId}/worklog/entries.json。
 * 被压缩轮次的原始消息完整保留于此，不作为活跃消息，但可随时召回。
 *
 * 兼容：旧结构 {workspace}/sessions/worklogs/{sessionId}.json 首次加载时自动迁移到新位置。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getSessionsRoot } from '../workdir';

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

/** sessionId → 安全文件/文件夹名（非法字符替换为下划线） */
function safeName(id: string): string {
  return (id || 'default').replace(/[\\/:*?"<>|]/g, '_');
}

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

  /** 新结构路径：sessions/{sessionId}/worklog/entries.json */
  private get filePath(): string {
    return path.join(getSessionsRoot(), 'sessions', safeName(this.sessionId), 'worklog', 'entries.json');
  }

  /** 旧结构路径：sessions/worklogs/{sessionId}.json（迁移用） */
  private get legacyFilePath(): string {
    return path.join(getSessionsRoot(), 'sessions', 'worklogs', `${safeName(this.sessionId)}.json`);
  }

  private load(): void {
    this.entries = new Map();
    try {
      let raw: string | null = null;
      if (fs.existsSync(this.filePath)) {
        raw = fs.readFileSync(this.filePath, 'utf-8');
      } else if (fs.existsSync(this.legacyFilePath)) {
        // 旧结构：读取后迁移到新位置（写新 + 删旧），一次性完成
        raw = fs.readFileSync(this.legacyFilePath, 'utf-8');
        try {
          const parsed = JSON.parse(raw) as { entries?: WorklogEntry[] };
          this.loadEntries(parsed);
          this.persist();
          fs.unlinkSync(this.legacyFilePath);
          raw = null; // 已通过 loadEntries 加载，避免重复
        } catch { /* 迁移失败则按常规流程读旧文件（下方兜底） */ }
      }
      if (raw !== null) {
        this.loadEntries(JSON.parse(raw) as { entries?: WorklogEntry[] });
      }
    } catch {
      // 归档文件损坏时从空开始，不影响主流程
    }
  }

  private loadEntries(data: { entries?: WorklogEntry[] }): void {
    for (const e of data.entries ?? []) {
      if (e?.id) this.entries.set(e.id, e);
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


