import { resolvePath } from '../../../workdir.js';
import { tool } from 'ai';
import { z } from 'zod';
import { checkGitAvailable, gitRun, gitRunAsync } from './git-utils';

/**
 * 从环境变量获取推送凭据
 * 优先: GITHUB_TOKEN → GIT_PUSH_TOKEN → GITHUB_PASSWORD
 */
function getPushToken(): string | null {
  return process.env.GITHUB_TOKEN
    || process.env.GIT_PUSH_TOKEN
    || process.env.GITHUB_PASSWORD
    || null;
}

/**
 * 从 URL 提取 owner/repo
 */
function parseRepoUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com[:\/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

/**
 * 构建带 token 的 HTTPS remote URL
 */
function buildAuthUrl(originalUrl: string, token: string): string {
  // 已经是 https:// 格式
  if (originalUrl.startsWith('https://')) {
    // 如果已经带了 token 就跳过
    if (originalUrl.includes('@')) return originalUrl;
    return originalUrl.replace('https://', `https://${token}@`);
  }
  // git@github.com:user/repo.git → 转为 https 带 token
  const parsed = parseRepoUrl(originalUrl);
  if (parsed) {
    return `https://${token}@github.com/${parsed.owner}/${parsed.repo}.git`;
  }
  // 原样返回，可能是其他 git 服务
  return originalUrl;
}

/**
 * 获取当前远程 URL，并可选地注入 token
 */
function getRemoteUrlWithAuth(
  cwd: string,
  remote: string,
  token: string | null
): { url: string; authMethod: string } | { error: string } {
  const getUrl = gitRun(['remote', 'get-url', remote], cwd);
  if (!getUrl.ok) {
    if (getUrl.stderr?.includes('No such remote')) {
      return { error: `远程 "${remote}" 不存在。使用 gh_push 的 remote_url 参数添加远程。` };
    }
    return { error: `获取远程 URL 失败: ${getUrl.stderr || getUrl.error}` };
  }

  const originalUrl = getUrl.stdout;
  if (!originalUrl) {
    return { error: `远程 "${remote}" 没有 URL。` };
  }

  // SSH URL — 不需要注入 token，依赖 SSH key 认证
  if (originalUrl.startsWith('git@') || originalUrl.startsWith('ssh://')) {
    return { url: originalUrl, authMethod: 'ssh' };
  }

  // HTTPS URL — 如果有 token 就注入
  if (token) {
    return { url: buildAuthUrl(originalUrl, token), authMethod: 'token' };
  }

  // HTTPS 无 token — 可能触发交互式密码提示
  return { url: originalUrl, authMethod: 'none' };
}

export const ghPush = tool({
  description: `将本地提交推送到远程仓库（支持 token/SSH 认证，自动处理公私仓）`,
  inputSchema: z.object({
    repo_path: z.string().describe('本地仓库路径（绝对或相对路径）'),
    remote: z.string().optional().default('origin').describe('远程名称，默认 origin'),
    branch: z.string().optional().describe('要推送的分支名，默认推送当前分支到匹配的远程分支'),
    remote_url: z.string().optional().describe('远程仓库 URL（如未设置 remote 时使用），如 https://github.com/user/repo.git'),
    force: z.boolean().optional().default(false).describe('是否强制推送（--force），慎用！会覆盖远程历史'),
    set_upstream: z.boolean().optional().default(false).describe('是否设置 upstream（-u），首次推送时使用'),
    all: z.boolean().optional().default(false).describe('推送所有分支'),
    tags: z.boolean().optional().default(false).describe('同时推送标签'),
  }),
  execute: async ({ repo_path, remote, branch, remote_url, force, set_upstream, all, tags }): Promise<string> => {
    try {
      const git = checkGitAvailable();
      if (!git.ok) return `❌ ${git.error}`;

      const cwd = resolvePath(repo_path);
      const token = getPushToken();

      // 如果提供了 remote_url，先设置 remote
      if (remote_url) {
        // 检查 remote 是否已存在
        const existing = gitRun(['remote', 'get-url', remote!], cwd);
        if (existing.ok) {
          // 已存在，更新 URL
          const setResult = gitRun(['remote', 'set-url', remote!, remote_url], cwd);
          if (!setResult.ok) {
            return `设置远程 URL 失败:\n${setResult.stderr || setResult.error}`;
          }
        } else {
          // 不存在，添加 remote
          const addResult = gitRun(['remote', 'add', remote!, remote_url], cwd);
          if (!addResult.ok) {
            return `添加远程失败:\n${addResult.stderr || addResult.error}`;
          }
        }
      }

      // 获取远程 URL（带 token 注入）
      const remoteInfo = getRemoteUrlWithAuth(cwd, remote!, token);

      if ('error' in remoteInfo) {
        return remoteInfo.error;
      }

      // 组装 git push 命令
      const args: string[] = ['push'];

      if (force) args.push('--force');
      if (set_upstream) args.push('-u');
      if (all) args.push('--all');
      if (tags) args.push('--tags');

      args.push(remoteInfo.url);

      if (branch) args.push(branch);

      // 用异步执行（可能耗时较长）
      const result = await gitRunAsync(args, cwd);

      if (!result.ok) {
        // 常见错误友好提示
        const err = result.stderr || result.error || '';

        if (err.includes('No anonymous write access') || err.includes('403')) {
          return [
            `❌ 认证失败 — 没有推送权限。`,
            ``,
            `可能的原因:`,
            `  1. Token 无效或已过期 — 检查 GITHUB_TOKEN 环境变量`,
            `  2. Token 没有写入权限 — 在 GitHub Settings 中授予 repo 权限`,
            `  3. 仓库为私有且 token 无权访问`,
            ``,
            `当前认证方式: ${remoteInfo.authMethod === 'token' ? 'Token (GITHUB_TOKEN)' : '无认证'}`,
            token ? `  当前 Token: ${token.substring(0, 8)}...${token.slice(-4)}` : '  未设置 Token',
            ``,
            `设置方式: export GITHUB_TOKEN=ghp_your_token`,
          ].join('\n');
        }

        if (err.includes('non-fast-forward') || err.includes('fetch first')) {
          return [
            `❌ 推送被拒绝 — 远程有本地没有的提交。`,
            ``,
            `建议:`,
            `  1. git pull --rebase 拉取远程变更`,
            `  2. 解决冲突后再次推送`,
            `  3. 如确定要覆盖远程，使用 force: true 参数`,
          ].join('\n');
        }

        if (err.includes('Could not read from remote repository') || err.includes('Repository not found')) {
          return [
            `❌ 仓库不存在或无权限访问: ${remote_url || remoteInfo.url}`,
            ``,
            `请检查:`,
            `  1. 远程 URL 是否正确`,
            `  2. Token 是否有该仓库的访问权限`,
            `  3. 仓库是否已删除或转移`,
          ].join('\n');
        }

        if (err.includes('timeout') || err.includes('Could not resolve host')) {
          return `❌ 网络错误 — 无法连接到远程仓库。请检查网络连接。`;
        }

        return `推送失败:\n${err}`;
      }

      // 成功输出
      const stdout = result.stdout || '';
      const lines = stdout.split('\n').filter(Boolean);

      const output = [
        `✅ 推送成功`,
        ``,
        ...lines.map(l => `  ${l}`),
        ``,
        `认证方式: ${remoteInfo.authMethod === 'token' ? 'Token (GITHUB_TOKEN)' : remoteInfo.authMethod === 'ssh' ? 'SSH Key' : '无认证（可能需交互式密码）'}`,
        force ? '⚠️  使用了强制推送 (--force)' : '',
        tags ? '🏷️  同时推送了标签' : '',
      ].filter(Boolean).join('\n');

      return output;
    } catch (error) {
      return `gh_push 执行出错: ${(error as Error).message}`;
    }
  },
});



