/**
 * image_identifier skill 入口
 * 提供 image_info、extract_image_text、vision_analyze、image-identifier-prompt-get 等工具
 */
import { imageInfo } from './scripts/image-info';
import { extractImageText } from './scripts/extract-image-text';
import { visionAnalyze } from './scripts/vision-analyze';
import { imageIdentifierPromptGet } from './scripts/prompt-get';

const tools: Record<string, any> = {
  'image_info': imageInfo,
  'extract_image_text': extractImageText,
  'vision_analyze': visionAnalyze,
  'image-identifier-prompt-get': imageIdentifierPromptGet,
};

export default tools;
