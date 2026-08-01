/**
 * browser-control skill 入口
 * 真实浏览器驱动（playwright-core + 系统 Edge/Chrome），单例常驻可多轮持续操作页面。
 * 提供 launch/navigate/click/type/press/scroll/extract/screenshot/execute_js/wait/status/close 等工具。
 */
import { browserLaunch } from './scripts/launch';
import { browserNavigate } from './scripts/navigate';
import { browserClick } from './scripts/click';
import { browserType } from './scripts/type';
import { browserPress } from './scripts/press';
import { browserScroll } from './scripts/scroll';
import { browserExtract } from './scripts/extract';
import { browserScreenshot } from './scripts/screenshot';
import { browserExecuteJs } from './scripts/execute-js';
import { browserWait } from './scripts/wait';
import { browserStatus } from './scripts/status';
import { browserClose } from './scripts/close';
import { browserTabs, browserSwitchTab } from './scripts/tabs';
import { browserControlPromptGet } from './scripts/prompt-get';

const tools: Record<string, any> = {
  'browser_launch': browserLaunch,
  'browser_navigate': browserNavigate,
  'browser_click': browserClick,
  'browser_type': browserType,
  'browser_press': browserPress,
  'browser_scroll': browserScroll,
  'browser_extract': browserExtract,
  'browser_screenshot': browserScreenshot,
  'browser_execute_js': browserExecuteJs,
  'browser_wait': browserWait,
  'browser_status': browserStatus,
  'browser_close': browserClose,
  'browser_tabs': browserTabs,
  'browser_switch_tab': browserSwitchTab,
  'browser-control-prompt-get': browserControlPromptGet,
};

export default tools;

