/**
 * patch-batch.ts — 并行 patch 静默暂存管理器
 *
 * 场景：同一条 assistant 消息里出现对同一文件的多个 patch 工具调用
 * （add_patch / del_patch）。这些调用都是基于同一份文件
 *
 * 机制（全自动，无需 ensure_patch）：
 *   1. agent 层在 executeToolCalls 开始时检测：同批 ≥2 个 patch 作用于
 *      同一文件 → beginBatch()，记录基准快照
 *   2. patch 工具执行时发现该文件处于批次模式 → 只定位 + stage 入暂存，
 *      不写盘，返回"已暂存"消息
 *   3. 批次 flush 时基于基准快照，按基准行号从后往前统一应用 →
 *      一次写盘 + 一条 undo 记录（undo_patch 可整体回滚该批次）
 *   4. 中断/中止时 discardAll() 放弃暂存，文件保持原状
 *
 * 串行调用（不同 assistant 消息里的单个 patch）不经过本机制，直接写盘。
 */

import fs from 'fs/promises';
import path from 'path';
import { checkSyntax, formatSyntaxErrors } from './syntax-validator.js';
import { undoStack } from './patch-undo.js';

/** 参与并行批次合并的 patch 工具名 */
export const PATCH_TOOL_NAMES = new Set(['add_patch', 'del_patch']);

/** 已解析定位的暂存条目（行号基于基准快照） */
export interface StagedPatch {
  type: 'add' | 'del';
  /** add: 插入位置（0-based 数组索引；-1 表示末尾追加） */
  insertIndex?: number;
  /** del: 1-based 闭区间列表（已合并去重） */
  ranges?: [number, number][];
  /** add: 插入行 */
  lines?: string[];
  description: string;
}

export interface PatchBatch {
  filePath: string;
  baseLines: string[];
  hasTrailingNewline: boolean;
  lineEnding: '\n' | '\r\n';
  entries: StagedPatch[];
}

export interface BatchFlushResult {
  filePath: string;
  ok: boolean;
  message: string;
  fromLines?: number;
  toLines?: number;
  diff?: string;
}

/**
 * 基准行号：值越大表示位置越靠后。
 * add 的 0-based 数组索引与 del/modify 的 1-based 行号在排序上语义一致
 * （add 第 10 行后 → 索引 10；del 第 11 行 → 行号 11）。
 */
function rankOf(entry: StagedPatch): number {
  switch (entry.type) {
    case 'add': return entry.insertIndex === -1 ? Number.MAX_SAFE_INTEGER : entry.insertIndex!;
    case 'del': return Math.min(...entry.ranges!.map(([s]) => s));
  }
}

class PatchBatchManager {
  private batches = new Map<string, PatchBatch>();

  private norm(p: string): string {
    return path.resolve(p).replace(/\\/g, '/');
  }

  isBatching(filePath: string): boolean {
    return this.batches.has(this.norm(filePath));
  }

  getBatch(filePath: string): PatchBatch | undefined {
    return this.batches.get(this.norm(filePath));
  }

  /** 建立批次；若已存在则直接返回现有批次 */
  beginBatch(
    filePath: string,
    baseLines: string[],
    hasTrailingNewline: boolean,
    lineEnding: '\n' | '\r\n',
  ): PatchBatch {
    const key = this.norm(filePath);
    const existing = this.batches.get(key);
    if (existing) return existing;
    const batch: PatchBatch = { filePath, baseLines, hasTrailingNewline, lineEnding, entries: [] };
    this.batches.set(key, batch);
    return batch;
  }

  /** 入暂存，返回当前批次内条目序号（从 1 开始） */
  stage(filePath: string, entry: StagedPatch): number {
    const key = this.norm(filePath);
    const batch = this.batches.get(key);
    if (!batch) throw new Error(`文件不在批次模式：${filePath}`);
    batch.entries.push(entry);
    return batch.entries.length;
  }

  get activeCount(): number {
    return this.batches.size;
  }

  /** 放弃所有批次（中断/中止时调用），不做任何写盘 */
  discardAll(): void {
    this.batches.clear();
  }

  /** 应用所有批次（从后往前），返回每个文件的结果 */
  async flushAll(): Promise<BatchFlushResult[]> {
    const results: BatchFlushResult[] = [];
    for (const batch of this.batches.values()) {
      results.push(await this.flushOne(batch));
    }
    this.batches.clear();
    return results;
  }

  private async flushOne(batch: PatchBatch): Promise<BatchFlushResult> {
    const { filePath, baseLines, hasTrailingNewline, lineEnding, entries } = batch;
    // 从后往前：基准行号大的先应用，保证前面坐标不受后续操作影响
    const sorted = [...entries].sort((a, b) => rankOf(b) - rankOf(a));
    let current = [...baseLines];

    for (const entry of sorted) {
      try {
        if (entry.type === 'add') {
          const idx = entry.insertIndex === -1 ? current.length : entry.insertIndex!;
          if (idx < 0 || idx > current.length) throw new Error(`插入位置 ${idx} 超出范围`);
          current = [...current.slice(0, idx), ...entry.lines!, ...current.slice(idx)];
        } else if (entry.type === 'del') {
          // 内部区间升序 → 0-based → 降序（先删后面的）
          const zeroBased = [...entry.ranges!]
            .sort((a, b) => a[0] - b[0])
            .map(([s, e]) => [s - 1, e - 1] as [number, number])
            .sort((a, b) => b[0] - a[0]);
          for (const [s, e] of zeroBased) {
            if (s < 0 || e >= current.length || s > e) throw new Error(`删除范围 [${s + 1}, ${e + 1}] 超出范围`);
            current.splice(s, e - s + 1);
          }
        }
      } catch (err: any) {
        return { filePath, ok: false, message: `批次应用失败 [${entry.type}]：${err.message}` };
      }
    }

    // 整体语法检查（暂存阶段不做，避免基于不完整中间态误报）
    const newContent = current.join(lineEnding) + (hasTrailingNewline && current.length > 0 ? lineEnding : '');
    const checkResult = checkSyntax(filePath, newContent);
    if (!checkResult.ok) {
      return { filePath, ok: false, message: formatSyntaxErrors(checkResult, { oldLines: baseLines, newLines: current }) };
    }

    // 一次写盘 + 一条 undo 记录（撤销即整个批次回滚）
    const desc = `批次合并应用 ${entries.length} 个 patch`;
    const record = await undoStack.executeWrite(
      filePath, 'batch', desc, baseLines, current, hasTrailingNewline, lineEnding,
      async (nl: string[]) => {
        await fs.writeFile(filePath, nl.join(lineEnding) + (hasTrailingNewline ? lineEnding : ''), 'utf8');
      },
    );
    return {
      filePath, ok: true, message: desc,
      fromLines: baseLines.length, toLines: current.length, diff: record.diff,
    };
  }
}

/** 全局批次暂存管理器单例 */
export const patchBatch = new PatchBatchManager();




