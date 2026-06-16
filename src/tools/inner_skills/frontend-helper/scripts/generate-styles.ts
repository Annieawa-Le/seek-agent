import { tool } from 'ai';
import { z } from 'zod';

type Format = 'css' | 'scss' | 'tailwind';

interface StyleIntent {
  display?: string;
  flexDirection?: 'row' | 'column' | 'row-reverse' | 'column-reverse';
  justifyContent?: 'center' | 'flex-start' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly';
  alignItems?: 'center' | 'flex-start' | 'flex-end' | 'stretch' | 'baseline';
  flexWrap?: 'wrap' | 'nowrap' | 'wrap-reverse';
  gap?: string;
  gridColumns?: string;
  gridRows?: string;

  position?: 'relative' | 'absolute' | 'fixed' | 'sticky' | 'static';
  top?: string;
  right?: string;
  bottom?: string;
  left?: string;

  width?: string;
  height?: string;
  minWidth?: string;
  minHeight?: string;
  maxWidth?: string;
  maxHeight?: string;

  margin?: string;
  padding?: string;

  bgColor?: string;
  textColor?: string;
  fontSize?: string;
  fontWeight?: string | number;
  textAlign?: 'left' | 'center' | 'right' | 'justify';
  fontFamily?: string;
  lineHeight?: string | number;
  letterSpacing?: string;
  whiteSpace?: 'nowrap' | 'pre-wrap' | 'pre' | 'normal';

  borderRadius?: string;
  border?: string;
  borderColor?: string;
  borderWidth?: string;
  borderStyle?: string;

  boxShadow?: string;
  opacity?: string | number;
  overflow?: 'hidden' | 'auto' | 'scroll' | 'visible';

  transition?: string;
  transform?: string;
  cursor?: string;

  // 响应式
  responsive?: Record<string, Partial<StyleIntent>>;

  // 伪类
  hover?: Partial<StyleIntent>;
  focus?: Partial<StyleIntent>;
  active?: Partial<StyleIntent>;

  // 动画
  animation?: string;
  animationDuration?: string;
  animationTiming?: string;

  // 自定义
  custom?: Record<string, string>;
}

/* ============ NLP 解析 ============ */

