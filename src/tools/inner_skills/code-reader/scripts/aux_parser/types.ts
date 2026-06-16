/**
 * 函数信息接口
 */
console.log("loaded")
export interface FunctionInfo {
  name: string;
  type: 'function' | 'method' | 'lambda' | 'arrow' | 'anonymous';
  params: string[];
  returnType?: string;
  startLine: number;
  endLine: number;
  body: string;
  isAsync: boolean;
  isPrivate?: boolean;
  isStatic?: boolean;
  isClassMethod?: boolean;
  className?: string;
  decorators?: string[];
  docstring?: string;
}

export const __test = 123;