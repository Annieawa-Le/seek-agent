import { tools } from './src/tools/index.ts';

console.log('vision_analyze:', 'vision_analyze' in tools);
console.log('image_info:', 'image_info' in tools);
console.log('extract_image_text:', 'extract_image_text' in tools);

// Also check the count
const imageTools = Object.keys(tools).filter(k => k.includes('image') || k.includes('vision'));
console.log('image/vision tools:', imageTools);
