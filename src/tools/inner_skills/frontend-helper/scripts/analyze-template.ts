import { tool } from 'ai';
import { z } from 'zod';
import * as parse5 from 'parse5';

/* ============ 类型定义 ============ */

interface Issue {
  type: 'error' | 'warning' | 'info';
  category: 'semantics' | 'accessibility' | 'nesting' | 'best-practice';
  message: string;
  suggestion?: string;
}

/* ============ 检查器 ============ */

function checkSemantics(issues: Issue[], node: any, path: string): void {
  const tag = node.nodeName?.toLowerCase();
  if (!tag || tag === '#text' || tag === '#comment') return;

  const attrs = getAttrs(node);

  // 检查用 div/span 替代了语义标签
  if (tag === 'div') {
    const text = getTextContent(node).trim();
    if (text.length > 0 && !hasBlockChild(node)) {
      issues.push({
        type: 'info',
        category: 'semantics',
        message: showMsg(path) + ' 中的 <div> 仅包含文本，考虑用 <p> 或 <section>',
        suggestion: '将 <div> 替换为 <p>（段落）或 <section>（区域）',
      });
    }
  }

  // 标题层级跳跃
  if (/^h[1-6]$/.test(tag)) {
    const level = parseInt(tag[1]);
    const tags = path.split(' > ');
    for (let i = tags.length - 2; i >= 0; i--) {
      const pm = tags[i].match(/^h([1-6])$/);
      if (pm) {
        const prevLevel = parseInt(pm[1]);
        if (level - prevLevel > 1) {
          issues.push({
            type: 'warning',
            category: 'semantics',
            message: '标题层级跳跃: <' + tag + '> 在 <h' + prevLevel + '> 之后（跳过了 h' + (prevLevel + 1) + '）',
            suggestion: '将 <' + tag + '> 改为 <h' + (prevLevel + 1) + '>，或调整标题层级使之连续',
          });
        }
        break;
      }
    }
  }

  // class/id 含 nav 但没用 <nav>
  const classOrId = (attrs['class'] || '') + ' ' + (attrs['id'] || '');
  if ((classOrId.includes('nav') || classOrId.includes('menu')) && tag !== 'nav') {
    issues.push({
      type: 'info',
      category: 'semantics',
      message: showMsg(path) + ' 的 class/id 含 "nav"/"menu" 但用了 <' + tag + '>，建议用 <nav>',
      suggestion: '将 <' + tag + '> 替换为 <nav> 提高语义表达',
    });
  }

  // 检查 <main> 是否唯一
  if (tag === 'main') {
    // 粗略通过 path 统计 main 出现次数
    const mainCount = (path.match(/> main/g) || []).length;
    if (mainCount > 1) {
      issues.push({
        type: 'warning',
        category: 'semantics',
        message: '页面中出现了多个 <main> 元素',
        suggestion: '每个页面只能有一个 <main>，将多余的改为 <div role="main">',
      });
    }
  }
}

