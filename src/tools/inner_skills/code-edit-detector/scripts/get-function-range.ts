import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import { resolvePath } from '../../../../workdir.js';
import { getParserByFileType, getSupportedFileTypes } from '../../code-reader/scripts/aux_parser/index';

export const getFunctionRange = tool({
  description: `按照函数名称返回整个函数体的所在行范围（起始行到结束行）。支持多种语言，自动识别函数/方法定义边界。
  参数 filePath 是文件的绝对路径或相对当前工作目录的路径。
  functionName 是函数名（支持 ClassName.methodName 格式指定类方法）。
  fileType 是文件的解析类型（即扩展名小写）。`,
  inputSchema: z.object({
    filePath: z.string().describe('目标文件的路径（绝对路径或相对当前工作目录的路径）'),
    functionName: z.string().describe('要查找的函数名（支持 ClassName.methodName 格式）'),
    fileType: z.string().describe('文件类型（扩展名小写），如 ts, js, py, c, cpp, java, html, vue'),
  }),
  execute: async ({ filePath, functionName, fileType }): Promise<string> => {
    try {
      const rawcontent = await fs.readFile(resolvePath(filePath), 'utf-8');
      const parser = getParserByFileType(fileType);

      if (!parser) {
        return `不支持解析的文件类型："${fileType}"，支持的类型：${getSupportedFileTypes().join(', ')}`;
      }

      parser.setContent(rawcontent, filePath);
      const funcs = parser.parseCode(rawcontent);

      // 解析函数名：支持 "ClassName.methodName" 格式
      let targetName = functionName;
      let targetClass: string | undefined;
      const dotIdx = functionName.indexOf('.');
      if (dotIdx !== -1) {
        targetClass = functionName.substring(0, dotIdx);
        targetName = functionName.substring(dotIdx + 1);
      }

      // 查找匹配的函数
      const matched = funcs.filter((f) => {
        const nameMatch = f.name === targetName;
        const classMatch = targetClass ? f.className === targetClass : true;
        return nameMatch && classMatch;
      });

      if (matched.length === 0) {
        if (targetClass) {
          return `未找到函数 ${targetClass}.${targetName}()`;
        }
        return `未找到函数 ${targetName}()`;
      }

      if (matched.length > 1) {
        const candidates = matched.map(
          (f) => `  ${f.className ? f.className + '.' : ''}${f.name}(${f.params.join(', ')}) (第 ${f.startLine} 行)`
        );
        return `发现多个同名函数，请使用 ClassName.methodName 指定:\n${candidates.join('\n')}`;
      }

      const func = matched[0];
      return JSON.stringify({
        name: func.name,
        className: func.className || null,
        startLine: func.startLine,
        endLine: func.endLine,
        type: func.type,
        params: func.params,
        returnType: func.returnType || null,
        body: func.body,
      });
    } catch (error) {
      return `查找失败: ${(error as Error).message}`;
    }
  },
});

