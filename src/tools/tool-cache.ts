/**
 * ToolCache — 工具调用缓存层
 *
 * 缓存命中条件（同时满足）：
 * 1. 参数相同 — 相同工具名 + 相同规范化参数
 * 2. 连续调用 — 工具 A 上次被调用后，中间没有被其他工具打断（A→A 命中，A→B→A 不命中）
 * 3. 时间相近 — 距离该工具上次执行在阈值内
 *
 * 缓存生命周期：每轮 agent 处理开始时调用 reset() 清空。
 *
 * 注意：缓存保存工具的原始返回值（可能是 ToolOutput 实例），
 * 命中时原样返回，由上层 extractBulk 重新提取 rawBulk，避免丢失结构化数据。
 */


export class ToolCache {
  private cache = new Map<string, unknown>();
  /** 最近一次 wrap 调用是否命中了缓存 */
  wasCacheHit = false;
  /** 每个 key 最近一次执行的时间戳（毫秒） */
  private lastExecTime = new Map<string, number>();
  /** 豁免缓存名单：这些工具往往有实时副作用（后台任务/命令执行/闹钟/任务段标记），
   *  相同参数反复调用也应每次真实执行，否则会拿到过期结果（如 task_switch 轮询）。
   *  ALARM_* / MISSION-* 为通配前缀：alarm_* 与 mission-* 全部豁免（任务段状态有唯一性，缓存会跳过真实裁剪）。 */
  private static readonly NO_CACHE_TOOLS = new Set<string>([
    'task_execute', 'task_switch', 'task_kill', 'task_list',
    'execute_command',
    'ALARM_*',
    'MISSION-*',
  ]);

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
   * 返回值类型为 unknown：既可能是 string，也可能是 ToolOutput 等结构化对象。
   */
  wrap<TArgs extends Record<string, unknown>>(
    toolName: string,
    execute: (args: TArgs, options?: any) => Promise<unknown>,
  ): (args: TArgs, options?: any) => Promise<unknown> {
    return async (args: TArgs, options?: any): Promise<unknown> => {
      // 豁免名单内的工具每次真实执行（实时副作用，缓存会拿到过期结果）
      if (ToolCache.isNoCache(toolName)) {
        this.wasCacheHit = false;
        this.lastToolName = toolName;
        const result = await execute(args, options);
        return result;
      }

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
          return cached;
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

  /** 判断工具是否命中豁免名单（支持 * 通配后缀，如 ALARM_*；比较不区分大小写） */
  private static isNoCache(toolName: string): boolean {
    if (ToolCache.NO_CACHE_TOOLS.has(toolName)) return true;
    const upper = toolName.toUpperCase();
    for (const pattern of ToolCache.NO_CACHE_TOOLS) {
      if (pattern.endsWith('*') && upper.startsWith(pattern.slice(0, -1))) return true;
    }
    return false;
  }
}

/** 全局单例 */
export const toolCache = new ToolCache();







