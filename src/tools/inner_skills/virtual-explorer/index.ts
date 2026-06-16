/**
 * virtual_explorer skill 入口
 * 提供 list_directory、enter_subfolder、go_up、virtual-explorer-prompt-get 等工具，
 * 以及 explorer-* 前缀的路径感知工具集。
 */
import { listDirectory, explorerListDirectory } from './list-directory';
import { enterSubfolder, explorerEnterSubfolder } from './enter-subfolder';
import { goUp, explorerGoUp } from './go-up';
import { virtualExplorerPromptGet } from './prompt-get';
import {
  explorerReadFile,
  explorerReadLines,
  explorerReadNumLine,
  explorerScanFile,
  explorerSearchAllFile,
  explorerSearchSubFile,
  explorerSearchDirectory,
  explorerSearchContent,
  explorerCreateFile,
  explorerReplaceFile,
  explorerAddPatch,
  explorerDelPatch,
  explorerModifyPatch,
  explorerExecuteCommand,
} from './explorer-tools';

const tools: Record<string, any> = {
  'list_directory': listDirectory,
  'enter_subfolder': enterSubfolder,
  'go_up': goUp,
  'virtual-explorer-prompt-get': virtualExplorerPromptGet,

  // explorer-* 工具集
  'explorer-list-directory': explorerListDirectory,
  'explorer-enter-subfolder': explorerEnterSubfolder,
  'explorer-go-up': explorerGoUp,
  'explorer-read-file': explorerReadFile,
  'explorer-read-lines': explorerReadLines,
  'explorer-read-num-line': explorerReadNumLine,
  'explorer-scan-file': explorerScanFile,
  'explorer-search-all-file': explorerSearchAllFile,
  'explorer-search-sub-file': explorerSearchSubFile,
  'explorer-search-directory': explorerSearchDirectory,
  'explorer-search-content': explorerSearchContent,
  'explorer-create-file': explorerCreateFile,
  'explorer-replace-file': explorerReplaceFile,
  'explorer-add-patch': explorerAddPatch,
  'explorer-del-patch': explorerDelPatch,
  'explorer-modify-patch': explorerModifyPatch,
  'explorer-execute-command': explorerExecuteCommand,
};

export default tools;
