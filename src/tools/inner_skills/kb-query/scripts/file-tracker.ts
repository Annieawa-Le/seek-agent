/**
 * FileTracker — 文件变更追踪
 *
 * 记录每个已索引文件的 mtime + size，在下一次构建时比较，
 * 只处理新增、修改、删除的文件，实现增量索引。
 *
 * 状态文件存储在 .seek-agent/kb-file-state.json
 */

import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { getWorkspaceRoot } from '../../../../workdir';

export interface FileRecord {
  mtimeMs: number;
  size: number;
}

export interface FileChanges {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: string[];
}

export class FileTracker {
  private stateFile: string;
  private state: Record<string, FileRecord> = {};
  private loaded = false;

  constructor() {
    const root = getWorkspaceRoot();
    this.stateFile = path.join(root, '.seek-agent', 'kb-file-state.json');
  }

  /** 从磁盘加载状态 */
  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.stateFile, 'utf-8');
      this.state = JSON.parse(raw);
    } catch {
      this.state = {};
    }
    this.loaded = true;
  }

  /** 保存状态到磁盘 */
  async save(): Promise<void> {
    await writeFile(this.stateFile, JSON.stringify(this.state, null, 2), 'utf-8');
  }

  /** 给定当前扫描到的文件列表，返回变更分类 */
  async getChanges(currentFiles: string[]): Promise<FileChanges> {
    await this.load();

    const currentSet = new Set(currentFiles);
    const previousSet = new Set(Object.keys(this.state));

    const deleted = [...previousSet].filter(f => !currentSet.has(f));

    const added: string[] = [];
    const modified: string[] = [];
    const unchanged: string[] = [];

    for (const file of currentFiles) {
      const prev = this.state[file];
      if (!prev) {
        added.push(file);
        continue;
      }
      // 检查文件是否有变更
      try {
        const s = await stat(file);
        if (s.mtimeMs !== prev.mtimeMs || s.size !== prev.size) {
          modified.push(file);
        } else {
          unchanged.push(file);
        }
      } catch {
        // 文件不可读，视为新增以重新索引
        added.push(file);
      }
    }

    return { added, modified, deleted, unchanged };
  }

  /** 更新状态中指定文件的记录 */
  async updateRecords(filePaths: string[]): Promise<void> {
    for (const file of filePaths) {
      try {
        const s = await stat(file);
        this.state[file] = { mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        delete this.state[file];
      }
    }
  }

  /** 删除状态中的记录 */
  removeRecords(filePaths: string[]): void {
    for (const file of filePaths) {
      delete this.state[file];
    }
  }
}
