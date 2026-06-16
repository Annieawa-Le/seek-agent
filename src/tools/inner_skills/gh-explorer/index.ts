/**
 * gh_explorer skill 入口
 * GitHub 仓库探索 + 本地 git 操作 + 推送
 */
import { ghSearchRepos } from './gh-search-repos';
import { ghRepoTree } from './gh-repo-tree';
import { ghReadme } from './gh-readme';
import { ghFileContent } from './gh-file-content';
import { ghExplore } from './gh-explore';
import { ghClone } from './gh-clone';
import { ghLog } from './gh-log';
import { ghStatus } from './gh-status';
import { ghBranch } from './gh-branch';
import { ghDiff } from './gh-diff';
import { ghCheckout } from './gh-checkout';
import { ghPush } from './gh-push';
import { ghExplorerPromptGet } from './prompt-get';

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
