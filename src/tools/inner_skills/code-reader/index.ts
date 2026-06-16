/**
 * code-reader skill 入口
 * 提供代码分析相关工具：扫描函数、类、读取详细信息等
 */
import {
  scanningFunction,
  readFunction,
  scanningClass,
  readClass,
  readPackage,
  scanningTag,
  scanningScript,
  jumpToDefinition,
  codeReaderPromptGet,
} from './read-code';

const tools: Record<string, any> = {
  scanning_function: scanningFunction,
  scanning_class: scanningClass,
  read_function: readFunction,
  read_class: readClass,
  read_package: readPackage,
  scanning_tag: scanningTag,
  scanning_script: scanningScript,
  jump_to_definition: jumpToDefinition,
  'code-reader-prompt-get': codeReaderPromptGet,
};


export default tools;