function checkAccessibility(issues: Issue[], node: any, path: string): void {
  const tag = node.nodeName?.toLowerCase();
  if (!tag || tag === '#text' || tag === '#comment') return;

  const attrs = getAttrs(node);

  // img 必须要有 alt
  if (tag === 'img' && !('alt' in attrs)) {
    issues.push({
      type: 'error',
      category: 'accessibility',
      message: '<img> 缺少 alt 属性（' + showMsg(path) + '）',
      suggestion: '添加 alt="图片描述"，装饰性图片用 alt=""',
    });
  }

  // input 应有 label 或 aria-label
  if (tag === 'input' && attrs['type'] !== 'hidden' && attrs['type'] !== 'submit') {
    if (!attrs['aria-label'] && !attrs['aria-labelledby']) {
      issues.push({
        type: 'warning',
        category: 'accessibility',
        message: '<input> 缺少关联 label 或 aria-label（' + showMsg(path) + '）',
        suggestion: '添加 <label for="' + (attrs['id'] || 'input-id') + '">标签</label> 或 aria-label="' + (attrs['name'] || '输入') + '"',
      });
    }
  }

  // button 应有文本
  if (tag === 'button' && !getTextContent(node).trim() && !attrs['aria-label']) {
    issues.push({
      type: 'warning',
      category: 'accessibility',
      message: '<button> 没有文本内容或 aria-label',
      suggestion: '添加按钮文本，或设置 aria-label="功能描述"',
    });
  }

  // a 链接需要文本
  if (tag === 'a' && attrs['href']) {
    if (!getTextContent(node).trim() && !attrs['aria-label']) {
      issues.push({
        type: 'warning',
        category: 'accessibility',
        message: '<a href="' + attrs['href'] + '"> 没有文本内容',
        suggestion: '添加链接文本，或设置 aria-label="链接描述"',
      });
    }
    if (attrs['href'] === '#' || attrs['href'] === 'javascript:void(0)') {
      issues.push({
        type: 'info',
        category: 'accessibility',
        message: '<a href="' + attrs['href'] + '"> 对键盘导航和 SEO 不友好',
        suggestion: '使用 <button> 代替按钮行为，或使用真实 URL',
      });
    }
  }

  // html lang 属性
  if (tag === 'html' && !('lang' in attrs)) {
    issues.push({
      type: 'warning',
      category: 'accessibility',
      message: '<html> 缺少 lang 属性',
      suggestion: '添加 lang="zh-CN" 指定页面语言',
    });
  }

  // tabindex > 0
  if ('tabindex' in attrs && parseInt(attrs['tabindex']) > 0) {
    issues.push({
      type: 'warning',
      category: 'accessibility',
      message: 'tabindex="' + attrs['tabindex'] + '" > 0 会破坏自然 Tab 顺序',
      suggestion: '使用 tabindex="0"（按 DOM 顺序）或调整 DOM 结构',
    });
  }

  // aria-hidden 在交互元素上
  if (attrs['aria-hidden'] === 'true' && (tag === 'button' || tag === 'a' || tag === 'input')) {
    issues.push({
      type: 'warning',
      category: 'accessibility',
      message: '<' + tag + '> 设置了 aria-hidden="true" 但本身是可交互元素',
      suggestion: '移除 aria-hidden 或使用 disabled / hidden 属性',
    });
  }
}

function checkNesting(issues: Issue[], node: any, path: string, depth: number): void {
  const tag = node.nodeName?.toLowerCase();
  if (!tag || tag === '#text' || tag === '#comment') return;

  const MAX_DEPTH = 10;

  // 嵌套深度警告
  if (depth > MAX_DEPTH) {
    issues.push({
      type: 'warning',
      category: 'nesting',
      message: '嵌套深度过深（' + depth + ' 层）: ' + showMsg(path),
      suggestion: '拆分组件或使用 CSS 选择器减少 DOM 嵌套，超过 ' + MAX_DEPTH + ' 层影响可维护性',
    });
  }

  const children = node.childNodes || [];

  // <p> 不能包含块级元素
  if (tag === 'p') {
    const blocks = findBlockChildren(node);
    if (blocks.length > 0) {
      issues.push({
        type: 'error',
        category: 'nesting',
        message: '<p> 中不能包含块级元素: <' + blocks.join('>, <') + '>',
        suggestion: '将 <p> 替换为 <div>，或将块级子元素移到 <p> 外',
      });
    }
  }

  // <ul>/<ol> 的直接子元素必须是 <li>
  if (tag === 'ul' || tag === 'ol') {
    for (const child of children) {
      if (child.nodeName === '#text' && child.value?.trim()) {
        issues.push({
          type: 'error',
          category: 'nesting',
          message: '<' + tag + '> 中不能有直接文本，必须放在 <li> 中',
          suggestion: '用 <li> 包裹文本内容',
        });
        break;
      }
    }
  }

  // a 不能嵌套 a
  if (tag === 'a') {
    const tags = path.split(' > ');
    for (let i = tags.length - 2; i >= 0; i--) {
      if (tags[i] === 'a') {
        issues.push({
          type: 'error',
          category: 'nesting',
          message: '<a> 不能嵌套在另一个 <a> 中',
          suggestion: '拆分链接结构，避免嵌套',
        });
        break;
      }
    }
  }

  // button 不能在 a 中
  if (tag === 'button') {
    const tags = path.split(' > ');
    if (tags.slice(0, -1).includes('a')) {
      issues.push({
        type: 'error',
        category: 'nesting',
        message: '<button> 嵌套在 <a> 中不合法',
        suggestion: '选择使用 <button> 或 <a>，不要嵌套',
      });
    }
  }

  // form 不能嵌套 form
  if (tag === 'form') {
    const tags = path.split(' > ');
    let count = 0;
    for (const t of tags) { if (t === 'form') count++; }
    if (count > 1) {
      issues.push({
        type: 'error',
        category: 'nesting',
        message: '<form> 不能嵌套在另一个 <form> 中',
        suggestion: '拆分或合并表单结构',
      });
    }
  }
}

