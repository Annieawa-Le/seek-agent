/**
 * desk_editor skill 入口
 * 提供 desk_edit、line_cursor、line_paste、ctrl_z、desk_save、desk_cancel、desk_confirm_file、desk-editor-prompt-get 等工具
 */
import { deskEdit } from './scripts/desk-edit';
import { lineCursor } from './scripts/line-cursor';
import { linePaste } from './scripts/line-paste';
import { ctrlZ } from './scripts/ctrl-z';
import { deskSave } from './scripts/desk-save';
import { deskCancel } from './scripts/desk-cancel';
import { deskConfirmFile } from './scripts/desk-confirm-file';
import { deskEditorPromptGet } from './scripts/prompt-get';

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