function parseDescription(text: string): StyleIntent {
  const intent: StyleIntent = {};
  const t = text.toLowerCase();

  // Display / Layout
  if (t.includes('flex')) {
    intent.display = t.includes('inline-flex') ? 'inline-flex' : 'flex';
  }
  if (t.includes('grid')) intent.display = 'grid';
  if (t.includes('hidden') || t.includes('隐藏')) intent.display = 'none';
  if (t.includes('行内块') || (t.includes('inline') && t.includes('block'))) intent.display = 'inline-block';

  if (t.includes('纵向') || t.includes('竖直') || t.includes('垂直') || t.includes('column') || t.includes('竖向')) {
    intent.flexDirection = 'column';
  }
  if (t.includes('横向') || t.includes('水平') || t.includes('row') || t.includes('横向排')) {
    intent.flexDirection = 'row';
  }

  // 居中
  if (t.includes('居中') || t.includes('center')) {
    intent.justifyContent = 'center';
    intent.alignItems = 'center';
    intent.textAlign = 'center';
  }

  if (t.includes('垂直居中')) intent.alignItems = 'center';
  if (t.includes('水平居中') && !t.includes('垂直')) {
    intent.justifyContent = 'center';
  }

  // 两端对齐
  if (t.includes('两端对齐') || t.includes('space-between')) intent.justifyContent = 'space-between';
  if (t.includes('均匀分布') || t.includes('space-evenly')) intent.justifyContent = 'space-evenly';
  if (t.includes('环绕') || t.includes('space-around')) intent.justifyContent = 'space-around';

  // 换行
  if (t.includes('换行') || t.includes('wrap')) intent.flexWrap = 'wrap';
  if (t.includes('不换行') || t.includes('nowrap')) {
    intent.flexWrap = 'nowrap';
    intent.whiteSpace = 'nowrap';
  }

  // 间距
  const gapMatch = t.match(/(?:间距|间隔|gap)[：:]\s*(\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw)?)/);
  if (gapMatch) intent.gap = gapMatch[1];

  // Position
  if (t.includes('绝对定位') || t.includes('absolute')) intent.position = 'absolute';
  if (t.includes('固定定位') || t.includes('fixed')) intent.position = 'fixed';
  if (t.includes('粘性') || t.includes('sticky')) intent.position = 'sticky';
  if (t.includes('相对定位') || t.includes('relative')) intent.position = 'relative';

  // 尺寸
  const widthMatch = t.match(/(?:宽度|宽|width)[：:]\s*(\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|auto)?)/);
  if (widthMatch) intent.width = widthMatch[1];

  const heightMatch = t.match(/(?:高度|高|height)[：:]\s*(\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|auto)?)/);
  if (heightMatch) intent.height = heightMatch[1];

  // 全屏 / 满宽
  if (t.includes('全屏') || (t.includes('100') && t.includes('vh'))) {
    intent.width = '100%';
    intent.height = '100vh';
  }
  if (t.includes('满宽') || t.includes('100%')) intent.width = '100%';

  // 颜色
  const colorMap: Record<string, string> = {
    '白色': '#ffffff', '白': '#ffffff', '黑色': '#000000', '黑': '#000000',
    '红色': '#ef4444', '红': '#ef4444', '蓝色': '#3b82f6', '蓝': '#3b82f6',
    '绿色': '#22c55e', '绿': '#22c55e', '黄色': '#eab308', '黄': '#eab308',
    '橙色': '#f97316', '橙': '#f97316', '紫色': '#a855f7', '紫': '#a855f7',
    '粉色': '#ec4899', '粉': '#ec4899', '青色': '#06b6d4', '青': '#06b6d4',
    '灰色': '#6b7280', '灰': '#6b7280', '深灰': '#374151', '浅灰': '#d1d5db',
    '透明': 'transparent',
  };

  if (t.includes('背景') || t.includes('bg') || t.includes('background')) {
    for (const [key, val] of Object.entries(colorMap)) {
      if (t.includes(key)) {
        intent.bgColor = val;
        break;
      }
    }
    // 检测 hex color
    const hexMatch = t.match(/(?:背景|bg)[^#]*(#[0-9a-fA-F]{3,8})/);
    if (hexMatch) intent.bgColor = hexMatch[1];
  }

  if (t.includes('文字') || t.includes('字体颜色') || t.includes('color') || t.includes('文本颜色') || t.includes('字色')) {
    for (const [key, val] of Object.entries(colorMap)) {
      if (t.includes(key)) {
        intent.textColor = val;
        break;
      }
    }
    const hexMatch = t.match(/(?:文字|color|字色|文本)[^#]*(#[0-9a-fA-F]{3,8})/);
    if (hexMatch) intent.textColor = hexMatch[1];
  }

  // Font size
  const fontSizeMatch = t.match(/(?:字号|字体大小|font-size|文字大小)[：:]\s*(\d+(?:\.\d+)?(?:px|rem|em|pt)?)/);
  if (fontSizeMatch) intent.fontSize = fontSizeMatch[1];
  if (t.includes('小字') || t.includes('small')) intent.fontSize = '0.875rem';
  if (t.includes('大字') || t.includes('large') || t.includes('大号')) intent.fontSize = '1.25rem';

  // Font weight
  if (t.includes('加粗') || t.includes('粗体') || t.includes('bold') || t.includes('bolder')) intent.fontWeight = '700';
  if (t.includes('细体') || t.includes('light') || t.includes('lighter')) intent.fontWeight = '300';

  // 圆角
  const radiusMatch = t.match(/(?:圆角|radius|rounded)[：:]*\s*(\d+(?:\.\d+)?(?:px|rem|em|%)?)/);
  if (radiusMatch) intent.borderRadius = radiusMatch[1];
  if (t.includes('圆角') && !radiusMatch) intent.borderRadius = '8px';
  if (t.includes('全圆角') || t.includes('圆形') || t.includes('circle') || t.includes('pill')) intent.borderRadius = '9999px';
  if (t.includes('无圆角') || t.includes('square') || t.includes('直角')) intent.borderRadius = '0';

  // 边框
  if (t.includes('边框') || t.includes('border')) {
    const borderWidthMatch = t.match(/(?:边框|border)[^:：]*?(\d+(?:\.\d+)?(?:px)?)/);
    intent.borderWidth = borderWidthMatch ? borderWidthMatch[1] : '1px';
    intent.borderStyle = 'solid';
    // 颜色
    for (const [key, val] of Object.entries(colorMap)) {
      if (t.includes(key) && (t.indexOf('边框') < t.indexOf(key) || t.indexOf('border') < t.indexOf(key))) {
        intent.borderColor = val;
        break;
      }
    }
    if (!intent.borderColor) intent.borderColor = '#e5e7eb';
  }

  // 阴影
  if (t.includes('阴影') || t.includes('shadow') || t.includes('box-shadow')) {
    if (t.includes('大阴影') || t.includes('large') || t.includes('深')) {
      intent.boxShadow = '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1)';
    } else if (t.includes('小阴影') || t.includes('small') || t.includes('浅')) {
      intent.boxShadow = '0 1px 2px 0 rgba(0, 0, 0, 0.05)';
    } else {
      intent.boxShadow = '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1)';
    }
  }

  // 悬浮效果
  if (t.includes('悬浮') || t.includes('hover') || t.includes('悬停')) {
    if (t.includes('放大') || t.includes('scale')) intent.hover = { transform: 'scale(1.05)' };
    if (t.includes('高亮') || t.includes('亮')) intent.hover = { opacity: '0.8' };
    if (t.includes('阴影') || t.includes('shadow')) {
      intent.hover = { boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1)' };
    }
    if (t.includes('变暗') || t.includes('darken')) intent.hover = { opacity: '0.8' };
    if (t.includes('下划线') || t.includes('underline')) intent.hover = { /* handled specially */ };
  }

  // 动画
  if (t.includes('动画') || t.includes('animation') || t.includes('过渡') || t.includes('transition')) {
    if (t.includes('淡入') || t.includes('fadeIn') || t.includes('fade')) {
      intent.animation = 'fadeIn 0.3s ease-in-out';
    }
    if (t.includes('旋转') || t.includes('spin') || t.includes('rotate')) {
      intent.animation = 'spin 1s linear infinite';
    }
    if (t.includes('脉冲') || t.includes('pulse') || t.includes('呼吸')) {
      intent.animation = 'pulse 2s ease-in-out infinite';
    }
    if (t.includes('弹跳') || t.includes('bounce')) {
      intent.animation = 'bounce 1s ease infinite';
    }
    if (t.includes('过渡') || t.includes('transition') || t.includes('渐变')) {
      intent.transition = 'all 0.3s ease';
    }
  }

  // Overflow
  if (t.includes('溢出滚动') || t.includes('scroll') || t.includes('滚动')) intent.overflow = 'auto';
  if (t.includes('溢出隐藏') || t.includes('hidden')) intent.overflow = 'hidden';

  // Padding/Margin
  const padMatch = t.match(/(?:内边距|padding)[：:]\s*(\d+(?:\.\d+)?(?:px|rem|em)?)/);
  if (padMatch) intent.padding = padMatch[1];
  const marginMatch = t.match(/(?:外边距|margin)[：:]\s*(\d+(?:\.\d+)?(?:px|rem|em)?)/);
  if (marginMatch) intent.margin = marginMatch[1];

  // 响应式
  if (t.includes('响应式') || t.includes('responsive')) {
    const mobile: Partial<StyleIntent> = {};
    const desktop: Partial<StyleIntent> = {};
    if (t.includes('移动端') || t.includes('手机')) mobile.padding = '1rem';
    if (t.includes('桌面') || t.includes('大屏')) desktop.padding = '2rem';
    if (Object.keys(mobile).length > 0 || Object.keys(desktop).length > 0) {
      intent.responsive = { '(max-width: 768px)': mobile, '(min-width: 1024px)': desktop };
    }
  }

  return intent;
}

/* ============ 输出渲染 ============ */

function renderCss(selector: string, intent: StyleIntent): string {
  const lines: string[] = [];
  lines.push(`${selector} {`);

  const props = toCssProperties(intent);
  for (const [k, v] of Object.entries(props)) {
    if (v !== undefined && v !== null && v !== '') {
      lines.push(`  ${k}: ${v};`);
    }
  }
  lines.push('}');

  // 伪类
  if (intent.hover) {
    lines.push('');
    lines.push(`${selector}:hover {`);
    const hp = toCssProperties(intent.hover);
    for (const [k, v] of Object.entries(hp)) {
      if (v) lines.push(`  ${k}: ${v};`);
    }
    lines.push('}');
  }

  if (intent.focus) {
    lines.push('');
    lines.push(`${selector}:focus {`);
    const fp = toCssProperties(intent.focus);
    for (const [k, v] of Object.entries(fp)) {
      if (v) lines.push(`  ${k}: ${v};`);
    }
    lines.push('}');
  }

  // 响应式
  if (intent.responsive) {
    for (const [breakpoint, rules] of Object.entries(intent.responsive)) {
      if (Object.keys(rules).length === 0) continue;
      lines.push('');
      lines.push(`@media ${breakpoint} {`);
      lines.push(`  ${selector} {`);
      const rp = toCssProperties(rules);
      for (const [k, v] of Object.entries(rp)) {
        if (v) lines.push(`    ${k}: ${v};`);
      }
      lines.push(`  }`);
      lines.push('}');
    }
  }

  return lines.join('\n');
}

function renderScss(selector: string, intent: StyleIntent): string {
  // SCSS 与 CSS 格式类似，但支持嵌套
  const lines: string[] = [];
  const selName = selector.startsWith('.') || selector.startsWith('#') || selector.startsWith('[') || selector.includes(' ')
    ? selector
    : selector;

  lines.push(`${selName} {`);

  const props = toCssProperties(intent);
  for (const [k, v] of Object.entries(props)) {
    if (v) lines.push(`  ${k}: ${v};`);
  }

  if (intent.hover) {
    lines.push('');
    lines.push(`  &:hover {`);
    const hp = toCssProperties(intent.hover);
    for (const [k, v] of Object.entries(hp)) {
      if (v) lines.push(`    ${k}: ${v};`);
    }
    lines.push(`  }`);
  }

  if (intent.focus) {
    lines.push('');
    lines.push(`  &:focus {`);
    const fp = toCssProperties(intent.focus);
    for (const [k, v] of Object.entries(fp)) {
      if (v) lines.push(`    ${k}: ${v};`);
    }
    lines.push(`  }`);
  }

  lines.push('}');

  // 响应式（SCSS 中媒体查询嵌套在外部）
  if (intent.responsive) {
    for (const [breakpoint, rules] of Object.entries(intent.responsive)) {
      if (Object.keys(rules).length === 0) continue;
      lines.push('');
      lines.push(`@media ${breakpoint} {`);
      lines.push(`  ${selName} {`);
      const rp = toCssProperties(rules);
      for (const [k, v] of Object.entries(rp)) {
        if (v) lines.push(`    ${k}: ${v};`);
      }
      lines.push(`  }`);
      lines.push('}');
    }
  }

  return lines.join('\n');
}

function renderTailwind(selector: string, intent: StyleIntent): string {
  // Tailwind 用 className 的方式
  const classes: string[] = [];

  // Display
  if (intent.display === 'flex') classes.push('flex');
  else if (intent.display === 'inline-flex') classes.push('inline-flex');
  else if (intent.display === 'grid') classes.push('grid');
  else if (intent.display === 'hidden') classes.push('hidden');
  else if (intent.display === 'inline-block') classes.push('inline-block');
  else if (intent.display === 'block') classes.push('block');

  // Flex direction
  if (intent.flexDirection === 'column') classes.push('flex-col');
  else if (intent.flexDirection === 'row') classes.push('flex-row');
  else if (intent.flexDirection === 'column-reverse') classes.push('flex-col-reverse');

  // Justify
  if (intent.justifyContent === 'center') classes.push('justify-center');
  else if (intent.justifyContent === 'space-between') classes.push('justify-between');
  else if (intent.justifyContent === 'space-evenly') classes.push('justify-evenly');
  else if (intent.justifyContent === 'space-around') classes.push('justify-around');

  // Align
  if (intent.alignItems === 'center') classes.push('items-center');
  else if (intent.alignItems === 'flex-start') classes.push('items-start');
  else if (intent.alignItems === 'flex-end') classes.push('items-end');
  else if (intent.alignItems === 'stretch') classes.push('items-stretch');

  // Wrap
  if (intent.flexWrap === 'wrap') classes.push('flex-wrap');
  else if (intent.flexWrap === 'nowrap') classes.push('flex-nowrap');

  // Gap (common tailwind sizes)
  if (intent.gap) {
    const gapNum = parseFloat(intent.gap);
    if (gapNum <= 4) classes.push('gap-1');
    else if (gapNum <= 8) classes.push('gap-2');
    else if (gapNum <= 12) classes.push('gap-3');
    else if (gapNum <= 16) classes.push('gap-4');
    else if (gapNum <= 24) classes.push('gap-6');
  }

  // Position
  if (intent.position === 'absolute') classes.push('absolute');
  else if (intent.position === 'relative') classes.push('relative');
  else if (intent.position === 'fixed') classes.push('fixed');
  else if (intent.position === 'sticky') classes.push('sticky');

  // Width / Height
  if (intent.width === '100%') classes.push('w-full');
  if (intent.height === '100vh' || intent.height === '100%') classes.push('h-full');
  if (intent.minWidth === '100%') classes.push('min-w-full');
  if (intent.minHeight === '100vh' || intent.minHeight === '100%') classes.push('min-h-screen');

  // Padding (common)
  if (intent.padding) {
    const p = parseFloat(intent.padding);
    if (p <= 4) classes.push('p-1');
    else if (p <= 8) classes.push('p-2');
    else if (p <= 12) classes.push('p-3');
    else if (p <= 16) classes.push('p-4');
    else if (p <= 20) classes.push('p-5');
    else if (p <= 24) classes.push('p-6');
    else classes.push(`p-[${intent.padding}]`);
  }

  // Margin
  if (intent.margin) {
    const m = parseFloat(intent.margin);
    if (m <= 4) classes.push('m-1');
    else if (m <= 8) classes.push('m-2');
    else if (m <= 12) classes.push('m-3');
    else if (m <= 16) classes.push('m-4');
    else classes.push(`m-[${intent.margin}]`);
  }

  // Background
  if (intent.bgColor) {
    const named = tailwindColor(intent.bgColor);
    classes.push(named ? `bg-${named}` : `bg-[${intent.bgColor}]`);
  }

  // Text color
  if (intent.textColor) {
    const named = tailwindColor(intent.textColor);
    classes.push(named ? `text-${named}` : `text-[${intent.textColor}]`);
  }

  // Font size
  if (intent.fontSize) {
    const s = parseFloat(intent.fontSize);
    if (s <= 12) classes.push('text-xs');
    else if (s <= 14) classes.push('text-sm');
    else if (s <= 16) classes.push('text-base');
    else if (s <= 18) classes.push('text-lg');
    else if (s <= 20) classes.push('text-xl');
    else if (s <= 24) classes.push('text-2xl');
    else classes.push(`text-[${intent.fontSize}]`);
  }

  // Font weight
  if (intent.fontWeight === '700' || intent.fontWeight === 'bold') classes.push('font-bold');
  else if (intent.fontWeight === '600') classes.push('font-semibold');
  else if (intent.fontWeight === '500') classes.push('font-medium');
  else if (intent.fontWeight === '300') classes.push('font-light');

  // Text align
  if (intent.textAlign === 'center') classes.push('text-center');
  else if (intent.textAlign === 'right') classes.push('text-right');
  else if (intent.textAlign === 'left') classes.push('text-left');

  // Border radius
  if (intent.borderRadius === '9999px' || intent.borderRadius === '50%') classes.push('rounded-full');
  else if (intent.borderRadius === '0' || intent.borderRadius === '0px') classes.push('rounded-none');
  else if (intent.borderRadius) {
    const r = parseFloat(intent.borderRadius);
    if (r <= 2) classes.push('rounded-sm');
    else if (r <= 4) classes.push('rounded');
    else if (r <= 8) classes.push('rounded-md');
    else if (r <= 12) classes.push('rounded-lg');
    else if (r <= 16) classes.push('rounded-xl');
    else classes.push(`rounded-[${intent.borderRadius}]`);
  }

  // Border
  if (intent.borderWidth) {
    const bw = parseFloat(intent.borderWidth);
    if (bw <= 1) classes.push('border');
    else if (bw <= 2) classes.push('border-2');
    else if (bw <= 4) classes.push('border-4');
    if (intent.borderColor) {
      const c = tailwindColor(intent.borderColor);
      classes.push(c ? `border-${c}` : `border-[${intent.borderColor}]`);
    }
  }

  // Shadow
  if (intent.boxShadow) {
    if (intent.boxShadow.includes('10px 15px')) classes.push('shadow-lg');
    else if (intent.boxShadow.includes('1px 2px')) classes.push('shadow-sm');
    else classes.push('shadow');
  }

  // Opacity
  if (intent.opacity) classes.push(`opacity-${Math.round(parseFloat(String(intent.opacity)) * 100)}`);

  // Overflow
  if (intent.overflow === 'hidden') classes.push('overflow-hidden');
  else if (intent.overflow === 'auto') classes.push('overflow-auto');
  else if (intent.overflow === 'scroll') classes.push('overflow-scroll');

  // Transition
  if (intent.transition) classes.push('transition-all duration-300');

  // Cursor
  if (intent.cursor === 'pointer') classes.push('cursor-pointer');

  // White space
  if (intent.whiteSpace === 'nowrap') classes.push('whitespace-nowrap');

  // Hover
  if (intent.hover) {
    if (intent.hover.transform?.includes('scale')) classes.push('hover:scale-105');
    if (intent.hover.opacity) classes.push(`hover:opacity-${Math.round(parseFloat(String(intent.hover.opacity)) * 100)}`);
    if (intent.hover.boxShadow) classes.push('hover:shadow-lg');
  }

  const html = `<${selector.startsWith('.') ? 'div' : selector} class="${classes.join(' ')}">`;
  const commentLines = [
    `<!-- Tailwind CSS - ${selector} -->`,
    html,
    `  <!-- content -->`,
    `</${selector.startsWith('.') ? 'div' : selector}>`,
  ];

  return commentLines.join('\n');
}

/* ============ 工具函数 ============ */

function toCssProperties(intent: Partial<StyleIntent>): Record<string, string> {
  const p: Record<string, string> = {};

  if (intent.display) p.display = intent.display;
  if (intent.position) p.position = intent.position;
  if (intent.flexDirection) p['flex-direction'] = intent.flexDirection;
  if (intent.justifyContent) p['justify-content'] = intent.justifyContent;
  if (intent.alignItems) p['align-items'] = intent.alignItems;
  if (intent.flexWrap) p['flex-wrap'] = intent.flexWrap;
  if (intent.gap) p.gap = intent.gap;
  if (intent.width) p.width = intent.width;
  if (intent.height) p.height = intent.height;
  if (intent.minWidth) p['min-width'] = intent.minWidth;
  if (intent.minHeight) p['min-height'] = intent.minHeight;
  if (intent.margin) p.margin = intent.margin;
  if (intent.padding) p.padding = intent.padding;
  if (intent.bgColor) p['background-color'] = intent.bgColor;
  if (intent.textColor) p.color = intent.textColor;
  if (intent.fontSize) p['font-size'] = intent.fontSize;
  if (intent.fontWeight) p['font-weight'] = String(intent.fontWeight);
  if (intent.textAlign) p['text-align'] = intent.textAlign;
  if (intent.fontFamily) p['font-family'] = intent.fontFamily;
  if (intent.lineHeight) p['line-height'] = String(intent.lineHeight);
  if (intent.letterSpacing) p['letter-spacing'] = intent.letterSpacing;
  if (intent.whiteSpace) p['white-space'] = intent.whiteSpace;
  if (intent.borderRadius) p['border-radius'] = intent.borderRadius;
  if (intent.borderWidth) p['border-width'] = intent.borderWidth;
  if (intent.borderStyle) p['border-style'] = intent.borderStyle;
  if (intent.borderColor) p['border-color'] = intent.borderColor;
  if (intent.boxShadow) p['box-shadow'] = intent.boxShadow;
  if (intent.opacity) p.opacity = String(intent.opacity);
  if (intent.overflow) p.overflow = intent.overflow;
  if (intent.transition) p.transition = intent.transition;
  if (intent.transform) p.transform = intent.transform;
  if (intent.cursor) p.cursor = intent.cursor;
  if (intent.animation) p.animation = intent.animation;

  if (intent.custom) Object.assign(p, intent.custom);

  // 特殊：flex 布局简写
  if (intent.display === 'flex' && !intent.flexDirection && !intent.justifyContent && !intent.alignItems) {
    // 已经设置了 display: flex
  }

  return p;
}

const tailwindColorMap: Record<string, string> = {
  '#ffffff': 'white', '#000000': 'black',
  '#ef4444': 'red-500', '#dc2626': 'red-600', '#b91c1c': 'red-700',
  '#3b82f6': 'blue-500', '#2563eb': 'blue-600', '#1d4ed8': 'blue-700',
  '#22c55e': 'green-500', '#16a34a': 'green-600', '#15803d': 'green-700',
  '#eab308': 'yellow-500', '#ca8a04': 'yellow-600',
  '#f97316': 'orange-500', '#ea580c': 'orange-600',
  '#a855f7': 'purple-500', '#9333ea': 'purple-600',
  '#ec4899': 'pink-500', '#db2777': 'pink-600',
  '#06b6d4': 'cyan-500', '#0891b2': 'cyan-600',
  '#6b7280': 'gray-500', '#374151': 'gray-700', '#d1d5db': 'gray-300',
  '#f3f4f6': 'gray-100', '#e5e7eb': 'gray-200', '#9ca3af': 'gray-400',
  '#4b5563': 'gray-600', '#111827': 'gray-900',
  '#0d6efd': 'blue-600', '#198754': 'green-600', '#dc3545': 'red-600',
  '#ffc107': 'yellow-500', '#0dcaf0': 'cyan-400', '#6c757d': 'gray-500',
  '#343a40': 'gray-800', '#212529': 'gray-900', '#f8f9fa': 'gray-100',
};

function tailwindColor(hex: string): string | null {
  const lower = hex.toLowerCase();
  return tailwindColorMap[lower] || null;
}

/**
 * 生成 CSS/SCSS/Tailwind 样式代码
 */
export const generateStyles = tool({
  description: `生成 CSS/SCSS/Tailwind 样式代码，支持常见布局模式（flex、grid、响应式断点）、主题变量、动画关键帧等。传入自然语言描述即可。`,
  inputSchema: z.object({
    selector: z.string().describe('CSS 选择器或组件名，如 .my-class / #header / div'),
    properties: z.string().describe('样式需求自然语言描述，如「flex 居中布局，深色背景，圆角边框，悬停放大阴影」'),
    format: z.string().describe('输出格式: css / scss / tailwind'),
  }),
  execute: async ({ selector, properties, format }): Promise<string> => {
    const fmt = (format || 'css').toLowerCase() as Format;
    if (!['css', 'scss', 'tailwind'].includes(fmt)) {
      return `❌ 不支持的格式: "${format}"。支持: css, scss, tailwind`;
    }

    const intent = parseDescription(properties);

    // 补上 Selector
    const sel = selector.trim() || '.component';

    switch (fmt) {
      case 'css':
        return renderCss(sel, intent);
      case 'scss':
        return renderScss(sel, intent);
      case 'tailwind':
        return renderTailwind(sel, intent);
      default:
        return renderCss(sel, intent);
    }
  },
});