function checkBestPractices(issues: Issue[], node: any, path: string): void {
  const tag = node.nodeName?.toLowerCase();
  if (!tag || tag === '#text' || tag === '#comment') return;

  const attrs = getAttrs(node);

  // 内联样式
  if ('style' in attrs && attrs['style']) {
    issues.push({
      type: 'info',
      category: 'best-practice',
      message: '<' + tag + '> 使用了内联 style 属性（' + showMsg(path) + '）',
      suggestion: '将样式提取到 CSS 类中',
    });
  }

  // 已废弃的 HTML 属性
  const deprecatedAttrs = ['align', 'bgcolor', 'cellpadding', 'cellspacing', 'border'];
  const found = deprecatedAttrs.filter(a => a in attrs);
  if (found.length > 0) {
    issues.push({
      type: 'warning',
      category: 'best-practice',
      message: '<' + tag + '> 使用了已废弃属性: ' + found.join(', '),
      suggestion: '用 CSS 代替（如 text-align, background-color, padding, border-spacing）',
    });
  }

  // 空的 src/href
  if ((tag === 'img' || tag === 'script') && attrs['src'] === '') {
    issues.push({
      type: 'error',
      category: 'best-practice',
      message: '<' + tag + '> 的 src 为空',
      suggestion: '提供有效的 src URL 或移除该元素',
    });
  }
  if (tag === 'a' && attrs['href'] === '') {
    issues.push({
      type: 'warning',
      category: 'best-practice',
      message: '<a> 的 href 为空',
      suggestion: '提供有效 URL 或使用 <button>',
    });
  }

  // <script> 在 <head> 中无 async/defer
  if (tag === 'script' && attrs['src'] && !('async' in attrs) && !('defer' in attrs)) {
    if (path.includes('head')) {
      issues.push({
        type: 'info',
        category: 'best-practice',
        message: '<script src="' + attrs['src'] + '"> 在 <head> 中且没有 async/defer',
        suggestion: '添加 defer 属性，让脚本在 HTML 解析完成后执行',
      });
    }
  }

  // 检查冗余的 type="text/javascript" / type="text/css"
  if (tag === 'script' && attrs['type'] === 'text/javascript') {
    issues.push({
      type: 'info',
      category: 'best-practice',
      message: '<script> 的 type="text/javascript" 是冗余的（HTML5 默认）',
      suggestion: '移除 type 属性',
    });
  }
  if (tag === 'style' && attrs['type'] === 'text/css') {
    issues.push({
      type: 'info',
      category: 'best-practice',
      message: '<style> 的 type="text/css" 是冗余的（HTML5 默认）',
      suggestion: '移除 type 属性',
    });
  }
}

/* ============ 辅助函数 ============ */

function getAttrs(node: any): Record<string, string> {
  if (!node.attrs) return {};
  const result: Record<string, string> = {};
  for (const attr of node.attrs) {
    result[attr.name] = attr.value;
  }
  return result;
}

function getTextContent(node: any): string {
  if (!node.childNodes) return '';
  let text = '';
  for (const child of node.childNodes) {
    if (child.nodeName === '#text') text += child.value || '';
    else text += getTextContent(child);
  }
  return text;
}

function hasBlockChild(node: any): boolean {
  const blocks = new Set(['div', 'p', 'ul', 'ol', 'table', 'form', 'section', 'header', 'footer', 'nav', 'aside', 'main', 'figure', 'blockquote', 'hr']);
  for (const child of (node.childNodes || [])) {
    if (blocks.has(child.nodeName?.toLowerCase())) return true;
  }
  return false;
}

