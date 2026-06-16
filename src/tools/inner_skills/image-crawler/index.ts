/**
 * image_crawler skill 入口
 * 提供 extract_images、filter_images、download_images、image-crawler-prompt-get 等工具
 */
import { extractImages } from './scripts/extract-images';
import { filterImages } from './scripts/filter-images';
import { downloadImages } from './scripts/download-images';
import { imageCrawlerPromptGet } from './scripts/prompt-get';

const tools: Record<string, any> = {
  'extract_images': extractImages,
  'filter_images': filterImages,
  'download_images': downloadImages,
  'image-crawler-prompt-get': imageCrawlerPromptGet,
};

export default tools;
