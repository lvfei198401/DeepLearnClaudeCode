import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from 'src/tools/SendMessageTool/constants.js'
import { WEB_FETCH_TOOL_NAME } from 'src/tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from 'src/tools/WebSearchTool/prompt.js'
import { isUsing3PServices } from 'src/utils/auth.js'
import { hasEmbeddedSearchTools } from 'src/utils/embeddedTools.js'
import { getSettings_DEPRECATED } from 'src/utils/settings/settings.js'
import { jsonStringify } from '../../../utils/slowOperations.js'
import type {
  AgentDefinition,
  BuiltInAgentDefinition,
} from '../loadAgentsDir.js'

// 克劳德代码文档映射地址
const CLAUDE_CODE_DOCS_MAP_URL =
  'https://code.claude.com/docs/en/claude_code_docs_map.md'
// CDP文档映射地址
const CDP_DOCS_MAP_URL = 'https://platform.claude.com/llms.txt'

// 克劳德代码指南智能体类型
export const CLAUDE_CODE_GUIDE_AGENT_TYPE = 'claude-code-guide'

/**
 * 获取克劳德代码指南基础提示词
 * @returns 基础提示文字符串
 */
function getClaudeCodeGuideBasePrompt(): string {
  // 原生构建版本会将 find/grep 别名为内置的 bfs/ugrep，并移除独立的 Glob/Grep 工具，因此此处指向 find/grep
  const localSearchHint = hasEmbeddedSearchTools()
    ? `${FILE_READ_TOOL_NAME}, \`find\`, and \`grep\``
    : `${FILE_READ_TOOL_NAME}, ${GLOB_TOOL_NAME}, and ${GREP_TOOL_NAME}`

  return `你是克劳德指南智能体。你的主要职责是帮助用户高效理解和使用克劳德代码、克劳德智能体SDK以及克劳德API（原Anthropic API）。

**你的专业领域涵盖三个方面：**

1. **克劳德代码**（命令行工具）：安装、配置、钩子、技能、MCP服务器、键盘快捷键、IDE集成、设置和工作流程。

2. **克劳德智能体SDK**：基于克劳德代码技术构建自定义AI智能体的框架。支持Node.js/TypeScript和Python。

3. **克劳德API**：用于直接模型交互、工具使用和集成的克劳德API（原Anthropic API）。

**文档来源：**

- **克劳德代码文档**（${CLAUDE_CODE_DOCS_MAP_URL}）：当用户询问克劳德代码命令行工具相关问题时获取此文档，包括：
  - 安装、设置和入门指南
  - 钩子（命令执行前/后）
  - 自定义技能
  - MCP服务器配置
  - IDE集成（VS Code、JetBrains）
  - 设置文件与配置
  - 键盘快捷键
  - 子智能体与插件
  - 沙箱与安全

- **克劳德智能体SDK文档**（${CDP_DOCS_MAP_URL}）：当用户询问使用SDK构建智能体相关问题时获取此文档，包括：
  - SDK概述与入门（Python和TypeScript）
  - 智能体配置+自定义工具
  - 会话管理与权限
  - 智能体中的MCP集成
  - 托管与部署
  - 成本跟踪与上下文管理
  注意：智能体SDK文档是克劳德API文档的一部分，使用相同URL。

- **克劳德API文档**（${CDP_DOCS_MAP_URL}）：当用户询问克劳德API（原Anthropic API）相关问题时获取此文档，包括：
  - 消息API与流式传输
  - 工具使用（函数调用）和Anthropic定义的工具（计算机使用、代码执行、网页搜索、文本编辑器、bash、程序化工具调用、工具搜索工具、上下文编辑、文件API、结构化输出）
  - 视觉、PDF支持和引用
  - 扩展思考与结构化输出
  - 远程MCP服务器的MCP连接器
  - 云厂商集成（Bedrock、Vertex AI、Foundry）

**工作流程：**
1. 确定用户问题所属的领域
2. 使用${WEB_FETCH_TOOL_NAME}获取对应的文档映射
3. 从映射中找到最相关的文档URL
4. 获取具体的文档页面
5. 基于官方文档提供清晰、可操作的指导
6. 如果文档未覆盖该主题，使用${WEB_SEARCH_TOOL_NAME}
7. 相关时使用${localSearchHint}引用本地项目文件（CLAUDE.md、.claude/目录）

**指导原则：**
- 始终优先使用官方文档而非主观假设
- 保持回答简洁且可操作
- 必要时提供具体示例或代码片段
- 在回答中引用准确的文档URL
- 主动建议相关命令、快捷键或功能，帮助用户发现新特性

基于准确的官方文档指导完成用户的请求。`
}

/**
 * 获取反馈指导原则
 * @returns 反馈指导文字符串
 */
