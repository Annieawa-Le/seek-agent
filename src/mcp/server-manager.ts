/**
 * mcp/server-manager.ts — MCP Client 生命周期管理
 *
 * 管理多个 MCP Server 连接。每个 Server 对应一个独立的 MCPClient。
 * 支持延迟初始化（首次 tools() 时连接）、批量关闭和重连。
 */

import {
  createMCPClient,
  type MCPClient,
} from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { McpServerConfig } from './config';

export interface McpConnection {
  /** 服务器唯一标识名 */
  name: string;
  /** MCP 客户端实例（连接后赋值） */
  client?: MCPClient;
  /** 服务器配置 */
  config: McpServerConfig;
  /** 是否已初始化 */
  initialized: boolean;
  /** 错误信息 */
  error?: string;
}

/**
 * 管理多个 MCP Server 连接的注册中心。
 * 所有操作都是幂等的，可安全重复调用。
 */
export class McpServerManager {
  private connections: Map<string, McpConnection> = new Map();

  /**
   * 注册一个 MCP Server 配置（但不立即连接）。
   * 首次调用 tools() 时自动初始化。
   */
  register(name: string, config: McpServerConfig): void {
    this.connections.set(name, {
      name,
      config,
      initialized: false,
    });
  }

  /**
   * 从配置映射批量注册
   */
  registerFromConfig(
    servers: Record<string, McpServerConfig>,
  ): void {
    for (const [name, config] of Object.entries(servers)) {
      this.register(name, config);
    }
  }

  /**
   * 初始化所有已注册但未连接的 Server。
   * 忽略已初始化的，记录失败的。
   */
  async initAll(): Promise<void> {
    const pending: McpConnection[] = [];

    for (const conn of this.connections.values()) {
      if (!conn.initialized) {
        pending.push(conn);
      }
    }

    if (pending.length === 0) return;

    await Promise.all(
      pending.map(async (conn) => {
        try {
          const transport = new Experimental_StdioMCPTransport({
            command: conn.config.command,
            args: conn.config.args,
            env: conn.config.env,
            cwd: conn.config.cwd,
          });

          const client = await createMCPClient({ transport });
          conn.client = client;
          conn.initialized = true;
          console.log(`[MCP] ✅ 已连接: ${conn.name}`);
        } catch (err) {
          conn.error = (err as Error).message;
          console.warn(`[MCP] ❌ 连接失败 ${conn.name}:`, (err as Error).message);
        }
      }),
    );
  }

  /**
   * 获取所有已连接 Server 的工具集（合并为一个对象）。
   * 自动初始化尚未连接的 Server。
   */
  async getAllTools(): Promise<Record<string, unknown>> {
    await this.initAll();

    const allTools: Record<string, unknown> = {};

    for (const conn of this.connections.values()) {
      if (!conn.client || !conn.initialized) continue;
      try {
        const toolSet = await conn.client.tools();
        Object.assign(allTools, toolSet);
        console.log(`[MCP]   ${conn.name}: 注册了 ${Object.keys(toolSet as object).length} 个工具`);
      } catch (err) {
        console.warn(`[MCP]   ${conn.name}: 获取工具列表失败`, (err as Error).message);
      }
    }

    return allTools;
  }

  /**
   * 获取某个 Server 的 serverInfo（如名称、版本等）
   */
  getServerInfo(name: string) {
    return this.connections.get(name)?.client?.serverInfo;
  }

  /**
   * 获取某个 Server 的 instructions（可注入 system prompt）
   */
  getInstructions(name: string): string | undefined {
    return this.connections.get(name)?.client?.instructions;
  }

  /**
   * 获取所有已连接 Server 的 instructions 文本
   */
  getAllInstructions(): string[] {
    const result: string[] = [];
    for (const conn of this.connections.values()) {
      const instructions = conn.client?.instructions;
      if (instructions) {
        result.push(`## MCP Server: ${conn.name}\n${instructions}`);
      }
    }
    return result;
  }

  /**
   * 关闭所有 Server 连接（幂等、安全）
   */
  async shutdownAll(): Promise<void> {
    const tasks: Promise<void>[] = [];

    for (const conn of this.connections.values()) {
      if (conn.client) {
        tasks.push(
          conn.client
            .close()
            .catch((err) =>
              console.warn(`[MCP] 关闭 ${conn.name} 时出错:`, err),
            ),
        );
      }
    }

    await Promise.all(tasks);
    this.connections.clear();
    console.log('[MCP] 所有 Server 已关闭');
  }

  /**
   * 返回连接状态摘要
   */
  getStatus(): { name: string; initialized: boolean; error?: string; toolCount?: number }[] {
    return Array.from(this.connections.values()).map((c) => ({
      name: c.name,
      initialized: c.initialized,
      error: c.error,
    }));
  }

  /** 当前已注册的连接数 */
  get size(): number {
    return this.connections.size;
  }
}

