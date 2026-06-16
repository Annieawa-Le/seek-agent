/**
 * ref-desk-core.ts — 参考桌面核心
 *
 * 独立的 RefDesk 类与单例，供 memory_agent、desk-edit、ref-desk 工具共享。
 * RefDesk 仅存放 AI 通过 desk_add 主动添加的文件。
 *
 * 注意：系统不会自动提取任何文件到桌面上——
 * AI 完全拥有桌面的控制权。
 */

// ═════════════════════════════════════════════════════
// 类型定义
// ═════════════════════════════════════════════════════

export interface RefEntry {
  filePath: string;
  content: string;
  updatedAtRound: number;
}

// ═════════════════════════════════════════════════════
// RefDesk 类
// ═════════════════════════════════════════════════════

export class RefDesk {
  private entries = new Map<string, RefEntry>();

  set(filePath: string, content: string, roundId: number): void {
    this.entries.set(filePath, { filePath, content, updatedAtRound: roundId });
  }

  has(filePath: string): boolean {
    return this.entries.has(filePath);
  }

  remove(filePath: string): void {
    this.entries.delete(filePath);
  }

  getAll(): RefEntry[] {
    return [...this.entries.values()].sort((a, b) =>
      a.filePath.localeCompare(b.filePath)
    );
  }

  get hasAny(): boolean {
    return this.entries.size > 0;
  }

  clear(): void {
    this.entries.clear();
  }

  toMessages(): import('ai').ModelMessage[] {
    if (this.entries.size === 0) return [];

    return this.getAll().map(entry => ({
      role: 'user' as const,
      content: `[ref] ${entry.filePath}\n\`\`\`\n${entry.content}\n\`\`\``,
    }));
  }
}

// ── 模块级单例 ──
export const refDesk = new RefDesk();
