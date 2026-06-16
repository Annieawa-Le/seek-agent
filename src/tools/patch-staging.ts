import path from 'path';

/**
 * 暂存区中的单个待处理修改
 */
export interface PendingPatch {
  type: 'add' | 'del' | 'modify';
  /** 文件路径（原始输入，可能是相对路径） */
  rawFilePath: string;
  /** 已解析的绝对路径 */
  resolvedPath: string;
  /** 描述信息（用于预览） */
  description: string;
  /** 原始参数（用于实际应用） */
  params: Record<string, any>;
  /** 创建时间戳（用于残留检测） */
  createdAt: number;
  /** 操作 ID（用于追踪和精确清空） */
  sessionId: string;
  /** 原始返回消息（用于 check_patch 回显） */
  resultMessage?: string;
  /** 是否开启续批模式：行号基于上一个 patch 改完后的文件，
   *  且应用时与之前未标记 resume 的 patch 分属不同批次，批次间顺序叠加。
   *  默认 false。 */
  resume?: boolean;
}
export class PatchStaging {
  private patches: PendingPatch[] = [];
  /** 当前会话 ID，每次 clear 时更新 */
  private currentSessionId: string = '';
  /** 超过此毫秒数的 patch 视为过期残留（5分钟） */
  private readonly STALE_THRESHOLD_MS = 5 * 60 * 1000;

  constructor() {
    this.currentSessionId = this.generateSessionId();
  }

  private generateSessionId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  add(patch: PendingPatch): void {
    this.patches.push(patch);
  }

  getAll(): PendingPatch[] {
    return [...this.patches];
  }

  getByFile(filePath: string): PendingPatch[] {
    const resolved = path.resolve(filePath);
    return this.patches.filter(p => p.resolvedPath === resolved);
  }

  getAffectedFiles(): string[] {
    const files = new Set<string>();
    for (const p of this.patches) {
      files.add(p.resolvedPath);
    }
    return Array.from(files);
  }

  generatePreview(): string {
    if (this.patches.length === 0) {
      return '📭 暂存区为空，没有任何待应用的修改。';
    }
    const lines: string[] = [];
    lines.push(`📋 暂存区中共有 ${this.patches.length} 个待应用的修改：`);
    lines.push('');
    const byFile = new Map<string, PendingPatch[]>();
    for (const p of this.patches) {
      const file = p.resolvedPath;
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file)!.push(p);
    }
    let idx = 1;
    for (const [filePath, filePatches] of byFile) {
      lines.push(`📄 文件：${filePath}`);
      for (const p of filePatches) {
        lines.push(`   ${idx}. [${p.type.toUpperCase()}] ${p.description}`);
        idx++;
      }
      lines.push('');
    }
    lines.push('💡 执行 ensure_patch({ apply: true }) 将应用以上所有修改');
    lines.push('💡 执行 ensure_patch({ apply: false }) 将放弃以上所有修改');
    return lines.join('\n');
  }

  isEmpty(): boolean {
    return this.patches.length === 0;
  }

  pop(): PendingPatch | undefined {
    return this.patches.pop();
  }

  /** 设置最近添加的 patch 的 resultMessage */
  setLastResultMessage(msg: string): void {
    if (this.patches.length > 0) {
      this.patches[this.patches.length - 1].resultMessage = msg;
    }
  }

  /** 按索引移除一个 patch（1-based） */
  removeAt(index: number): PendingPatch | undefined {
    if (index < 1 || index > this.patches.length) return undefined;
    return this.patches.splice(index - 1, 1)[0];
  }

  clear(): void {
    this.patches = [];
    this.currentSessionId = this.generateSessionId();
  }

  getSessionId(): string {
    return this.currentSessionId;
  }

  get size(): number {
    return this.patches.length;
  }

  clearStalePatches(): number {
    const now = Date.now();
    const before = this.patches.length;
    this.patches = this.patches.filter(p => (now - p.createdAt) < this.STALE_THRESHOLD_MS);
    return before - this.patches.length;
  }

  autoClearStaleIfNeeded(): { cleared: number; hasStale: boolean } {
    const clearedByTime = this.clearStalePatches();
    const foreignPatches = this.patches.filter(p => p.sessionId !== this.currentSessionId);
    if (foreignPatches.length > 0) {
      this.patches = this.patches.filter(p => p.sessionId === this.currentSessionId);
      return { cleared: clearedByTime + foreignPatches.length, hasStale: true };
    }
    return { cleared: clearedByTime, hasStale: clearedByTime > 0 };
  }
}

// 全局单例
export const patchStaging = new PatchStaging();


