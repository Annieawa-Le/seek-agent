/**
 * frontend_helper skill 入口
 * 提供 generate_component、generate_styles、analyze_template、frontend-helper-prompt-get 等工具
 */
import { generateComponent } from './generate-component';
import { generateStyles } from './generate-styles';
import { analyzeTemplate } from './analyze-template';
import { frontendHelperPromptGet } from './prompt-get';

const tools: Record<string, any> = {
  'generate_component': generateComponent,
  'generate_styles': generateStyles,
  'analyze_template': analyzeTemplate,
  'frontend-helper-prompt-get': frontendHelperPromptGet,
};

export default tools;
