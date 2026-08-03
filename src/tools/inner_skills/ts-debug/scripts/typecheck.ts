/**
 * typecheck.ts — ts_typecheck 工具
 * 运行 tsc --noEmit（或渲染层 tsc -b --noEmit），支持按键路径片段过滤错误。
 */
import { tool } from 'ai';
import { z } from 'zod';
import path from 'node:path';
import { getWorkspaceRoot } from '../../../../workdir.js';
import { runNode, combinedOutput, truncate } from './run';

const MAX_ERROR_LINES = 60;

export const tsTypecheck = tool({
  description:
    '运行 TypeScript 类型检查（tsc --noEmit），返回错误行列表与错误总数。' +
    '支持 filter 按键路径片段过滤（如 "context-compactor"），便于定位单个文件的错误并对比基线。' +
    'cwd 传 "electron/renderer" 时对渲染层跑 tsc -b --noEmit。',
  inputSchema: z.object({
    filter: z.string().optional().describe('只显示错误行中包含该路径片段（如 "context-compactor" 或 "agent.ts"）的错误；不传则显示全部'),
    cwd: z.string().optional().describe('检查目录：不传=工作区根；"electron/renderer"=渲染层（tsc -b --noEmit）'),
  }),
  execute: async ({ filter, cwd }) => {
    const root = getWorkspaceRoot();
    const useRenderer = cwd === 'electron/renderer' || cwd === 'renderer';

    let args: string[];
    let runCwd = root;
    if (useRenderer) {
      const tscBin = path.join(root, 'electron/renderer/node_modules/typescript/bin/tsc');
      args = [tscBin, '-b', '--noEmit'];
      runCwd = path.join(root, 'electron/renderer');
    } else {
      const tscBin = path.join(root, 'node_modules/typescript/bin/tsc');
      args = [tscBin, '--noEmit'];
    }

    const r = await runNode(args, { cwd: runCwd, timeoutMs: 180000 });
    const all = combinedOutput(r);
    const errorLines = all.split('\n').filter((l) => l.includes('error TS'));
    const target = useRenderer ? '渲染层' : '根目录';
    const filtered = filter ? errorLines.filter((l) => l.includes(filter)) : errorLines;

    if (errorLines.length === 0 && r.code === 0) {
      return `✅ tsc --noEmit（${target}）通过，0 错误`;
    }

    const shown = filtered.slice(0, MAX_ERROR_LINES);
    const truncated = truncate(shown.join('\n'), 8000);
    let out = `❌ 类型检查失败（${target}）：共 ${errorLines.length} 个错误`;
    if (filter) out += `，匹配 "${filter}" ${filtered.length} 个`;
    if (truncated.text.length === 0) {
      out += `\n（无匹配 "${filter}" 的错误行）`;
    } else {
      out += `\n${truncated.text}`;
      if (filtered.length > MAX_ERROR_LINES || truncated.truncated) {
        out += `\n…（仅显示前 ${MAX_ERROR_LINES} 行，共 ${filtered.length} 条匹配）`;
      }
    }
    return out;
  },
});

