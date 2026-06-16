/**
 * web_accessor skill 入口
 * 提供 tavily_search、tavily_extract、tavily_crawl、tavily_map、tavily_research、web-accessor-prompt-get 等工具
 */
import { tavilySearch } from './scripts/tavily-search';
import { tavilyExtract } from './scripts/tavily-extract';
import { tavilyCrawl } from './scripts/tavily-crawl';
import { tavilyMap } from './scripts/tavily-map';
import { tavilyResearch } from './scripts/tavily-research';
import { webAccessorPromptGet } from './scripts/prompt-get';

const tools: Record<string, any> = {
  'tavily_search': tavilySearch,
  'tavily_extract': tavilyExtract,
  'tavily_crawl': tavilyCrawl,
  'tavily_map': tavilyMap,
  'tavily_research': tavilyResearch,
  'web-accessor-prompt-get': webAccessorPromptGet,
};

export default tools;
