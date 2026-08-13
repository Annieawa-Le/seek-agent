/**
 * doc-pool-store.ts — 文件池（doc_pool）存储与读阶段扫描
 *
 * Manager 模式编排工具：主模型调用 doc_pool{pool_name, name} 后，把子模型「读阶段」
 * 读取到的文件片段沉淀为命名文件池；委派时通过 agent_task 的 pool_name 参数把池内容
 * 注入新子模型的初始上下文，实现「一组员工共享同一批背景文件」。
 *
 * 读阶段语义：从子模型第一条工具调用开始，从前往后扫描，直到遇到第一个写入工具
 * （add_patch / del_patch / modify_patch / create_file / replace_file / wrap_by 等）
 * 或 TODO 工具（create_todo 等）为止——之前的读取工具调用（read_file / read_lines /
 * scan_file 等）都被记录。之后若有写入工具修改了池中的文件，该文件的片段会被移除。
 *
 * 持久化：池是团队知识沉淀，不会随子模型销毁而清除——落盘到
 *   {workspace}/sessions/{sessionId}/subagent-docs/doc-pool-{poolName}.json
 * agent_fire 只解除「池 ↔ 子模型」的实时挂钩关联，池本身与文件保留；
 * 跨会话/重启后 doc_pool 再次关联时自动从磁盘恢复。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getSessionsRoot } from '../workdir';

/** 一条池条目 = 子模型读阶段的一次完整读取工具调用（参数 + 结果） */
export interface PoolEntry {
  /** 唯一键（用子模型工具调用的 toolCallId，避免重复记录） */
  key: string;
  toolName: string;
  args: Record<string, unknown>;
  filePath: string;
  result: string;
  at: number;
}

export interface DocPool {
  poolName: string;
  agentName: string;
  /** normKey(文件路径) → { 原始路径, 片段列表 } */
  files: Map<string, { path: string; entries: PoolEntry[] }>;
  entries: PoolEntry[];
  updatedAt: number;
}

/** 读取工具（读阶段记录对象） */
const READ_TOOLS = new Set([
  'read_file', 'read_lines', 'scan_file',
  'explorer-read-file', 'explorer-read-lines', 'explorer-read-num-line', 'explorer-scan-file',
]);

/** 写入工具（结束读阶段 + 其文件从池中移除） */
const WRITE_TOOLS = new Set([
  'add_patch', 'del_patch', 'modify_patch', 'wrap_by', 'wrap_by_label',
  'create_file', 'replace_file',
  'explorer-add-patch', 'explorer-del-patch', 'explorer-modify-patch',
  'explorer-create-file', 'explorer-replace-file',
]);

/** TODO 工具（结束读阶段，不视为写文件） */
const TODO_TOOLS = new Set([
  'create_todo', 'finish_step', 'undo_step', 'reroll_step', 'del_step', 'read_todo', 'del_todo', 'active_todo',
  'todo_save', 'todo_load', 'todo_list_saved', 'todo_delete_saved',
]);

export function isReadTool(name: string): boolean {
  return READ_TOOLS.has(name);
}
export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name);
}
export function isTodoTool(name: string): boolean {
  return TODO_TOOLS.has(name);
}
export function isWriteOrTodo(name: string): boolean {
  return WRITE_TOOLS.has(name) || TODO_TOOLS.has(name);
}

