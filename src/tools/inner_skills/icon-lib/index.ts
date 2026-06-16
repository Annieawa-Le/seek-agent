/**
 * icon_lib skill 入口
 * 提供 search_icons、get_icon_detail、list_all_icons、icon-lib-prompt-get 等工具
 */
import { searchIcons } from './search-icons';
import { getIconDetail } from './get-icon-detail';
import { listAllIcons } from './list-all-icons';
import { iconLibPromptGet } from './prompt-get';

const tools: Record<string, any> = {
  'search_icons': searchIcons,
  'get_icon_detail': getIconDetail,
  'list_all_icons': listAllIcons,
  'icon-lib-prompt-get': iconLibPromptGet,
};

export default tools;
