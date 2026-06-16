/**
 * web_crawler skill 入口
 * 提供 fetch_page、crawl_site、extract_links、search_web、web-crawler-prompt-get 等工具
 */
import { fetchPage } from './fetch-page';
import { crawlSite } from './crawl-site';
import { extractLinks } from './extract-links';
import { searchWeb } from './search-web';
import { webCrawlerPromptGet } from './prompt-get';

const tools: Record<string, any> = {
  'fetch_page': fetchPage,
  'crawl_site': crawlSite,
  'extract_links': extractLinks,
  'search_web': searchWeb,
  'web-crawler-prompt-get': webCrawlerPromptGet,
};

export default tools;
