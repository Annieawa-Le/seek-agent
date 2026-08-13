/**
 * tools.ts — code-graph 8 工具注册
 * list_symbols / read_symbol / find_references / trace_callers /
 * trace_callees / trace_chain / file_deps / blast_radius
 */
import { tool } from 'ai';
import { z } from 'zod';
import { getWorkspaceRoot, resolvePath } from '../../../../workdir.js';
import {
  listSymbols,
  readSymbol,
  findReferences,
  traceCallers,
  traceCallees,
  traceChain,
  fileDeps,
  blastRadius,
} from './ts-graph.js';

const rootDir = () => getWorkspaceRoot();

// ─── list_symbols ────────────────────────────────────────────

export const listSymbolsTool = tool({
  description: `列出代码文件中所有符号（函数/类/方法/接口/类型/枚举/变量/导入），含名称、类型、行号和签名。
  参数 filePath 是文件的绝对路径或相对当前工作目录的路径。`,
  inputSchema: z.object({
    filePath: z.string().describe('要分析的代码文件路径（相对或绝对）'),
  }),
  execute: async ({ filePath }): Promise<string> => {
    try {
      const abs = resolvePath(filePath);
      const { symbols } = await listSymbols(rootDir(), abs);
      if (symbols.length === 0) {
        return `在文件 ${filePath} 中未发现符号。`;
      }
      const lines: string[] = [`📊 符号列表 (${filePath})`, `总计: ${symbols.length} 个符号\n`];
      for (const s of symbols) {
        const exportMark = s.exported ? '📤 ' : '';
        const container = s.container ? `${s.container}.` : '';
        lines.push(
          `L${String(s.startLine).padStart(4)} ${exportMark}${s.kind.padEnd(9)} ${container}${s.name}`
        );
      }
      return lines.join('\n');
    } catch (error) {
      return `符号列表失败: ${(error as Error).message}`;
    }
  },
});

// ─── read_symbol ─────────────────────────────────────────────

export const readSymbolTool = tool({
  description: `读取代码文件中某个符号的完整定义，包括签名、文档注释、位置和代码体。
  参数 filePath 是文件的绝对路径或相对当前工作目录的路径。
  symbolName 是符号名，支持 "ClassName.method" 格式指定类方法。`,
  inputSchema: z.object({
    filePath: z.string().describe('要分析的代码文件路径（相对或绝对）'),
    symbolName: z.string().describe('符号名（函数/类/方法/接口/类型/枚举/变量），可用 ClassName.method 指定类方法'),
  }),
  execute: async ({ filePath, symbolName }): Promise<string> => {
    try {
      const abs = resolvePath(filePath);
      return await readSymbol(rootDir(), abs, symbolName);
    } catch (error) {
      return `读取符号失败: ${(error as Error).message}`;
    }
  },
});

// ─── find_references ─────────────────────────────────────────

export const findReferencesTool = tool({
  description: `查找某个符号在项目中的所有引用位置（跨文件），返回文件路径、行号、列号和上下文代码。
  参数 symbolName 是要查找的符号名。
  filePath 可选，限定只在指定文件中查找。`,
  inputSchema: z.object({
    symbolName: z.string().describe('要查找引用的符号名（函数/类/变量等）'),
    filePath: z.string().optional().describe('可选，限定只在指定文件中查找引用'),
  }),
  execute: async ({ symbolName, filePath }): Promise<string> => {
    try {
      const abs = filePath ? resolvePath(filePath) : undefined;
      const { refs, total } = await findReferences(rootDir(), symbolName, abs);
      if (total === 0) {
        return `未找到符号 "${symbolName}" 的任何引用。`;
      }
      const lines: string[] = [`🔍 引用查找: ${symbolName}`, `总计: ${total} 处引用\n`];
      for (const r of refs) {
        const rel = r.file;
        lines.push(`  ${rel}:${r.line}:${r.column}`);
        if (r.context) lines.push(`    └─ ${r.context}`);
      }
      if (total > refs.length) {
        lines.push(`\n... 及另外 ${total - refs.length} 处（已截断）`);
      }
      return lines.join('\n');
    } catch (error) {
      return `引用查找失败: ${(error as Error).message}`;
    }
  },
});

// ─── trace_callers ───────────────────────────────────────────

export const traceCallersTool = tool({
  description: `反向调用链：查找项目中谁调用了指定函数，返回调用位置（文件、行号、所在函数）和上下文代码。
  参数 filePath 是包含该函数定义的文件的绝对路径或相对路径。
  functionName 是要追踪的函数名。`,
  inputSchema: z.object({
    filePath: z.string().describe('包含目标函数定义的代码文件路径'),
    functionName: z.string().describe('要追踪的函数名（谁调用了它）'),
  }),
  execute: async ({ filePath, functionName }): Promise<string> => {
    try {
      const abs = resolvePath(filePath);
      const { callers, total } = await traceCallers(rootDir(), abs, functionName);
      if (total === 0) {
        return `未找到调用 "${functionName}" 的位置（可能无人调用，或只被动态调用）。`;
      }
      const lines: string[] = [`⬅️ 调用方追踪: ${functionName}`, `总计: ${total} 处调用\n`];
      for (const c of callers) {
        lines.push(`  ${c.file}:${c.line}  [${c.callerName}]`);
        if (c.context) lines.push(`    └─ ${c.context}`);
      }
      if (total > callers.length) {
        lines.push(`\n... 及另外 ${total - callers.length} 处（已截断）`);
      }
      return lines.join('\n');
    } catch (error) {
      return `调用方追踪失败: ${(error as Error).message}`;
    }
  },
});

// ─── trace_callees ───────────────────────────────────────────

