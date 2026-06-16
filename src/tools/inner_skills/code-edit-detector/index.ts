/**
 * code_edit_detector skill 入口
 * 提供 get_function_range、find_matching_brace、wrap_by、code-edit-detector-prompt-get 等工具
 */
import { getFunctionRange } from './scripts/get-function-range';
import { findMatchingBrace } from './scripts/find-matching-brace';
import { wrapBy } from './scripts/wrap-by';
import { codeEditDetectorPromptGet } from './scripts/prompt-get';

const tools: Record<string, any> = {
  'get_function_range': getFunctionRange,
  'find_matching_brace': findMatchingBrace,
  'wrap_by': wrapBy,
  'code-edit-detector-prompt-get': codeEditDetectorPromptGet,
};

export default tools;


