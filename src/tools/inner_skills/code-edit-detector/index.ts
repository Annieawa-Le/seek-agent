/**
 * code_edit_detector skill 入口
 * 提供 get_function_range、find_matching_brace、wrap_by、wrap_by_label、find_matching_label、code-edit-detector-prompt-get 等工具
 */
import { getFunctionRange } from './scripts/get-function-range';
import { findMatchingBrace } from './scripts/find-matching-brace';
import { wrapBy } from './scripts/wrap-by';
import { wrapByLabel } from './scripts/wrap-by-label';
import { findMatchingLabel } from './scripts/find-matching-label';
import { codeEditDetectorPromptGet } from './scripts/prompt-get';

const tools: Record<string, any> = {
  'get_function_range': getFunctionRange,
  'find_matching_brace': findMatchingBrace,
  'wrap_by': wrapBy,
  'wrap_by_label': wrapByLabel,
  'find_matching_label': findMatchingLabel,
  'code-edit-detector-prompt-get': codeEditDetectorPromptGet,
};

export default tools;

