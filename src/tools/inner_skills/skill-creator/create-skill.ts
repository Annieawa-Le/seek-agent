import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILLS_DIR = path.resolve(__dirname, '..');

// ── 工具函数 ────────────────────────────────────────────────

/**
 * 将工具名转为驼峰式变量名：create_skill → createSkill, code-reader → codeReader
 */
function toolNameToVar(toolName: string): string {
  return toolName.replace(/[_-]([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * 将工具名转为连字符文件名：create_skill → create-skill
 */
function toolNameToFile(toolName: string): string {
  return toolName.replace(/_/g, '-');
}

/**
 * 生成 enable.json
 */
function genEnableJson(description: string): string {
  return JSON.stringify({ enable: true, description }, null, 2) + '\n';
}

/**
 * 生成 SKILL.md 骨架
 */
function genSkillMd(skillName: string, description: string, tools: { name: string; desc: string }[]): string {
  const toolTableHeader = '| 工具 | 功能 |\n|------|------|';
  const toolRows = tools.map(t => `| \`${t.name}\` | ${t.desc} |`).join('\n');

  return `## 用途

${description}

### 可用工具

${toolTableHeader}
${toolRows}

### 使用流程建议

\`\`\`
1. 使用 list_skills 查看已有技能
2. 根据需要调用对应工具
\`\`\`
`;
}

/**
 * 生成 index.ts 入口文件（自动注入 [skill-dir]-prompt-get 工具）
 */
function genIndexTs(skillName: string, tools: { name: string; file: string }[], skillDirName: string): string {
  // 自动追加 prompt-get 工具
  const autoTools = [
    ...tools,
    { name: `${skillDirName}-prompt-get`, file: 'prompt-get' },
  ];

  const imports = autoTools
    .map(t => `import { ${toolNameToVar(t.name)} } from './${t.file}';`)
    .join('\n');

  const entries = autoTools
    .map(t => `  '${t.name}': ${toolNameToVar(t.name)},`)
    .join('\n');

  const allToolNames = autoTools.map(t => t.name).join('、');

  return `/**
 * ${skillName} skill 入口
 * 提供 ${allToolNames} 等工具
 */
${imports}

const tools: Record<string, any> = {
${entries}
};

export default tools;
`;
}

/**
 * 生成工具实现文件的骨架
 */
function genToolFile(toolName: string, toolDesc: string, params: { name: string; type: string; desc: string }[]): string {
  const varName = toolNameToVar(toolName);

  // 构建 zod schema 字段
  const schemaFields = params
    .map(p => {
      let zodType: string;
      switch (p.type) {
        case 'string':
          zodType = 'z.string()';
          break;
        case 'number':
          zodType = 'z.number()';
          break;
        case 'boolean':
          zodType = 'z.boolean()';
          break;
        default:
          zodType = 'z.string()';
      }
      return `    ${p.name}: ${zodType}.describe('${p.desc}'),`;
    })
    .join('\n');

  const paramDestructure = params.map(p => `${p.name},`).join('\n      ');

  return `import { tool } from 'ai';
import { z } from 'zod';

export const ${varName} = tool({
  description: \`${toolDesc}\`,
  inputSchema: z.object({
${schemaFields}
  }),
  execute: async ({ ${paramDestructure} }): Promise<string> => {
    // TODO: 实现 ${toolName} 的逻辑
    return \`${toolName} 工具已调用，待实现。\`;
  },
});
`;
}

/**
 * 生成 prompt-get.ts 工具文件 — 每个 skill 自动附带
 * 用于通过 AI 获取该技能的说明文档
 */
function genPromptGetToolFile(skillDirName: string): string {
  const varName = toolNameToVar(`${skillDirName}-prompt-get`);

  return `import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ${varName} = tool({
  description: \`获取 ${skillDirName} 技能的详细说明文档（SKILL.md），包含可用工具列表和使用说明。\`,
  inputSchema: z.object({}),
  execute: async (): Promise<string> => {
    try {
      const skillPath = path.join(__dirname, 'SKILL.md');
      const content = await fs.readFile(skillPath, 'utf-8');
      return content;
    } catch (error) {
      return \`读取失败: \${(error as Error).message}\`;
    }
  },
});
`;
}

/**
 * 生成 SYSTEM_INJECTION.md 模板 — 每个 skill 自动附带
 * 该文件内容会在加载 skill 时自动注入到 system prompt 末尾
 */
function genSystemInjectionMd(skillDirName: string): string {
  return `# ${skillDirName} — 提示词注入

此文件的内容会在该 skill 启用时，自动追加到 system prompt 末尾。
你可以在此添加针对该 skill 的行为指引、约束条件或偏好设定。

例如：
- 使用该技能时优先调用哪些工具
- 特定的输出格式要求
- 调用该技能前需要做的准备工作
- 与其他技能配合时的注意事项

如果不需要提示词注入，保持此文件为空即可。
`;
}

// ── create_skill: 创建新技能 ──────────────────────────────

export const createSkill = tool({
  description: `创建一个新的 inner_skill。自动生成标准化的目录结构、配置文件、说明文档和代码骨架。
  skillName 是技能名称（小写字母+下划线，如 my_analyzer）。
  description 是技能的简要描述，会写入 SKILL.md。
  tools 是工具定义列表，每个工具包含 name（工具名）、description（工具描述）、
  params（参数列表，每项含 name、type、description）。`,
  inputSchema: z.object({
    skillName: z.string().describe('技能名称，小写字母+下划线组成，如 my_analyzer'),
    description: z.string().describe('技能的简要描述，用于生成 SKILL.md'),
    tools: z.array(z.object({
      name: z.string().describe('工具名称，小写字母+下划线，如 analyze_file'),
      description: z.string().describe('工具功能描述'),
      params: z.array(z.object({
        name: z.string().describe('参数名'),
        type: z.enum(['string', 'number', 'boolean']).describe('参数类型：string/number/boolean'),
        description: z.string().describe('参数说明'),
      })).default([]).describe('工具的参数列表'),
    })).describe('要创建的工具列表'),
  }),
  execute: async ({ skillName, description, tools }): Promise<string> => {
    // 验证 skillName 格式
    if (!/^[a-z][a-z0-9_]*$/.test(skillName)) {
      return `技能名 "${skillName}" 格式错误。请使用小写字母开头，仅含小写字母、数字和下划线。`;
    }

    const skillDirName = skillName.replace(/_/g, '-');
    const skillDir = path.join(SKILLS_DIR, skillDirName);

    // 检查是否已存在
    try {
      await fs.access(skillDir);
      return `技能 "${skillName}" 已存在于 ${skillDir}，请使用其他名称。`;
    } catch {
      // 目录不存在，可以创建
    }

    const createdFiles: string[] = [];

    try {
      // 1. 创建技能目录
      await fs.mkdir(skillDir, { recursive: true });
      createdFiles.push(skillDir);

      // 2. 创建 references/ 目录（存放参考文件）
      await fs.mkdir(path.join(skillDir, 'references'), { recursive: true });
      createdFiles.push(path.join(skillDir, 'references'));

      // 3. 创建 enable.json
      await fs.writeFile(path.join(skillDir, 'enable.json'), genEnableJson(description), 'utf-8');
      createdFiles.push(path.join(skillDir, 'enable.json'));

      // 4. 创建 SKILL.md
      const toolMeta = tools.map(t => ({
        name: t.name,
        desc: t.description,
      }));
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), genSkillMd(skillName, description, toolMeta), 'utf-8');
      createdFiles.push(path.join(skillDir, 'SKILL.md'));

      // 4.5 创建 SYSTEM_INJECTION.md（提示词注入文件，可选）
      const injectionPath = path.join(skillDir, 'SYSTEM_INJECTION.md');
      await fs.writeFile(injectionPath, genSystemInjectionMd(skillDirName), 'utf-8');
      createdFiles.push(injectionPath);

      // 5. 为每个工具创建实现文件
      const toolFiles = tools.map(t => ({
        name: t.name,
        file: toolNameToFile(t.name),
      }));

      for (const t of tools) {
        const fileName = `${toolNameToFile(t.name)}.ts`;
        const filePath = path.join(skillDir, fileName);
        await fs.writeFile(filePath, genToolFile(t.name, t.description, t.params), 'utf-8');
        createdFiles.push(filePath);
      }

      // 6. 创建 prompt-get.ts（每个 skill 必备：获取技能说明文档）
      const promptGetFilePath = path.join(skillDir, 'prompt-get.ts');
      await fs.writeFile(promptGetFilePath, genPromptGetToolFile(skillDirName), 'utf-8');
      createdFiles.push(promptGetFilePath);

      // 7. 创建 index.ts（自动注入所有工具入口，含 prompt-get）
      await fs.writeFile(path.join(skillDir, 'index.ts'), genIndexTs(skillName, toolFiles, skillDirName), 'utf-8');
      createdFiles.push(path.join(skillDir, 'index.ts'));

      // 构建结果报告
      const fileList = createdFiles
        .map(f => `  ${f.startsWith(skillDir) ? '📄 ' : '📁 '}${f}`)
        .join('\n');

      return [
        `✅ 技能 "${skillName}" 创建成功！`,
        `路径: ${skillDir}`,
        '',
        '生成的文件:',
        fileList,
        '',
        '💡 下一步：',
        ...tools.map(t => `   - 编辑 ${toolNameToFile(t.name)}.ts 实现 "${t.name}" 的具体逻辑`),
        '   - 编辑 SKILL.md 补充详细的使用说明',
        '   - 编辑 SYSTEM_INJECTION.md 配置提示词注入（可选）',
        '   - 重启或重新加载使技能生效',
      ].join('\n');
    } catch (error) {
      // 清理已创建的文件
      for (const f of [...createdFiles].reverse()) {
        try {
          await fs.rm(f, { recursive: true, force: true });
        } catch {
          // 忽略清理失败
        }
      }
      return `创建失败: ${(error as Error).message}`;
    }
  },
});

// ── list_skills: 列出所有技能 ────────────────────────────

export const listSkills = tool({
  description: `列出 src/tools/inner_skills 下所有已注册的技能及其启用状态。`,
  inputSchema: z.object({}),
  execute: async (): Promise<string> => {
    try {
      const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory());

      if (dirs.length === 0) {
        return '暂无已注册的 inner_skills。';
      }

      const lines: string[] = ['📋 已注册的 inner_skills:\n'];

      for (const dir of dirs) {
        const enablePath = path.join(SKILLS_DIR, dir.name, 'enable.json');
        let enabled = false;
        let summary = '';
        try {
          const raw = await fs.readFile(enablePath, 'utf-8');
          const config = JSON.parse(raw);
          enabled = !!config.enable;
          summary = config.description || '';
        } catch {
          // 无配置文件视为禁用
        }

        if (!summary) {
        // 回退：从 SKILL.md 读取简介（兼容旧技能，无 description 字段时使用）
        try {
          const skillMdPath = path.join(SKILLS_DIR, dir.name, 'SKILL.md');
          const mdContent = await fs.readFile(skillMdPath, 'utf-8');
          const firstLine = mdContent.split('\n').find(l => l.trim().startsWith('## 用途'));
          if (firstLine) {
            // 取"用途"后面实际描述的第一行
            const lines2 = mdContent.split('\n');
            const idx = lines2.findIndex(l => l.trim().startsWith('## 用途'));
            if (idx !== -1 && idx + 1 < lines2.length) {
              summary = lines2[idx + 1].trim();
            }
          }
        } catch {
          // 忽略
        }
        }

        const status = enabled ? '✅ 启用' : '⛔ 禁用';
        lines.push(`  ${status}  ${dir.name}${summary ? ' — ' + summary.substring(0, 60) : ''}`);
      }

      return lines.join('\n');
    } catch (error) {
      return `列出技能失败: ${(error as Error).message}`;
    }
  },
});

// ── skill_creator_prompt_get: 获取本技能文档 ────────────

export const skillCreatorPromptGet = tool({
  description: `获取 skill-creator 技能的详细说明文档（SKILL.md），包含可用工具列表、使用流程和生成的文件结构说明。`,
  inputSchema: z.object({}),
  execute: async (): Promise<string> => {
    try {
      const skillPath = path.join(__dirname, 'SKILL.md');
      const content = await fs.readFile(skillPath, 'utf-8');
      return content;
    } catch (error) {
      return `读取失败: ${(error as Error).message}`;
    }
  },
});




