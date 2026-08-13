// 代码图谱测试夹具：主入口
import { helper } from './utils/helper';
import { User } from './models/user';

export function run(): string {
  const user = new User('alice');
  const result = helper(user.name);
  return processResult(result);
}

export function processResult(input: string): string {
  return `processed: ${input}`;
}

function internalOnly(): number {
  return 42;
}

export const VERSION = '1.0.0';
export type Status = 'ok' | 'error';
export enum Level { Low = 1, High = 2 }
export interface Config { name: string; level: Level }
