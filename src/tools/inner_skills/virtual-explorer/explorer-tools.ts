/**
 * explorer-tools — 以 "explorer-" 为前缀的工具集
 *
 * 每个工具都相对于 virtual-explorer 的当前目录解析路径，
 * 然后委托给对应的核心工具执行。
 */

import { tool } from 'ai';
import { z } from 'zod';
import path from 'path';
import { getExplorerPath } from './explorer-state.js';

// ── 导入各原始工具 ──
import { readFileTool, readCertainLines, readNumline, scanFileTool } from '../../read-file.js';
import { searchAllFile, searchSubFile, searchDirectory, searchContent } from '../../search-files.js';
import { createFile, replaceFile, addPatch, delPatch, modifyPatch } from '../../file-manipulation.js';
import { executeCommandTool } from '../../execute-command.js';

// ── 辅助：将 filePath 解析为相对 explorer 当前目录的绝对路径 ──
function resolveExplorerPath(filePath: string): string {
  return path.resolve(getExplorerPath(), filePath);
}

/** 安全调用 tool.execute，补全第二个参数 */
function callExecute(t: any, input: any): Promise<any> {
  return t.execute(input, { toolCallId: '', messages: [] });
}

// ═════════════════════════════════════════════════════
// explorer-read-file
// ═════════════════════════════════════════════════════
export const explorerReadFile = tool({
  description: '相对于 virtual-explorer 当前目录读取文件内容。参数 filePath 是相对 explorer 当前目录的路径。',
  inputSchema: z.object({ filePath: z.string() }),
  execute: async ({ filePath }) => {
    return callExecute(readFileTool, { filePath: resolveExplorerPath(filePath) });
  },
});

// ═════════════════════════════════════════════════════
// explorer-read-lines
// ═════════════════════════════════════════════════════
export const explorerReadLines = tool({
  description: '相对于 virtual-explorer 当前目录读取特定行范围的文件内容。filePath 相对 explorer 当前目录。',
  inputSchema: z.object({ filePath: z.string(), startLine: z.number().int(), endLine: z.number().int() }),
  execute: async ({ filePath, startLine, endLine }) => {
    return callExecute(readCertainLines, { filePath: resolveExplorerPath(filePath), startLine, endLine });
  },
});

// ═════════════════════════════════════════════════════
// explorer-read-num-line
// ═════════════════════════════════════════════════════
export const explorerReadNumLine = tool({
  description: '相对于 virtual-explorer 当前目录读取带行号的特定行范围文件内容。filePath 相对 explorer 当前目录。',
  inputSchema: z.object({ filePath: z.string(), startLine: z.number().int(), endLine: z.number().int() }),
  execute: async ({ filePath, startLine, endLine }) => {
    return callExecute(readNumline, { filePath: resolveExplorerPath(filePath), startLine, endLine });
  },
});

// ═════════════════════════════════════════════════════
// explorer-scan-file
// ═════════════════════════════════════════════════════
export const explorerScanFile = tool({
  description: '相对于 virtual-explorer 当前目录扫描大文件并返回完整内容。filePath 相对 explorer 当前目录。',
  inputSchema: z.object({ filePath: z.string() }),
  execute: async ({ filePath }) => {
    return callExecute(scanFileTool, { filePath: resolveExplorerPath(filePath) });
  },
});

// ═════════════════════════════════════════════════════
// explorer-search-all-file
// ═════════════════════════════════════════════════════
export const explorerSearchAllFile = tool({
  description: '相对于 virtual-explorer 当前目录搜索文件（含子文件夹）。filePath 相对 explorer 当前目录。',
  inputSchema: z.object({ filePath: z.string(), fileName: z.string(), useRegex: z.boolean() }),
  execute: async ({ filePath, fileName, useRegex }) => {
    return callExecute(searchAllFile, { filePath: resolveExplorerPath(filePath), fileName, useRegex });
  },
});

// ═════════════════════════════════════════════════════
// explorer-search-sub-file
// ═════════════════════════════════════════════════════
export const explorerSearchSubFile = tool({
  description: '相对于 virtual-explorer 当前目录搜索文件（仅当前层）。filePath 相对 explorer 当前目录。',
  inputSchema: z.object({ filePath: z.string(), fileName: z.string(), useRegex: z.boolean() }),
  execute: async ({ filePath, fileName, useRegex }) => {
    return callExecute(searchSubFile, { filePath: resolveExplorerPath(filePath), fileName, useRegex });
  },
});