export const traceCalleesTool = tool({
  description: `正向调用链：列出指定函数内部直接调用的所有函数，返回被调用函数名、文件和行号。
  参数 filePath 是包含该函数定义的文件的绝对路径或相对路径。
  functionName 是要追踪的函数名。`,
  inputSchema: z.object({
    filePath: z.string().describe('包含目标函数定义的代码文件路径'),
    functionName: z.string().describe('要追踪的函数名（它调用了谁）'),
  }),
  execute: async ({ filePath, functionName }): Promise<string> => {
    try {
      const abs = resolvePath(filePath);
      const { callees, total } = await traceCallees(rootDir(), abs, functionName);
      if (total === 0) {
        return `函数 "${functionName}" 内部没有直接调用其他函数。`;
      }
      const lines: string[] = [`➡️ 被调用函数追踪: ${functionName}`, `总计: ${total} 个直接调用\n`];
      for (const c of callees) {
        lines.push(`  ${c.name}  (${c.file}:${c.line})`);
        if (c.context) lines.push(`    └─ ${c.context}`);
      }
      return lines.join('\n');
    } catch (error) {
      return `被调用函数追踪失败: ${(error as Error).message}`;
    }
  },
});

// ─── trace_chain ─────────────────────────────────────────────

export const traceChainTool = tool({
  description: `完整调用链追踪：从指定函数出发，BFS 展开其调用与被调用关系，输出调用链树（按深度缩进）。
  参数 filePath 是包含目标函数的文件的绝对路径或相对路径。
  functionName 是起点函数名。
  depth 是展开深度（默认 3，最大 6）。`,
  inputSchema: z.object({
    filePath: z.string().describe('包含起点函数定义的代码文件路径'),
    functionName: z.string().describe('调用链起点函数名'),
    depth: z.number().int().min(1).max(6).optional().default(3).describe('展开深度（默认 3）'),
  }),
  execute: async ({ filePath, functionName, depth }): Promise<string> => {
    try {
      const abs = resolvePath(filePath);
      const { chain, truncated } = await traceChain(rootDir(), abs, functionName, depth ?? 3);
      if (chain.length === 0) {
        return `未找到函数 "${functionName}" 或它没有任何调用关系。`;
      }
      const lines: string[] = [`🕸️ 调用链: ${functionName} (深度 ${depth ?? 3})`];
      for (const c of chain) {
        const indent = '  '.repeat(c.depth);
        lines.push(`${indent}${c.depth === 0 ? '▶' : '└'} ${c.name}  (${c.file})`);
      }
      if (truncated) {
        lines.push(`\n... 达到最大深度 ${depth ?? 3}，调用链已截断`);
      }
      lines.push(`\n节点总数: ${chain.length}`);
      return lines.join('\n');
    } catch (error) {
      return `调用链追踪失败: ${(error as Error).message}`;
    }
  },
});

// ─── file_deps ───────────────────────────────────────────────

export const fileDepsTool = tool({
  description: `文件依赖分析：列出指定文件 import/require 的所有模块，标注解析后的实际文件路径、依赖类型（import/require/type）和是否外部包。
  参数 filePath 是文件的绝对路径或相对当前工作目录的路径。`,
  inputSchema: z.object({
    filePath: z.string().describe('要分析的代码文件路径（相对或绝对）'),
  }),
  execute: async ({ filePath }): Promise<string> => {
    try {
      const abs = resolvePath(filePath);
      const { deps } = await fileDeps(rootDir(), abs);
      if (deps.length === 0) {
        return `文件 ${filePath} 没有任何依赖。`;
      }
      const lines: string[] = [`🔗 文件依赖 (${filePath})`, `总计: ${deps.length} 个依赖\n`];
      for (const d of deps) {
        const ext = d.external ? '📦' : '📄';
        lines.push(`  ${ext} ${d.kind.padEnd(7)} ${d.to}  (L${d.line})`);
      }
      return lines.join('\n');
    } catch (error) {
      return `文件依赖分析失败: ${(error as Error).message}`;
    }
  },
});

// ─── blast_radius ────────────────────────────────────────────

export const blastRadiusTool = tool({
  description: `影响面分析：修改指定文件（或其中某符号）会影响哪些文件。返回所有依赖该文件（import 它）或引用该符号的文件及具体位置。
  参数 filePath 是即将修改的文件的绝对路径或相对路径。
  symbolName 可选，指定只分析修改某符号的影响面。`,
  inputSchema: z.object({
    filePath: z.string().describe('即将修改的代码文件路径'),
    symbolName: z.string().optional().describe('可选，要分析影响的符号名（函数/类/变量）'),
  }),
  execute: async ({ filePath, symbolName }): Promise<string> => {
    try {
      const abs = resolvePath(filePath);
      const { hits, files, total } = await blastRadius(rootDir(), abs, symbolName);
      if (total === 0) {
        return `修改 ${filePath}${symbolName ? ` 的 ${symbolName}` : ''} 不影响任何其他文件。`;
      }
      const lines: string[] = [
        `💥 影响面分析: ${filePath}${symbolName ? ` 的 ${symbolName}` : ''}`,
        `受影响文件: ${files.length} 个，影响点: ${total} 处\n`,
      ];
      for (const h of hits) {
        const kindIcon = h.kind === 'import' ? '📥' : h.kind === 'reference' ? '🔍' : '•';
        lines.push(`  ${kindIcon} ${h.file}:${h.line}  (${h.kind})`);
        if (h.context) lines.push(`    └─ ${h.context}`);
      }
      if (total > hits.length) {
        lines.push(`\n... 及另外 ${total - hits.length} 处（已截断）`);
      }
      return lines.join('\n');
    } catch (error) {
      return `影响面分析失败: ${(error as Error).message}`;
    }
  },
});


