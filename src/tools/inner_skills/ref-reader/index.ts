/**
 * ref_reader skill 入口
 * 提供 list_refs、read_ref、search_ref、find_ref、ref-reader-prompt-get 等工具
 */
import { listRefs } from './scripts/list-refs';
import { readRef } from './scripts/read-ref';
import { searchRef } from './scripts/search-ref';
import { findRef } from './scripts/find-ref';
import { refReaderPromptGet } from './scripts/prompt-get';

const tools: Record<string, any> = {
  'list_refs': listRefs,
  'read_ref': readRef,
  'search_ref': searchRef,
  'find_ref': findRef,
  'ref-reader-prompt-get': refReaderPromptGet,
};

export default tools;
