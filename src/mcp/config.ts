/**
 * mcp/config.ts — MCP 配置加载
 *
 * 加载 mcp.json（工作区根目录），描述 MCP Server 的启动方式。
 * 格式兼容 Claude Desktop 的 mcpServers 规范。
 *
 * 配置示例（工作区根目录 mcp.json）：
 * {
 *   "mcpServers": {
 *     "filesystem": {
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-filesystem", "./dir"],
 *       "env": { "API_KEY": "xxx" },
 *       "cwd": "./allowed-dir"
 *     }
 *   }
 * }
 */

import fs from 'node:fs';
import path from 'node:path';
import { getWorkspaceRoot } from '../workdir';

export interface McpServerConfig {
  /** 启动命令 */
  command: string;
  /** 命令参数 */
  args?: string[];
  /** 环境变量（可选） */
  env?: Record<string, string>;
  /** 工作目录（可选，默认工作区根目录） */
  cwd?: string;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

const CONFIG_FILENAMES = ['mcp.json', '.mcp.json', 'seek.mcp.json'];

/**
 * 从工作区根目录加载 mcp.json 配置
 */
export function loadMcpConfig(): McpConfig {
  const root = getWorkspaceRoot();

  for (const filename of CONFIG_FILENAMES) {
    const configPath = path.join(root, filename);
    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(raw) as McpConfig;
        if (!config.mcpServers || typeof config.mcpServers !== 'object') {
          console.warn(`[MCP] ${filename} 缺少 mcpServers 字段，跳过`);
          return { mcpServers: {} };
        }
        return config;
      } catch (err) {
        console.warn(`[MCP] 解析 ${filename} 失败:`, (err as Error).message);
        return { mcpServers: {} };
      }
    }
  }

  return { mcpServers: {} };
}