/** 文件名安全化（sessionId / 池名 → 合法文件名） */
function safeName(id: string): string {
  return (id || 'default').replace(/[\\/:*?"<>|]/g, '_');
}

/** 每条池条目结果的最大保留长度（控制注入体积） */
const MAX_ENTRY_LEN = 6000;
/** 注入消息总长度上限 */
const MAX_INJECT_LEN = 24000;

/** 规范化路径 key（Windows 大小写不敏感） */
export function normKey(p: string): string {
  try {
    return path.normalize(p).toLowerCase();
  } catch {
    return String(p).toLowerCase();
  }
}

/** 从工具调用输入中提取目标文件路径 */
export function extractFilePath(toolName: string, input: unknown): string | undefined {
  const obj = (input ?? {}) as Record<string, unknown>;
  // create_file 特例：filePath 是目录 + fileName 是文件名，需先合并（避免通用路径提前返回目录）
  if (toolName === 'create_file' && typeof obj.filePath === 'string' && typeof obj.fileName === 'string' && obj.fileName) {
    return `${obj.filePath.replace(/[\\/]+$/, '')}/${obj.fileName}`;
  }
  const p = obj.filePath ?? obj.file ?? obj.path;
  if (typeof p === 'string' && p.trim()) return p.trim();
  return undefined;
}

/** 从工具结果对象中提取文本 */
export function extractResultText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object') {
    const o = output as { type?: string; value?: unknown };
    if (o.type === 'text' && typeof o.value === 'string') return o.value;
  }
  try {
    return JSON.stringify(output);
  } catch {
    return '';
  }
}

/**
 * 从子模型的完整消息序列中扫描读阶段。
 * 返回读阶段读取条目 + 全程写入过的文件路径（供移除池片段）。
 */
