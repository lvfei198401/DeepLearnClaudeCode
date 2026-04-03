// 从Chrome扩展工具库导入浏览器工具集
import { BROWSER_TOOLS } from '@ant/claude-for-chrome-mcp'
// 从工具文件导入Chrome基础提示词
import { BASE_CHROME_PROMPT } from '../../utils/claudeInChrome/prompt.js'
// 从配置文件导入自动启用判断函数
import { shouldAutoEnableClaudeInChrome } from '../../utils/claudeInChrome/setup.js'
// 从技能注册模块导入内置技能注册方法
import { registerBundledSkill } from '../bundledSkills.js'

// 定义Claude Chrome集成的MCP工具名称集合，为每个浏览器工具添加专属前缀标识
const CLAUDE_IN_CHROME_MCP_TOOLS = BROWSER_TOOLS.map(
  tool => `mcp__claude-in-chrome__${tool.name}`,
)

// 技能激活提示信息
const SKILL_ACTIVATION_MESSAGE = `
当前技能已调用，你已获得Chrome浏览器自动化工具的使用权限。你可以使用mcp__claude-in-chrome__*系列工具与网页进行交互。

重要提示：首先调用mcp__claude-in-chrome__tabs_context_mcp工具，获取用户当前浏览器标签页的相关信息。
`

/**
 * 注册Claude Chrome集成技能
 * @returns 无返回值
 */
export function registerClaudeInChromeSkill(): void {
  registerBundledSkill({
    // 技能唯一标识名称
    name: 'claude-in-chrome',
    // 技能描述：自动化操作Chrome浏览器与网页交互，支持点击元素、填写表单、截图、读取控制台日志、网站导航等功能
    // 在当前Chrome会话的新标签页中打开页面，执行操作前需要获取网站级权限（在扩展程序中配置）
    description:
      '自动化操作你的Chrome浏览器与网页进行交互——点击页面元素、填写表单、截取屏幕截图、读取控制台日志、浏览网站。在你现有的Chrome会话中以新标签页打开页面，执行操作前需要获取网站级权限（在扩展程序中配置）。',
    // 适用场景：用户需要与网页交互、自动化执行浏览器任务、截取截图、读取控制台日志或执行任何基于浏览器的操作时
    // 在尝试使用任何mcp__claude-in-chrome__*工具前，必须先调用该技能
    whenToUse:
      '当用户需要与网页交互、自动化执行浏览器任务、截取屏幕截图、读取控制台日志或执行任何基于浏览器的操作时。在尝试使用任何mcp__claude-in-chrome__*工具之前，必须先调用该技能。',
    // 允许使用的工具列表
    allowedTools: CLAUDE_IN_CHROME_MCP_TOOLS,
    // 是否允许用户手动调用
    userInvocable: true,
    // 技能是否启用：根据配置自动判断
    isEnabled: () => shouldAutoEnableClaudeInChrome(),
    // 异步获取命令执行所需的提示词
    async getPromptForCommand(args) {
      let prompt = `${BASE_CHROME_PROMPT}\n${SKILL_ACTIVATION_MESSAGE}`
      // 如果存在传入参数，追加任务内容到提示词中
      if (args) {
        prompt += `\n## 任务\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}