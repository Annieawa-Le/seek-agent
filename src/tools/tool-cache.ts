/**
 * ToolCache — 工具调用缓存层
 *
 * 缓存命中条件（同时满足）：
 * 1. 参数相同 — 相同工具名 + 相同规范化参数
 * 2. 连续调用 — 工具 A 上次被调用后，中间没有被其他工具打断（A→A 命中，A→B→A 不命中）
 * 3. 时间相近 — 距离该工具上次执行在阈值内
 *
 * 缓存生命周期：每轮 agent 处理开始时调用 reset() 清空。
 */


export class ToolCache {
  private cache = new Map<string, string>();
  /** 最近一次 wrap 调用是否命中了缓存 */
  wasCacheHit = false;
  /** 每个 key 最近一次执行的时间戳（毫秒） */
  private lastExecTime = new Map<string, number>();
  /** 时间相近阈值（毫秒）：同一 key 在此时间内连续调用才命中缓存 */
  private static readonly PROXIMITY_MS = 600;
  /** 全局上一次调用的工具名（用于连续性检测） */
  private lastToolName: string | null = null;

  /** 重置缓存（每轮 agent 处理开始时调用） */
  reset(): void {
    this.cache.clear();
    this.lastExecTime.clear();
    this.lastToolName = null;
  }

  /** 当前缓存条目数 */
  get size(): number {
    return this.cache.size;
  }

  /**
   * 包装工具 execute 函数。
   * 仅当：参数相同 + 连续调用 + 时间相近 同时满足时返回缓存。
   */
  wrap<TArgs extends Record<string, unknown>>(
    toolName: string,
    execute: (args: TArgs, options?: any) => Promise<string>,
  ): (args: TArgs, options?: any) => Promise<string> {
    return async (args: TArgs, options?: any): Promise<string> => {
      const key = this.makeKey(toolName, args);

      const cached = this.cache.get(key);
      if (cached !== undefined) {
        // 连续性检测：上一次调用的工具名必须与本次相同
        const isContinuous = this.lastToolName === toolName;
        // 时间相近检测：距离上次执行在阈值内
        const lastTime = this.lastExecTime.get(key);
        const isRecent = lastTime !== undefined
          && (Date.now() - lastTime) < ToolCache.PROXIMITY_MS;

        if (isContinuous && isRecent) {
          this.wasCacheHit = true;
          this.lastToolName = toolName; // 保持连续性
          return `${cached}`;
        }
      }

      this.wasCacheHit = false;
      const result = await execute(args, options);
      this.lastExecTime.set(key, Date.now());
      this.cache.set(key, result);
      this.lastToolName = toolName;
      return result;
    };
  }

  /** 生成规范化缓存 key */
  private makeKey(toolName: string, args: Record<string, unknown>): string {
    const sortedKeys = Object.keys(args).sort();
    return `${toolName}:${JSON.stringify(args, sortedKeys)}`;
  }
}

/** 全局单例 */
export const toolCache = new ToolCache();
