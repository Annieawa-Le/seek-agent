/** dsh-theme 工具调用的人类可读标签（渲染层据此显示工具调用说明）。 */
export const dsh_theme_translations: Record<string, { callLabel: (args: Record<string, unknown>) => string }> = {
  theme_list: {
    callLabel: () => '查看已安装的主题皮肤',
  },
  theme_status: {
    callLabel: () => '查看主题插件状态',
  },
}
