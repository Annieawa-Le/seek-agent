import { tool } from 'ai';
import { z } from 'zod';

function toPascalCase(s: string): string {
  return s.replace(/[-_]/g, ' ').replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1)).replace(/\s/g, '');
}


function toKebabCase(s: string): string {
  return s.replace(/[A-Z]/g, m => '-' + m.toLowerCase()).replace(/^-/, '').replace(/[-_]+/g, '-');
}

function parseOptions(raw: string): Record<string, any> {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/* ========================
   React 组件生成
   ======================== */
function generateReact(name: string, opts: Record<string, any>): string {
  const compName = toPascalCase(name);
  const useTS = opts.typescript !== false;
  const styleType = opts.styling || 'css';
  const compType = opts.type || 'functional';
  const propsList: string[] = opts.props || [];

  const propsStr = useTS
    ? `interface ${compName}Props {\n${propsList.map(p => `  ${p}: ${p === 'children' ? 'React.ReactNode' : 'string | number'};`).join('\n')}\n}`
    : '';

  const propsType = useTS ? `${compName}Props` : '{}';

  if (compType === 'class') {
    const lines: string[] = [
      `import React, { Component } from 'react';`,
      styleType === 'css' ? `import './${name}.css';` : '',
      styleType === 'scss' ? `import './${name}.module.scss';` : '',
      '',
      propsStr,
      '',
      `interface ${compName}State {`,
      `}`,
      '',
      `class ${compName} extends Component<${propsType}, ${compName}State> {`,
      `  constructor(props: ${propsType}) {`,
      `    super(props);`,
      `    this.state = {};`,
      `  }`,
      ``,
      `  render() {`,
      styleType === 'tailwind'
        ? `    return <div className="">\n      {/* ${compName} content */}\n    </div>;`
        : `    return (\n      <div className="${toKebabCase(name)}">\n        {/* ${compName} content */}\n      </div>\n    );`,
      `  }`,
      `}`,
      '',
      `export default ${compName};`,
    ];
    return lines.filter(l => l !== '' || lines.indexOf(l) !== lines.length - 1).join('\n');
  }

  // 默认：函数组件
  const lines: string[] = [
    `import React from 'react';`,
    styleType === 'css' ? `import './${name}.css';` : '',
    styleType === 'scss' ? `import './${name}.module.scss';` : '',
    '',
    propsStr,
    '',
    `const ${compName}: React.FC<${propsType}> = (props) => {`,
    `  const { ${propsList.join(', ')} } = props;`,
    ``,
    styleType === 'tailwind'
      ? `  return <div className="">\n    {/* ${compName} content */}\n  </div>;`
      : `  return (\n    <div className="${toKebabCase(name)}">\n      {/* ${compName} content */}\n    </div>\n  );`,
    `}`,
    '',
    `export default ${compName};`,
  ];
  return lines.filter(l => l !== '' || lines.indexOf(l) !== lines.length - 1).join('\n');
}

/* ========================
   Vue 组件生成
   ======================== */
function generateVue(name: string, opts: Record<string, any>): string {
  const compName = toPascalCase(name);
  const tagName = toKebabCase(name);
  const useTS = opts.typescript !== false;
  const apiType = opts.type || 'composition';
  const propsList: string[] = opts.props || [];
  const styleLang = opts.styling === 'scss' ? ' lang="scss"' : '';

  if (apiType === 'options') {
    return [
      `<template>`,
      `  <div class="${tagName}">`,
      `    <!-- ${compName} content -->`,
      `  </div>`,
      `</template>`,
      ``,
      `<script${useTS ? ' lang="ts"' : ''}>`,
      `import { defineComponent } from 'vue';`,
      ``,
      propsList.length > 0
        ? `export default defineComponent({\n  name: '${compName}',\n  props: {\n${propsList.map(p => `    ${p}: { type: String, default: '' }`).join(',\n')}\n  },\n  setup(props) {\n    return { props };\n  },\n});`
        : `export default defineComponent({\n  name: '${compName}',\n  setup() {\n    return {};\n  },\n});`,
      `</script>`,
      ``,
      `<style scoped${styleLang}>`,
      `.${tagName} {`,
      `  /* styles */`,
      `}`,
      `</style>`,
    ].join('\n');
  }

  // 默认：组合式 API (script setup)
  const propsSetup = propsList.length > 0
    ? `const props = defineProps<{\n${propsList.map(p => `  ${p}: ${p === 'children' ? 'string' : 'string'}`).join('\n')}\n}>()`
    : '';

  return [
    `<script setup${useTS ? ' lang="ts"' : ''}>`,
    propsSetup,
    `</script>`,
    ``,
    `<template>`,
    `  <div class="${tagName}">`,
    `    <!-- ${compName} content -->`,
    `  </div>`,
    `</template>`,
    ``,
    `<style scoped${styleLang}>`,
    `.${tagName} {`,
    `  /* styles */`,
    `}`,
    `</style>`,
    ``,
  ].filter(l => l !== '').join('\n');
}

/* ========================
   原生 HTML 生成
   ======================== */
function generateHtml(name: string, opts: Record<string, any>): string {
  const compName = toPascalCase(name);
  const title = opts.title || compName;

  return [
    `<!DOCTYPE html>`,
    `<html lang="zh-CN">`,
    `<head>`,
    `  <meta charset="UTF-8" />`,
    `  <meta name="viewport" content="width=device-width, initial-scale=1.0" />`,
    `  <title>${title}</title>`,
    `  <link rel="stylesheet" href="styles.css" />`,
    `</head>`,
    `<body>`,
    `  <main class="${toKebabCase(name)}">`,
    `    <!-- ${compName} content -->`,
    `  </main>`,
    `  <script src="main.js"></script>`,
    `</body>`,
    `</html>`,
  ].join('\n');
}

/**
 * 生成前端组件代码骨架
 */
export const generateComponent = tool({
  description: `生成前端组件代码骨架，支持 React（函数/类组件）、Vue（选项式/组合式 API）、原生 HTML 等多种框架风格。自动处理导入语句、Props 类型定义、样式绑定等样板代码。`,
  inputSchema: z.object({
    componentName: z.string().describe('组件名称（PascalCase 或 kebab-case，如 MyButton / my-button）'),
    framework: z.string().describe('目标框架: react / vue / html'),
    options: z.string().describe('可选参数 JSON。字段: type (functional|class|composition|options), typescript (boolean), styling (css|scss|tailwind|none), props (属性名数组，如 ["label","onClick"])'),
  }),
  execute: async ({ componentName, framework, options }): Promise<string> => {
    const opts = parseOptions(options);

    switch (framework) {
      case 'react':
        return generateReact(componentName, opts);
      case 'vue':
        return generateVue(componentName, opts);
      case 'html':
        return generateHtml(componentName, opts);
      default:
        return `❌ 不支持的框架: "${framework}"。支持: react, vue, html`;
    }
  },
});

