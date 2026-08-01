import { tool } from 'ai';
import { z } from 'zod';
import { browserManager } from './manager';

export const browserExecuteJs = tool({
  description: `在当前页面中执行 JavaScript 代码，返回执行结果（结果会被序列化，超长部分截断；循环引用等不可序列化对象会降级为类型描述而非报错）。`,
  inputSchema: z.object({
    script: z.string().describe('要执行的 JavaScript 代码，如 `document.title` 或 `Array.from(document.querySelectorAll("a")).map(a=>a.href)`'),
  }),
  execute: async ({ script }): Promise<string> => {
    try {
      const page = browserManager.getPage();
      const result = await page.evaluate((code) => {
        try {
          // 尝试作为表达式求值
          return Function(`"use strict"; return (${code})`)();
        } catch {
          // 失败则作为语句执行
          Function(`"use strict"; ${code}`)();
          return undefined;
        }
      }, script);
      const serialized = safeStringify(result);
      return `✅ 执行成功\n${truncate(serialized ?? '(返回 undefined)', 20000)}`;
    } catch (error) {
      return `❌ 执行失败: ${(error as Error).message}`;
    }
  },
});

/** 安全序列化 JS 结果：优先 JSON，循环引用/不可序列化对象降级为类型描述 */
function safeStringify(value: unknown): string {
  if (value === undefined) return '(undefined)';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const json = JSON.stringify(value, null, 2);
    if (json !== undefined) return json;
  } catch {
    /* 循环引用等，走降级 */
  }
  // 降级：描述对象类型与关键属性
  try {
    const proto = Object.prototype.toString.call(value);
    if (typeof value === 'object') {
      const keys = Object.keys(value as object).slice(0, 20).join(', ');
      return `${proto} { ${keys} }（对象含循环引用或不可序列化，已降级）`;
    }
    return proto;
  } catch {
    return '[不可序列化对象]';
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n\n... [结果已截断]';
}

