/**
 * gh_explorer skill 入口
 * GitHub 仓库探索 + 本地 git 操作 + 推送
 */
import { ghSearchRepos } from './scripts/gh-search-repos';
import { ghRepoTree } from './scripts/gh-repo-tree';
import { ghReadme } from './scripts/gh-readme';
import { ghFileContent } from './scripts/gh-file-content';
import { ghExplore } from './scripts/gh-explore';
import { ghClone } from './scripts/gh-clone';
import { ghLog } from './scripts/gh-log';
import { ghStatus } from './scripts/gh-status';
import { ghBranch } from './scripts/gh-branch';
import { ghDiff } from './scripts/gh-diff';
import { ghCheckout } from './scripts/gh-checkout';
import { ghPush } from './scripts/gh-push';
import { ghExplorerPromptGet } from './scripts/prompt-get';

const tools: Record<string, any> = {
  'gh_search_repos': ghSearchRepos,
  'gh_repo_tree': ghRepoTree,
  'gh_readme': ghReadme,
  'gh_file_content': ghFileContent,
  'gh_explore': ghExplore,
  'gh_clone': ghClone,
  'gh_log': ghLog,
  'gh_status': ghStatus,
  'gh_branch': ghBranch,
  'gh_diff': ghDiff,
  'gh_checkout': ghCheckout,
  'gh_push': ghPush,
  'gh-explorer-prompt-get': ghExplorerPromptGet,
};

export default tools;
