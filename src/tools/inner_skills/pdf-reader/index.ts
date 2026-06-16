/**
 * pdf-reader skill 入口
 * 提供 read_pdf、read_pdf_pages、pdf_info、pdf_extract_images、pdf_save_images、pdf-reader-prompt-get 等工具
 */
import { readPdf } from './read-pdf';
import { readPdfPages } from './read-pdf-pages';
import { pdfInfo } from './pdf-info';
import { pdfExtractImages, pdfSaveImages } from './pdf-image';
import { pdfReaderPromptGet } from './prompt-get';

const tools: Record<string, any> = {
  'read_pdf': readPdf,
  'read_pdf_pages': readPdfPages,
  'pdf_info': pdfInfo,
  'pdf_extract_images': pdfExtractImages,
  'pdf_save_images': pdfSaveImages,
  'pdf-reader-prompt-get': pdfReaderPromptGet,
};

export default tools;
