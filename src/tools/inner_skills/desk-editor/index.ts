/**
 * desk_editor skill 入口
 * 提供 desk_edit、line_cursor、line_paste、ctrl_z、desk_save、desk_cancel、desk_confirm_file、desk-editor-prompt-get 等工具
 */
import { deskEdit } from './desk-edit';
import { lineCursor } from './line-cursor';
import { linePaste } from './line-paste';
import { ctrlZ } from './ctrl-z';
import { deskSave } from './desk-save';
import { deskCancel } from './desk-cancel';
import { deskConfirmFile } from './desk-confirm-file';
import { deskEditorPromptGet } from './prompt-get';

const tools: Record<string, any> = {
  'desk_edit': deskEdit,
  'line_cursor': lineCursor,
  'line_paste': linePaste,
  'ctrl_z': ctrlZ,
  'desk_save': deskSave,
  'desk_cancel': deskCancel,
  'desk_confirm_file': deskConfirmFile,
  'desk-editor-prompt-get': deskEditorPromptGet,
};

export default tools;
