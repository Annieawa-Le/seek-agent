/**
 * mcp/index.ts — MCP 统一入口
 *
 * 顶层 API，供 src/tools/index.ts 和 src/agent.ts 调用。
 *
 * 用法：
 *   const mcp = await initializeMCP();
 *   // mcp.tools       → 合并后的工具集（挂载到 toolsContainer）
 *   // mcp.instructions → Server instructions（注入 system prompt）
 *   // mcp.shutdown()  → 清理所有连接
 *
 *   // 也可通过 getMcpManager() 获取 Manager 实例直接操作
 */

import { loadMcpConfig } from './config';
import { McpServerManager } from './server-manager';

/** MCP 初始化结果 */
export interface MCPIntegration {
  /** 合并后的工具集（直接挂载到 toolsContainer） */
  tools: Record<string, unknown>;
  /** Server 提供的 instructions（可注入 system prompt） */
  instructions: string[];
  /** 关闭所有 MCP 连接 */
  shutdown: () => Promise<void>;
  /** 获取 Manager 实例（用于高级操作） */
  manager: McpServerManager;
}

let manager: McpServerManager | null = null;

/**
 * 初始化所有 MCP Server，返回工具集和清理函数。
 * 多次调用安全（已初始化的不会重复连接）。
 */
export async function initializeMCP(): Promise<MCPIntegration> {
  if (!manager) {
    manager = new McpServerManager();
  }

  // 加载配置
  const config = loadMcpConfig();
  const serverCount = Object.keys(config.mcpServers).length;

  if (serverCount === 0) {
    return {
      tools: {},
      instructions: [],
      shutdown: async () => { /* no-op */ },
      manager,
    };
  }

  console.log(`[MCP] 发现 ${serverCount} 个 MCP Server 配置`);

  // 注册
  manager.registerFromConfig(config.mcpServers);

  // 连接并获取工具
  const tools = await manager.getAllTools();

  // 收集 instructions
  const instructions = manager.getAllInstructions();

  return {
    tools,
    instructions,
    shutdown: async () => {
      await manager!.shutdownAll();
    },
    manager,
  };
}

/**
 * 关闭所有 MCP 连接（幂等）
 */
export async function shutdownMCP(): Promise<void> {
  if (manager) {
    await manager.shutdownAll();
    manager = null;
  }
}

/**
 * 获取当前 McpServerManager 实例（可能为 null）
 */
export function getMcpManager(): McpServerManager | null {
  return manager;
}

/**
 * 重新初始化 MCP（先关闭所有，重新加载配置）
 */
export async function reloadMCP(): Promise<MCPIntegration> {
  await shutdownMCP();
  return initializeMCP();
}
