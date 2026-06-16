import { registerTool } from '../../../assets/tool-translations';

registerTool('reload_skills', {
  icon: '🔄',
  category: 'system',
  callLabel: () => '重新加载所有技能',
  collapse: 'single',
});


registerTool('remove_skill', {
  icon: '🗑️',
  category: 'system',
  callLabel: (args) => `卸载技能: ${args.skill_name}`,
  collapse: 'single',
});

registerTool('remove_tool', {
  icon: '❌',
  category: 'system',
  callLabel: (args) => `卸载工具: ${args.tool_name}`,
  collapse: 'single',
});