export function scanReadPhase(messages: unknown[]): {
  readEntries: Omit<PoolEntry, 'at'>[];
  writtenFiles: string[];
} {
  // 第一遍：收集 toolCallId → 结果文本
  const results = new Map<string, string>();
  for (const m of messages) {
    const msg = m as { role?: string; content?: unknown };
    if (msg?.role !== 'tool' || !Array.isArray(msg.content)) continue;
    for (const p of msg.content as any[]) {
      if (p?.type === 'tool-result' && typeof p.toolCallId === 'string') {
        results.set(p.toolCallId, extractResultText(p.output));
      }
    }
  }

  let readPhase = true;
  const readEntries: Omit<PoolEntry, 'at'>[] = [];
  const writtenFiles: string[] = [];
  const seen = new Set<string>();

  for (const m of messages) {
    const msg = m as { role?: string; content?: unknown };
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const p of msg.content as any[]) {
      if (p?.type !== 'tool-call' || typeof p.toolName !== 'string') continue;
      const toolName = p.toolName;
      const input = p.input ?? {};
      const filePath = extractFilePath(toolName, input);
      if (isWriteTool(toolName)) {
        readPhase = false;
        if (filePath) writtenFiles.push(filePath);
        continue;
      }
      if (isTodoTool(toolName)) {
        readPhase = false;
        continue;
      }
      if (readPhase && isReadTool(toolName) && filePath) {
        const key = typeof p.toolCallId === 'string' ? p.toolCallId : `${toolName}:${Date.now()}:${Math.random()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const result = results.get(key) ?? '';
        if (result) {
          readEntries.push({
            key,
            toolName,
            args: input as Record<string, unknown>,
            filePath,
            result: result.length > MAX_ENTRY_LEN ? `${result.slice(0, MAX_ENTRY_LEN)}\n…[文件池片段已截断]` : result,
          });
        }
      }
    }
  }
  return { readEntries, writtenFiles };
}

/** 把池内容构建为注入子模型的 user 消息文本 */
export function buildInjectionMessage(pool: DocPool): string {
  const lines: string[] = [
    `【文件池：${pool.poolName}】以下是从文件池加载的参考文件片段（由子模型「${pool.agentName}」读阶段读取，共 ${pool.entries.length} 个片段 / ${pool.files.size} 个文件）：`,
  ];
  let total = 0;
  for (const [, f] of pool.files) {
    const head = `\n── 文件: ${f.path} ──`;
    lines.push(head);
    total += head.length;
    for (const e of f.entries) {
      const part = `（${e.toolName} 读取）\n${e.result}\n`;
      if (total + part.length > MAX_INJECT_LEN) {
        lines.push('…[文件池上下文过长已截断]');
        return lines.join('\n');
      }
      lines.push(part);
      total += part.length;
    }
  }
  return lines.join('\n');
}

export class DocPoolStore {
  private pools = new Map<string, DocPool>();
  /** agentName → poolName（子模型实时挂钩用） */
  private agentPool = new Map<string, string>();
  /** agentName → 读阶段已结束（遇到第一个写/TODO 工具后置位） */
  private readPhaseDone = new Set<string>();
  /** 当前主会话 ID（池落盘到 sessions/{sid}/subagent-docs/，agent 启动/切换时同步） */
  private sessionId = '';

  /** agent 启动/切换会话时调用，池落盘位置跟随 */
  setSessionId(id: string): void {
    this.sessionId = id;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /** 池文件路径：{workspace}/sessions/{sid}/subagent-docs/doc-pool-{poolName}.json */
  private poolFilePath(poolName: string): string {
    return path.join(
      getSessionsRoot(), 'sessions', safeName(this.sessionId),
      'subagent-docs', `doc-pool-${safeName(poolName)}.json`,
    );
  }

  /** 持久化池到 subagent-docs（团队知识沉淀，不随子模型销毁） */
  private persistPool(poolName: string): void {
    const pool = this.pools.get(poolName);
    if (!pool) return;
    try {
      const fp = this.poolFilePath(poolName);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, JSON.stringify({
        poolName: pool.poolName,
        agentName: pool.agentName,
        entries: pool.entries,
        updatedAt: new Date().toISOString(),
      }, null, 2), 'utf-8');
    } catch { /* 落盘失败不影响内存态 */ }
  }

  /** 从磁盘恢复已沉淀的池；不存在/损坏返回 undefined（files 由 entries 重建） */
  private loadPersistedPool(poolName: string): DocPool | undefined {
    try {
      const fp = this.poolFilePath(poolName);
      if (!fs.existsSync(fp)) return undefined;
      const parsed = JSON.parse(fs.readFileSync(fp, 'utf-8')) as { poolName?: string; agentName?: string; entries?: PoolEntry[] };
      if (!parsed || !Array.isArray(parsed.entries)) return undefined;
      const pool: DocPool = {
        poolName: parsed.poolName || poolName,
        agentName: parsed.agentName || '',
        files: new Map(),
        entries: [],
        updatedAt: Date.now(),
      };
      for (const e of parsed.entries) {
        if (!e || typeof e.key !== 'string' || typeof e.filePath !== 'string') continue;
        pool.entries.push(e);
        const key = normKey(e.filePath);
        let bucket = pool.files.get(key);
        if (!bucket) { bucket = { path: e.filePath, entries: [] }; pool.files.set(key, bucket); }
        bucket.entries.push(e);
      }
      return pool;
    } catch {
      return undefined;
    }
  }


  getPool(poolName: string): DocPool | undefined {
    return this.pools.get(poolName);
  }

  listPools(): string[] {
    return Array.from(this.pools.keys());
  }

  /** 池摘要（doc_pool 工具返回给主模型） */
  describePool(poolName: string): string {
    const pool = this.pools.get(poolName);
    if (!pool) return `文件池 "${poolName}" 不存在。`;
    const lines = [`📚 文件池 "${poolName}"（关联子模型「${pool.agentName}」）:`];
    for (const [, f] of pool.files) {
      lines.push(`  - ${f.path}（${f.entries.length} 个片段）`);
    }
    lines.push(`共 ${pool.files.size} 个文件 / ${pool.entries.length} 个片段`);
    return lines.join('\n');
  }

  /**
   * doc_pool 工具调用：恢复已沉淀的池（磁盘/内存）→ 扫描子模型读阶段追加 → 建立实时挂钩关联。
   * 累积语义：池不因再次关联而清空（团队知识沉淀），按 toolCallId 去重。
   * 之后子模型循环中的读取/写入由 onToolResult 自动维护并落盘。
   */
  associateAndScan(poolName: string, agentName: string, messages: unknown[]): DocPool {
    let pool = this.pools.get(poolName) ?? this.loadPersistedPool(poolName);
    if (!pool) {
      pool = { poolName, agentName, files: new Map(), entries: [], updatedAt: Date.now() };
      this.pools.set(poolName, pool);
    } else {
      pool.poolName = poolName;
      pool.agentName = agentName;
      this.pools.set(poolName, pool);
    }
    this.agentPool.set(agentName, poolName);
    this.readPhaseDone.delete(agentName);

    const { readEntries, writtenFiles } = scanReadPhase(messages);
    for (const e of readEntries) {
      this.addEntry(poolName, e);
    }
    for (const fp of writtenFiles) {
      this.removeFile(poolName, fp);
    }
    this.persistPool(poolName);
    return pool;
  }

  /** 解除子模型关联（agent_fire / 销毁时调用）：只断开实时挂钩，池与磁盘文件保留 */
  unlinkAgent(agentName: string): void {
    this.agentPool.delete(agentName);
    this.readPhaseDone.delete(agentName);
  }


  /** runner 挂钩：子模型成功执行了一个工具调用 */
  /** runner 挂钩：子模型成功执行了一个工具调用（变更后同步落盘） */
  onToolResult(agentName: string, toolName: string, input: unknown, result: string, toolCallId: string): void {
    const poolName = this.agentPool.get(agentName);
    if (!poolName) return;
    const filePath = extractFilePath(toolName, input);
    if (isWriteTool(toolName)) {
      this.readPhaseDone.add(agentName);
      if (filePath) {
        this.removeFile(poolName, filePath);
        this.persistPool(poolName);
      }
      return;
    }
    if (isTodoTool(toolName)) {
      this.readPhaseDone.add(agentName);
      return;
    }
    if (this.readPhaseDone.has(agentName)) return;
    if (!isReadTool(toolName) || !filePath || !result) return;
    this.addEntry(poolName, {
      key: toolCallId || `${toolName}:${Date.now()}:${Math.random()}`,
      toolName,
      args: (input ?? {}) as Record<string, unknown>,
      filePath,
      result: result.length > MAX_ENTRY_LEN ? `${result.slice(0, MAX_ENTRY_LEN)}\n…[文件池片段已截断]` : result,
      at: Date.now(),
    });
    this.persistPool(poolName);
  }
  private addEntry(poolName: string, entry: Omit<PoolEntry, 'at'> & { at?: number }): void {
    const pool = this.pools.get(poolName);
    if (!pool) return;
    // 同 key 去重（doc_pool 扫描与实时挂钩可能覆盖同一调用）
    if (pool.entries.some((e) => e.key === entry.key)) return;
    const full: PoolEntry = { ...entry, at: entry.at ?? Date.now() };
    pool.entries.push(full);
    const key = normKey(full.filePath);
    let bucket = pool.files.get(key);
    if (!bucket) {
      bucket = { path: full.filePath, entries: [] };
      pool.files.set(key, bucket);
    }
    bucket.entries.push(full);
    pool.updatedAt = Date.now();
  }

  /** 从池中移除某文件的所有片段（该文件被修改过） */
  private removeFile(poolName: string, filePath: string): void {
    const pool = this.pools.get(poolName);
    if (!pool) return;
    const key = normKey(filePath);
    const bucket = pool.files.get(key);
    if (!bucket) return;
    const removedKeys = new Set(bucket.entries.map((e) => e.key));
    pool.files.delete(key);
    pool.entries = pool.entries.filter((e) => !removedKeys.has(e.key));
    pool.updatedAt = Date.now();
  }
}

/** 全局单例（进程内共享，与 subagentContextStore 同生命周期） */
export const docPoolStore = new DocPoolStore();