function findBlockChildren(node: any): string[] {
  const blocks = new Set(['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'form', 'section', 'article', 'header', 'footer', 'nav', 'aside', 'main', 'figure', 'blockquote', 'hr']);
  const result: string[] = [];
  for (const child of (node.childNodes || [])) {
    const tag = child.nodeName?.toLowerCase();
    if (tag && blocks.has(tag)) result.push(tag);
  }
  return result;
}

function showMsg(path: string): string {
  return path || 'root';
}

/* ============ 遍历 ============ */

function walk(
  node: any,
  path: string,
  depth: number,
  issues: Issue[],
  checkers: Array<(issues: Issue[], node: any, path: string, depth: number) => void>,
): void {
  if (!node) return;
  const tag = node.nodeName?.toLowerCase();
  const currentPath = tag && tag !== '#document' && tag !== '#document-fragment'
    ? (path ? path + ' > ' + tag : tag)
    : path;

  if (tag !== '#document' && tag !== '#document-fragment' && tag !== '#text' && tag !== '#comment') {
    for (const checker of checkers) {
      checker(issues, node, currentPath, depth);
    }
  }

  if (node.childNodes) {
    for (const child of node.childNodes) {
      walk(child, currentPath, depth + 1, issues, checkers);
    }
  }
}

/* ============ 主入口 ============ */

export const analyzeTemplate = tool({
  description: '分析 HTML/模板代码的结构层级，检测常见的可访问性（ARIA）、语义化标签使用、嵌套深度等问题，并给出改进建议。',
  inputSchema: z.object({
    content: z.string().describe('HTML 或模板代码内容'),
    checks: z.string().describe('检查项目，逗号分隔: semantics / accessibility / nesting / best-practice / all（默认 all）'),
  }),
  execute: async ({ content, checks }): Promise<string> => {
    if (!content || content.trim().length === 0) {
      return '❌ 请提供需要分析的 HTML 内容。';
    }

    const checkItems = (checks || 'all').toLowerCase().split(',').map(s => s.trim());
    const runAll = checkItems.includes('all');

    type CheckerFn = (issues: Issue[], node: any, path: string, depth: number) => void;
    const checkers: Array<{ name: string; label: string; fn: CheckerFn }> = [];

    if (runAll || checkItems.includes('semantics')) {
      checkers.push({ name: 'semantics', label: '语义化', fn: checkSemantics });
    }
    if (runAll || checkItems.includes('accessibility')) {
      checkers.push({ name: 'accessibility', label: '可访问性', fn: checkAccessibility });
    }
    if (runAll || checkItems.includes('nesting')) {
      checkers.push({ name: 'nesting', label: '嵌套结构', fn: checkNesting });
    }
    if (runAll || checkItems.includes('best-practice') || checkItems.includes('best_practice')) {
      checkers.push({ name: 'best-practice', label: '最佳实践', fn: checkBestPractices });
    }

    if (checkers.length === 0) {
      return '❌ 不支持的检查项目: "' + checks + '"。支持: semantics, accessibility, nesting, best-practice, all';
    }

    let document: any;
    try {
      document = parse5.parse(content, { sourceCodeLocationInfo: true });
    } catch (e: any) {
      return '❌ HTML 解析失败: ' + (e.message || e);
    }

    const issues: Issue[] = [];
    const checkFns = checkers.map(c => c.fn);
    walk(document, '', 0, issues, checkFns);

    const totalLines = content.split('\n').length;

    const lines: string[] = [
      '📄 HTML 分析报告',
      '━'.repeat(30),
      '📊 代码行数: ' + totalLines + ' 行',
      issues.length === 0
        ? '✅ 未发现问题，HTML 结构良好！'
        : '🔍 共发现 ' + issues.length + ' 个问题',
      '',
    ];

    // 按类别分组
    const byType: Record<string, Issue[]> = {};
    for (const issue of issues) {
      if (!byType[issue.category]) byType[issue.category] = [];
      byType[issue.category].push(issue);
    }

    const categoryLabels: Record<string, string> = {
      semantics: '🏷️ 语义化检查',
      accessibility: '♿ 可访问性检查',
      nesting: '🪆 嵌套结构检查',
      'best-practice': '💡 最佳实践检查',
    };

    const severityOrder: Record<string, number> = { error: 0, warning: 1, info: 2 };

    for (const checker of checkers) {
      const catIssues = byType[checker.name] || [];
      if (catIssues.length === 0) continue;

      lines.push('--- ' + (categoryLabels[checker.name] || checker.name) + ' ---');

      catIssues.sort((a, b) => (severityOrder[a.type] || 2) - (severityOrder[b.type] || 2));
      for (const issue of catIssues) {
        const icon = issue.type === 'error' ? '❌' : issue.type === 'warning' ? '⚠️' : '💁';
        lines.push('  ' + icon + ' [' + issue.type + '] ' + issue.message);
        if (issue.suggestion) {
          lines.push('      💡 建议: ' + issue.suggestion);
        }
      }
      lines.push('');
    }

    const errorCount = issues.filter(i => i.type === 'error').length;
    const warningCount = issues.filter(i => i.type === 'warning').length;
    const infoCount = issues.filter(i => i.type === 'info').length;

    lines.push('📋 汇总: ' + errorCount + ' 个错误, ' + warningCount + ' 个警告, ' + infoCount + ' 个建议');
    if (errorCount > 0 || warningCount > 0) {
      lines.push('', '💡 建议优先修复错误和警告级别的可访问性问题。');
    }

    return lines.join('\n');
  },
});

