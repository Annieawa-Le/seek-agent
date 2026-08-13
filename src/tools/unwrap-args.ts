/**
 * unwrap-args.ts — 包装参数解包（无副作用纯模块）
 *
 * 模型偶尔会把工具参数包进 _raw / input / args 等包装键（训练分布中常见的工具调用格式漂移）。
 * AI SDK 对非法参数会降级返回原始 JSON 解析结果（保留包装键），
 * 工具执行层统一解包为扁平参数后透传，让这种调用正常执行而非报"参数为空"。
 */

export const WRAP_KEYS = ['_raw', 'raw', 'input', 'args', 'payload', 'params'] as const;

export function unwrapToolArgs(args: any): any {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  for (const key of WRAP_KEYS) {
    const inner = args[key];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      // 仅当顶层除包装键外没有其他有效参数时才解包（避免误伤混合调用 / 真实 input 参数）
      const otherKeys = Object.keys(args).filter(k => k !== key);
      if (otherKeys.every(k => args[k] === undefined)) {
        return { ...inner };
      }
    }
  }
  return args;
}
