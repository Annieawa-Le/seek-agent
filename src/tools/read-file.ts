import { ToolOutput } from './tool-output';
import type { ReadFileBulk } from './raw-bulk-types';
import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import { resolvePath } from '../workdir.js';
import { patchStaging } from './patch-staging.js';
import { getPreviewBaseLines } from './file-manipulation.js';

export const readFileTool = tool({
  description: '读取文件内容。参数 filePath 是文件的绝对路径或相对当前工作目录的路径。',
  inputSchema: z.object({
    filePath: z.string(),
  }),
  execute: async ({ filePath }) => {
    try {
      const resolved = resolvePath(filePath);
      const content = await fs.readFile(resolved, 'utf-8');
      if (content.length > 50000) {
        const errText = `文件过大(${content.length} 字符)，请分行读取，或使用code-reader系列技能中的工具读取你需要的部分。\n或者利用 desk-add 钉在桌面方便查看和修改。`;
        const bulk: ReadFileBulk = { type: 'read', filePath, content: '', lineCount: 0, charCount: 0, error: errText, truncated: true };
        return new ToolOutput(bulk, errText);
      }
      const lineCount = content.split('\n').length;
      const bulk: ReadFileBulk = { type: 'read', filePath, content, lineCount, charCount: content.length };
      return new ToolOutput(bulk, content);
    } catch (error) {
      const errMsg = (error as any).message || '未知错误';
      const bulk: ReadFileBulk = { type: 'read', filePath, content: '', lineCount: 0, charCount: 0, error: errMsg };
      return new ToolOutput(bulk, `命令执行失败: ${errMsg}`);
    }
  },
});

export const readCertainLines = tool({
  description: `读取特定行范围的文件内容。
   filePath 是文件的绝对路径或相对当前工作目录的路径。
   startLine, endLine 分别是 int 类型整数，表示始末行号.`,
  inputSchema: z.object({
    filePath: z.string(),
    startLine: z.int(),
    endLine: z.int(),
  }),
  execute: async ({ filePath, startLine, endLine }) => {
    try {
      const resolved = resolvePath(filePath);
      const content = await fs.readFile(resolved, 'utf-8');
      const lines: string[] = content.split('\n');
      let result = '';
      for (let i = startLine; i <= endLine; i++) {
        result += (lines[i - 1] ?? '') + '\n';
      }
      const bulk: ReadFileBulk = { type: 'read', filePath, content: result, lineCount: endLine - startLine + 1, charCount: result.length, startLine, endLine };
      return new ToolOutput(bulk, result);
    } catch (error) {
      const errMsg = (error as any).message || '未知错误';
      const bulk: ReadFileBulk = { type: 'read', filePath, content: '', lineCount: 0, charCount: 0, error: errMsg };
      return new ToolOutput(bulk, `命令执行失败: ${errMsg}`);
    }
  },
});

export const readNumline = tool({
  description: `读取带行号的特定行范围的文件内容。
   filePath 是文件的绝对路径或相对当前工作目录的路径。
   startLine, endLine 分别是 int 类型整数，表示始末行号.
   resume 为 true 时行号基于暂存区中所有未应用 patch 模拟后的文件状态，续批模式。`,
  inputSchema: z.object({
    filePath: z.string(),
    startLine: z.int(),
    endLine: z.int(),
    resume: z.boolean().optional().default(false).describe('续批模式：基于暂存区所有未应用 patch 模拟后的文件状态'),
  }),
  execute: async ({ filePath, startLine, endLine, resume }) => {
    try {
      const resolved = resolvePath(filePath);

      let lines: string[];
      if (resume) {
        const sessionPatches = patchStaging.getByFile(resolved)
          .filter(p => p.sessionId === patchStaging.getSessionId());
        const { lines: previewLines } = await getPreviewBaseLines(resolved, true, sessionPatches);
        lines = previewLines;
      } else {
        const content = await fs.readFile(resolved, 'utf-8');
        lines = content.split('\n');
      }

      let result = '';
      for (let i = startLine; i <= endLine; i++) {
        const lineNum = String(i).padStart(4, ' ');
        result += `${lineNum}: ${lines[i - 1] ?? ''}\n`;
      }
      const numberedLines = lines.slice(startLine - 1, endLine).map((line, idx) => ({
        lineNum: startLine + idx,
        content: line,
      }));
      const bulk: ReadFileBulk = { type: 'read', filePath, content: result, lineCount: endLine - startLine + 1, charCount: result.length, startLine, endLine, numberedLines };
      return new ToolOutput(bulk, result);
    } catch (error) {
      const errMsg = (error as any).message || '未知错误';
      const bulk: ReadFileBulk = { type: 'read', filePath, content: '', lineCount: 0, charCount: 0, error: errMsg };
      return new ToolOutput(bulk, `命令执行失败: ${errMsg}`);
    }
  },
});

export const scanFileTool = tool({
  description: `扫描大文件并返回完整内容（默认带行号）。
  注意！调用的前提必须是作为参考，几乎不会修改的文件！
  参数 filePath 是文件的绝对路径或相对当前工作目录的路径。`,
  inputSchema: z.object({
    filePath: z.string(),
  }),
  execute: async ({ filePath }) => {
    try {
      const resolved = resolvePath(filePath);
      const content = await fs.readFile(resolved, 'utf-8');
      const lines = content.split('\n');
      let result = '';
      for (let i = 0; i < lines.length; i++) {
        const lineNum = String(i + 1).padStart(4, ' ');
        result += `${lineNum}: ${lines[i]}\n`;
      }
      const numberedLines = lines.map((line, idx) => ({ lineNum: idx + 1, content: line }));
      const bulk: ReadFileBulk = { type: 'read', filePath, content: result, lineCount: lines.length, charCount: result.length, numberedLines };
      return new ToolOutput(bulk, result);
    } catch (error) {
      const errMsg = (error as any).message || '未知错误';
      const bulk: ReadFileBulk = { type: 'read', filePath, content: '', lineCount: 0, charCount: 0, error: errMsg };
      return new ToolOutput(bulk, `命令执行失败: ${errMsg}`);
    }
  },
});
