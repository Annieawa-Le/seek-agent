import { BaseParser } from './base-parser';
import { CFunctionParser } from './c-parser';
import { TsFunctionParser } from './ts-parser';
import { PyFunctionParser } from './py-parser';
import { HtmlParser } from './html-parser';

export type { FunctionInfo } from './types';
export { BaseParser } from './base-parser';
export { TsFunctionParser } from './ts-parser';
export { PyFunctionParser } from './py-parser';
export { CFunctionParser } from './c-parser';
export { HtmlParser } from './html-parser';
export type { TagInfo, ScriptBlockInfo } from './html-parser';

/**
 * 根据文件类型获取对应的解析器实例
 * @param fileType 文件类型（扩展名，小写）
 * @returns 解析器实例，如果不支持则返回 null
 */
export function getParserByFileType(fileType: string): BaseParser | null {
  const type = fileType.toLowerCase();
  if (['c', 'h', 'cpp', 'java'].includes(type)) {
    return new CFunctionParser('');
  } else if (['js', 'ts', 'jsx', 'tsx'].includes(type)) {
    return new TsFunctionParser();
  } else if (['py'].includes(type)) {
    return new PyFunctionParser();
  } else if (['html', 'htm'].includes(type)) {
    return new HtmlParser();
  }
  return null;
}

/**
 * 获取支持的文件类型列表
 */
export function getSupportedFileTypes(): string[] {
  return ['c', 'h', 'cpp', 'java', 'js', 'ts', 'jsx', 'tsx', 'py', 'html', 'htm'];
}

