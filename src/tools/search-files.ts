import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'node:path';
import { match } from 'node:assert';
import { resolvePath } from '../workdir.js';

type FileEntry = {
  name: string;
  path: string;
};

async function getAllFiles(dirPath: string, recursion: boolean): Promise<FileEntry[]> {
  let results: FileEntry[] = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (recursion){
        const subFiles = await getAllFiles(fullPath, true);
        results = results.concat(subFiles);
      }else{
        results.push({
          name: "[文件夹]" + entry.name,
          path: fullPath
        });
      }
      } else {
        results.push({
          name: entry.name,
          path: fullPath
        });
      }
  }
  return results;
}

function matchesWildcard(name: string, pattern: string): boolean {
  // 将通配符模式转为正则
  const regexStr = '^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*') + '$';
  return new RegExp(regexStr, 'i').test(name);
}

function parseList(entryList:FileEntry[]): string{
  return JSON.stringify(entryList);
}


function parseNameList(entryList: FileEntry[]): string {
  return entryList.map(item => item.name).join('\n');
}

export const searchAllFile = tool({
  description: `搜索包括子文件夹在内的所有相关的文件。
  参数 filePath 类型string，是搜索的根文件夹路径；
  fileName 类型string，是要搜索的文件名或者正则表达式；
  useRegex 类型boolean, 为是否启用正则表达式搜索，false为关闭（使用文件名匹配），true为开启（使用正则表达式）
  返回的是一个包含文件名和路径信息的列表字符串。`,
  inputSchema: z.object({
    filePath: z.string(),
    fileName: z.string(),
    useRegex: z.boolean(),
  }),
  execute: async ({ filePath, fileName, useRegex}) : Promise<string>=> {
    try {
      const resolved = resolvePath(filePath);
      const fileList = await getAllFiles(resolved, true);
      if (useRegex) {
        try {
          const pattern = new RegExp(fileName);
          const filterList = fileList.filter(file => match(file.name, pattern)).slice(0, 15);
          return parseList(filterList);
        } catch (error) {
          return `无效的正则表达式 ${(error as any).message}`;
        }
      } else if (fileName.includes('*')) {
        const filterList = fileList.filter(file => matchesWildcard(file.name, fileName)).slice(0, 15);
        return parseList(filterList);
      } else {
        const filterList = fileList.filter(file => file.name.includes(fileName)).slice(0, 15);
        return parseList(filterList);
      }
    } catch (error) {
      return `读取文件失败: ${(error as any).message}`;
    }
  },
});

export const searchSubFile = tool({
  description: `仅搜索当前路径下的文件（不包含子文件夹）
  参数 filePath 类型string，是搜索的根文件夹路径；
  fileName 类型string，是要搜索的文件名或者正则表达式；
  useRegex 类型boolean, 为是否启用正则表达式搜索，false为关闭（使用文件名匹配），true为开启（使用正则表达式）
  返回的是一个包含文件名和路径信息的列表字符串。`,
  inputSchema: z.object({
    filePath: z.string(),
    fileName: z.string(),
    useRegex: z.boolean(),
  }),
  execute: async ({ filePath, fileName, useRegex}) : Promise<string>=> {
    try {
      const resolved = resolvePath(filePath);
      const fileList = await getAllFiles(resolved, false);
      if (useRegex) {
        try {
          const pattern = new RegExp(fileName);
          const filterList = fileList.filter(file => match(file.name, pattern));
          return parseList(filterList);
        } catch (error) {
          return `无效的正则表达式 ${(error as any).message}`;
        }
      } else if (fileName.includes('*')) {
        const filterList = fileList.filter(file => matchesWildcard(file.name, fileName));
        return parseList(filterList);
      } else {
        const filterList = fileList.filter(file => file.name.includes(fileName));
        return parseList(filterList);
      }
    } catch (error) {
      return `读取文件失败: ${(error as any).message}`;
    }
  },
});

async function getAllDirectories(dirPath: string): Promise<FileEntry[]> {
  let results: FileEntry[] = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push({
        name: entry.name,
        path: fullPath
      });
      const subDirs = await getAllDirectories(fullPath);
      results = results.concat(subDirs);
    }
  }
  return results;
}

export const searchDirectory = tool({
  description: `递归搜索指定路径下的所有子文件夹。
  参数 filePath 类型string，是搜索的根文件夹路径；
  返回的是一个包含文件夹名和路径信息的列表字符串。`,
  inputSchema: z.object({
    filePath: z.string(),
  }),
  execute: async ({ filePath }): Promise<string> => {
    try {
      const resolved = resolvePath(filePath);
      const dirList = await getAllDirectories(resolved);
      if (dirList.length > 15) {
        // 超过15项，只返回第一级子目录
        const entries = await fs.readdir(resolved, { withFileTypes: true });
        const topDirs: FileEntry[] = [];
        for (const entry of entries) {
          if (entry.isDirectory()) {
            topDirs.push({
              name: entry.name,
              path: path.join(resolved, entry.name)
            });
          }
        }
        return parseList(topDirs);
      }
      return parseList(dirList);
    } catch (error) {
      return `读取文件夹失败: ${(error as any).message}`;
    }
  },
});


export const searchContent = tool({
  description: `在指定文件中搜索特定内容，返回所有匹配行及其行号。
  参数 filePath 类型string，是目标文件的路径（绝对路径或相对当前工作目录的路径）；
  content 类型string，是要搜索的内容（支持普通字符串匹配）；
  useRegex 类型boolean, 为是否启用正则表达式搜索，false为关闭（使用普通字符串包含匹配），true为开启（使用正则表达式）
  返回的是一个字符串，每行包含"行号: 行内容"的格式。`,
  inputSchema: z.object({
    filePath: z.string(),
    content: z.string(),
    useRegex: z.boolean(),
  }),
  execute: async ({ filePath, content, useRegex }) : Promise<string> => {
    try {
      const resolved = resolvePath(filePath);
      const fileContent = await fs.readFile(resolved, 'utf-8');
      const lines = fileContent.split('\n');
      const resultLines: string[] = [];

      if (useRegex) {
        try {
          const pattern = new RegExp(content);
          for (let i = 0; i < lines.length; i++) {
            if (pattern.test(lines[i])) {
              resultLines.push(`${i + 1}: ${lines[i]}`);
            }
          }
        } catch (error) {
          return `无效的正则表达式 ${(error as any).message}`;
        }
      } else if (content.includes('*')) {
        for (let i = 0; i < lines.length; i++) {
          if (matchesWildcard(lines[i], content)) {
            resultLines.push(`${i + 1}: ${lines[i]}`);
          }
        }
      } else {
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(content)) {
            resultLines.push(`${i + 1}: ${lines[i]}`);
          }
        }
      }

      if (resultLines.length === 0) {
        return `未在文件 ${filePath} 中找到匹配内容"${content}"`;
      }

      return `在文件 ${filePath} 中找到 ${resultLines.length} 处匹配：\n` + resultLines.join('\n');
    } catch (error) {
      return `读取或搜索文件失败: ${(error as any).message}`;
    }
  },
});