// ═════════════════════════════════════════════════════
// explorer-search-directory
// ═════════════════════════════════════════════════════
export const explorerSearchDirectory = tool({
  description: '相对于 virtual-explorer 当前目录递归搜索子文件夹。filePath 相对 explorer 当前目录。',
  inputSchema: z.object({ filePath: z.string() }),
  execute: async ({ filePath }) => {
    return callExecute(searchDirectory, { filePath: resolveExplorerPath(filePath) });
  },
});

// ═════════════════════════════════════════════════════
// explorer-search-content
// ═════════════════════════════════════════════════════
export const explorerSearchContent = tool({
  description: '在相对于 virtual-explorer 当前目录的文件中搜索内容。filePath 相对 explorer 当前目录。',
  inputSchema: z.object({ filePath: z.string(), content: z.string(), useRegex: z.boolean() }),
  execute: async ({ filePath, content, useRegex }) => {
    return callExecute(searchContent, { filePath: resolveExplorerPath(filePath), content, useRegex });
  },
});

// ═════════════════════════════════════════════════════
// explorer-create-file
// ═════════════════════════════════════════════════════
export const explorerCreateFile = tool({
  description: '相对于 virtual-explorer 当前目录创建新文件。filePath 相对 explorer 当前目录。',
  inputSchema: z.object({ filePath: z.string(), fileName: z.string(), fileContent: z.string() }),
  execute: async ({ filePath, fileName, fileContent }) => {
    return callExecute(createFile, { filePath: resolveExplorerPath(filePath), fileName, fileContent });
  },
});

// ═════════════════════════════════════════════════════
// explorer-replace-file
// ═════════════════════════════════════════════════════
export const explorerReplaceFile = tool({
  description: '相对于 virtual-explorer 当前目录替换文件内容。filePath 相对 explorer 当前目录。',
  inputSchema: z.object({ filePath: z.string(), fileContent: z.string() }),
  execute: async ({ filePath, fileContent }) => {
    return callExecute(replaceFile, { filePath: resolveExplorerPath(filePath), fileContent });
  },
});

// ═════════════════════════════════════════════════════
// explorer-add-patch
// ═════════════════════════════════════════════════════
export const explorerAddPatch = tool({
  description: '相对于 virtual-explorer 当前目录暂存插入操作。filePath 相对 explorer 当前目录。',
  inputSchema: z.object({ filePath: z.string(), lineIndex: z.number().int(), Lines: z.array(z.string()) }),
  execute: async ({ filePath, lineIndex, Lines }) => {
    return callExecute(addPatch, { filePath: resolveExplorerPath(filePath), lineIndex, Lines });
  },
});

// ═════════════════════════════════════════════════════
// explorer-del-patch
// ═════════════════════════════════════════════════════
export const explorerDelPatch = tool({
  description: '相对于 virtual-explorer 当前目录暂存删除操作。filePath 相对 explorer 当前目录。',
  inputSchema: z.object({ filePath: z.string(), lineIndex: z.array(z.array(z.number().int())) }),
  execute: async ({ filePath, lineIndex }) => {
    return callExecute(delPatch, { filePath: resolveExplorerPath(filePath), lineIndex });
  },
});

// ═════════════════════════════════════════════════════
// explorer-modify-patch
// ═════════════════════════════════════════════════════
export const explorerModifyPatch = tool({
  description: '相对于 virtual-explorer 当前目录暂存修改操作。filePath 相对 explorer 当前目录。',
  inputSchema: z.object({ filePath: z.string(), startLine: z.number().int(), endLine: z.number().int(), replaceLines: z.array(z.string()) }),
  execute: async ({ filePath, startLine, endLine, replaceLines }) => {
    return callExecute(modifyPatch, { filePath: resolveExplorerPath(filePath), startLine, endLine, replaceLines });
  },
});

// ═════════════════════════════════════════════════════
// explorer-execute-command
// ═════════════════════════════════════════════════════
export const explorerExecuteCommand = tool({
  description: '在 virtual-explorer 当前目录下执行一条系统命令。',
  inputSchema: z.object({ command: z.string() }),
  execute: async ({ command }) => {
    const explorerPath = getExplorerPath();
    return callExecute(executeCommandTool, { command: `cd /d "${explorerPath}" && ${command}` });
  },
});
