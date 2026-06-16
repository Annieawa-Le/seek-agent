/**
 * html_toolkit skill 入口
 * 提供 run_page、html-toolkit-prompt-get 等工具
 */
import { runPage } from './run-page';
import { htmlToolkitPromptGet } from './prompt-get';

const tools: Record<string, any> = {
  'run_page': runPage,
  'html-toolkit-prompt-get': htmlToolkitPromptGet,
};

export default tools;