function getFeedbackGuideline(): string {
  // 对于第三方服务（Bedrock/Vertex/Foundry），/feedback 命令已禁用
  // 引导用户前往对应的反馈渠道
  if (isUsing3PServices()) {
    return `- 当你无法找到答案或功能不存在时，引导用户前往 ${MACRO.ISSUES_EXPLAINER}`
  }
  return "- 当你无法找到答案或功能不存在时，引导用户使用 /feedback 提交功能请求或错误报告"
}

// 克劳德代码指南内置智能体定义
export const CLAUDE_CODE_GUIDE_AGENT: BuiltInAgentDefinition = {
  agentType: CLAUDE_CODE_GUIDE_AGENT_TYPE,
  whenToUse: `当用户询问以下问题时（"克劳德能否..."、"克劳德是否..."、"我如何..."）使用此智能体：(1) 克劳德代码（命令行工具）- 功能、钩子、斜杠命令、MCP服务器、设置、IDE集成、键盘快捷键；(2) 克劳德智能体SDK - 构建自定义智能体；(3) 克劳德API（原Anthropic API）- API使用、工具使用、Anthropic SDK使用。**重要**：在创建新智能体之前，检查是否已有正在运行或最近完成的克劳德代码指南智能体，可通过${SEND_MESSAGE_TOOL_NAME}继续对话。`,
  // 原生构建版本：已移除 Glob/Grep 工具；使用 Bash（通过 find/grep 别名调用内置 bfs/ugrep）进行本地文件搜索
  tools: hasEmbeddedSearchTools()
    ? [
        BASH_TOOL_NAME,
        FILE_READ_TOOL_NAME,
        WEB_FETCH_TOOL_NAME,
        WEB_SEARCH_TOOL_NAME,
      ]
    : [
        GLOB_TOOL_NAME,
        GREP_TOOL_NAME,
        FILE_READ_TOOL_NAME,
        WEB_FETCH_TOOL_NAME,
        WEB_SEARCH_TOOL_NAME,
      ],
  source: '内置',
  baseDir: '内置',
  model: 'haiku',
  permissionMode: '无需询问',
  getSystemPrompt({ toolUseContext }) {
    const commands = toolUseContext.options.commands

    // 构建上下文片段
    const contextSections: string[] = []

    // 1. 自定义技能
    const customCommands = commands.filter(cmd => cmd.type === 'prompt')
    if (customCommands.length > 0) {
      const commandList = customCommands
        .map(cmd => `- /${cmd.name}: ${cmd.description}`)
        .join('\n')
      contextSections.push(
        `**本项目中可用的自定义技能：**\n${commandList}`,
      )
    }

    // 2. .claude/agents/ 目录下的自定义智能体
    const customAgents =
      toolUseContext.options.agentDefinitions.activeAgents.filter(
        (a: AgentDefinition) => a.source !== '内置',
      )
    if (customAgents.length > 0) {
      const agentList = customAgents
        .map((a: AgentDefinition) => `- ${a.agentType}: ${a.whenToUse}`)
        .join('\n')
      contextSections.push(
        `**已配置的可用自定义智能体：**\n${agentList}`,
      )
    }

    // 3. MCP服务器
    const mcpClients = toolUseContext.options.mcpClients
    if (mcpClients && mcpClients.length > 0) {
      const mcpList = mcpClients
        .map((client: { name: string }) => `- ${client.name}`)
        .join('\n')
      contextSections.push(`**已配置的MCP服务器：**\n${mcpList}`)
    }

    // 4. 插件命令
    const pluginCommands = commands.filter(
      cmd => cmd.type === 'prompt' && cmd.source === 'plugin',
    )
    if (pluginCommands.length > 0) {
      const pluginList = pluginCommands
        .map(cmd => `- /${cmd.name}: ${cmd.description}`)
        .join('\n')
      contextSections.push(`**可用的插件技能：**\n${pluginList}`)
    }

    // 5. 用户设置
    const settings = getSettings_DEPRECATED()
    if (Object.keys(settings).length > 0) {
      // eslint-disable-next-line no-restricted-syntax -- 面向用户的界面，非工具结果
      const settingsJson = jsonStringify(settings, null, 2)
      contextSections.push(
        `**用户的settings.json：**\n\`\`\`json\n${settingsJson}\n\`\`\``,
      )
    }

    // 添加反馈指导原则（根据用户是否使用第三方服务动态调整）
    const feedbackGuideline = getFeedbackGuideline()
    const basePromptWithFeedback = `${getClaudeCodeGuideBasePrompt()}
${feedbackGuideline}`

    // 若存在需要添加的上下文，将其追加到基础系统提示词后
    if (contextSections.length > 0) {
      return `${basePromptWithFeedback}

---

# 用户当前配置

用户的环境中包含以下自定义设置：

${contextSections.join('\n\n')}

回答问题时，请考虑这些已配置的功能，并在相关时主动推荐。`
    }

    // 无额外上下文时返回基础提示词
    return basePromptWithFeedback
  },
}