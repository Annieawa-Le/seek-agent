/**
 * web_accessor skill 入口
 * 提供 tavily_search、tavily_extract、tavily_crawl、tavily_map、tavily_research、web-accessor-prompt-get 等工具
 */
import { tavilySearch } from './tavily-search';
import { tavilyExtract } from './tavily-extract';
import { tavilyCrawl } from './tavily-crawl';
import { tavilyMap } from './tavily-map';
import { tavilyResearch } from './tavily-research';
import { webAccessorPromptGet } from './prompt-get';

const tools: Record<string, any> = {
  'tavily_search': tavilySearch,
  'tavily_extract': tavilyExtract,
  'tavily_crawl': tavilyCrawl,
  'tavily_map': tavilyMap,
  'tavily_research': tavilyResearch,
  'web-accessor-prompt-get': webAccessorPromptGet,
};

export default tools;
