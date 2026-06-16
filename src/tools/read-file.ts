import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import { resolvePath } from '../workdir.js';
import { patchStaging } from './patch-staging.js';
import { getPreviewBaseLines } from './file-manipulation.js';
// import { start } from 'repl';


export const readFileTool = tool({
  description: '读取文件内容。参数 filePath 是文件的绝对路径或相对当前工作目录的路径。',
  inputSchema: z.object({
    filePath: z.string(),
  }),
  execute: async ({ filePath }): Promise<string> => {
    try {
      const resolved = resolvePath(filePath);
      const content = await fs.readFile(resolved, 'utf-8');
      if(content.length > 50000){
        return `文件过大(${content.length} 字符)，请分行读取，或使用code-reader系列技能中的工具读取你需要的部分。
        或者利用 desk-add 钉在桌面方便查看和修改。`;
      }
      return content;
    } catch (error) {
      return `命令执行失败: ${(error as any).message}`;
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
  execute: async ({ filePath, startLine, endLine }) : Promise<string>=> {
    try {
      const resolved = resolvePath(filePath);
      const content = await fs.readFile(resolved, 'utf-8');
      let lines: string[] = content.split("\n");
      let result: string = '';
      for(let i = startLine; i <= endLine; i++){
        result = result + (lines[i-1] ?? '') + '\n'
      }
      return result
    } catch (error) {
      return `命令执行失败: ${(error as any).message}`;
    }
  },
});
export const readNumline = tool({
  /**
   * read_num_line
   * 读取带行号的特定行范围的文件内容。
   * filePath 是文件的绝对路径或相对当前工作目录的路径。
   * startLine, endLine 分别是 int 类型整数，表示始末行号.
   * resume 为 true 时行号基于暂存区中所有未应用 patch 模拟后的文件状态，续批模式。
   */
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
  execute: async ({ filePath, startLine, endLine, resume }) : Promise<string>=> {
    try {
      const resolved = resolvePath(filePath);

      // 续批模式：从暂存区获取模拟后的文件状态
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

      let result: string = '';
      for(let i = startLine; i <= endLine; i++){
        // 显示行号，对齐格式
        const lineNum = String(i).padStart(4, ' ');
        result = result + `${lineNum}: ${lines[i-1] ?? ''}\n`;
      }
      return result;
    } catch (error) {
      return `命令执行失败: ${(error as any).message}`;
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
  execute: async ({ filePath }): Promise<string> => {
    try {
      const resolved = resolvePath(filePath);
      const content = await fs.readFile(resolved, 'utf-8');
      const lines = content.split('\n');
      let result = '';
      for (let i = 0; i < lines.length; i++) {
        const lineNum = String(i + 1).padStart(4, ' ');
        result += `${lineNum}: ${lines[i]}\n`;
      }
      return result;
    } catch (error) {
      return `命令执行失败: ${(error as any).message}`;
    }
  },
});





