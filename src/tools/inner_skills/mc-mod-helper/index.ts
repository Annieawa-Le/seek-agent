/**
 * mc_mod_helper skill 入口
 * 提供 mc_project_scaffold、mc_register_item、mc_register_block、mc_gen_recipe、mc_gen_lang、mc_gen_model、mc_gen_loot_table、mc-mod-helper-prompt-get 等工具
 */
import { mcProjectScaffold } from './scripts/mc-project-scaffold';
import { mcRegisterItem } from './scripts/mc-register-item';
import { mcRegisterBlock } from './scripts/mc-register-block';
import { mcGenRecipe } from './scripts/mc-gen-recipe';
import { mcGenLang } from './scripts/mc-gen-lang';
import { mcGenModel } from './scripts/mc-gen-model';
import { mcGenLootTable } from './scripts/mc-gen-loot-table';
import { mcModHelperPromptGet } from './scripts/prompt-get';

const tools: Record<string, any> = {
  'mc_project_scaffold': mcProjectScaffold,
  'mc_register_item': mcRegisterItem,
  'mc_register_block': mcRegisterBlock,
  'mc_gen_recipe': mcGenRecipe,
  'mc_gen_lang': mcGenLang,
  'mc_gen_model': mcGenModel,
  'mc_gen_loot_table': mcGenLootTable,
  'mc-mod-helper-prompt-get': mcModHelperPromptGet,
};

export default tools;
