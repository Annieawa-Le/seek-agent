import { CommandContext, Command } from './types';

/**
 * 指令注册中心。
 * register 注册指令，tryExecute 按注册顺序匹配并执行。
 */
export class CommandRegistry {
  private commands: Command[] = [];

  /** 注册一个指令 */
  register(command: Command): this {
    this.commands.push(command);
    return this;
  }

  /** 批量注册 */
  registerAll(commands: Command[]): this {
    for (const cmd of commands) {
      this.register(cmd);
    }
    return this;
  }

  /**
   * 尝试匹配并执行指令。
   * 遍历已注册指令列表，第一个 match() 返回 true 的指令获得执行权。
   * 返回 true 表示已处理，false 表示无匹配。
   */
  async tryExecute(input: string, ctx: CommandContext): Promise<boolean> {
    for (const cmd of this.commands) {
      try {
        if (cmd.match(input)) {
          await cmd.execute(input, ctx);
          return true;
        }
      } catch (error: any) {
        ctx.ui.addAgentMessage(`❌ 指令「${cmd.name}」执行出错: ${error?.message || error}`);
        return true;
      }
    }
    return false;
  }

  /** 获取所有已注册指令的快照 */
  getCommands(): Command[] {
    return [...this.commands];
  }
}
