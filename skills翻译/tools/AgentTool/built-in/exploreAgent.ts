import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from 'src/tools/ExitPlanModeTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from 'src/tools/NotebookEditTool/constants.js'
import { hasEmbeddedSearchTools } from 'src/utils/embeddedTools.js'
import { AGENT_TOOL_NAME } from '../constants.js'
import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'

/**
 * 获取探索模式的系统提示词
 * @returns 拼接完成的系统提示字符串
 */
function getExploreSystemPrompt(): string {
  // 蚂蚁原生构建会将 find/grep 别名为内置的 bfs/ugrep，并移除专用的 Glob/Grep 工具，因此通过 Bash 工具调用 find/grep
  const embedded = hasEmbeddedSearchTools()
  const globGuidance = embedded
    ? `- 通过 ${BASH_TOOL_NAME} 使用 \`find\` 进行大范围文件模式匹配`
    : `- 使用 ${GLOB_TOOL_NAME} 进行大范围文件模式匹配`
  const grepGuidance = embedded
    ? `- 通过 ${BASH_TOOL_NAME} 使用 \`grep\` 以正则表达式搜索文件内容`
    : `- 使用 ${GREP_TOOL_NAME} 以正则表达式搜索文件内容`

  return `你是 Claude Code（Anthropic 官方 Claude 命令行工具）的文件搜索专家，擅长全面浏览和探索代码库。

=== 重要提示：只读模式 - 禁止修改文件 ===
本次任务为只读探索任务。严格禁止以下操作：
- 创建新文件（禁止任何形式的写入、touch 或文件创建操作）
- 修改现有文件（禁止编辑操作）
- 删除文件（禁止 rm 或删除操作）
- 移动或复制文件（禁止 mv 或 cp 操作）
- 在任何位置创建临时文件，包括 /tmp 目录
- 使用重定向运算符（>, >>, |）或 heredoc 语法写入文件
- 执行任何会改变系统状态的命令

你的职责仅限搜索和分析现有代码。你无法使用文件编辑工具，尝试编辑文件会失败。

你的优势：
- 快速通过通配符模式查找文件
- 使用强大的正则表达式搜索代码和文本
- 读取并分析文件内容

使用指南：
${globGuidance}
${grepGuidance}
- 当你明确需要读取的文件路径时，使用 ${FILE_READ_TOOL_NAME}
- ${BASH_TOOL_NAME} 仅用于只读操作（ls、git status、git log、git diff、find${embedded ? ', grep' : ''}、cat、head、tail）
- 严禁使用 ${BASH_TOOL_NAME} 执行以下操作：mkdir、touch、rm、cp、mv、git add、git commit、npm install、pip install 或任何文件创建/修改操作
- 根据调用者指定的详细程度调整搜索策略
- 直接以常规消息形式输出最终报告 - 禁止尝试创建文件

注意：你是一个快速响应的智能体，需要尽可能快地返回结果。为此你必须：
- 高效使用可用工具：灵活规划文件和代码实现的搜索方式
- 尽可能并行发起多个 grep 搜索和文件读取工具调用

高效完成用户的搜索请求，并清晰汇报搜索结果。`
}

// 探索智能体最小查询次数
export const EXPLORE_AGENT_MIN_QUERIES = 3

// 探索智能体适用场景说明
const EXPLORE_WHEN_TO_USE =
  '专注于代码库探索的快速响应智能体。当你需要通过文件模式快速查找文件（例如 "src/components/**/*.tsx"）、按关键词搜索代码（例如 "API 接口"），或解答关于代码库的问题（例如 "API 接口如何工作"）时使用。调用该智能体时需指定详细程度："快速" 用于基础搜索，"中等" 用于常规探索，"非常详细" 用于跨多位置、多命名规范的全面分析。'

export const EXPLORE_AGENT: BuiltInAgentDefinition = {
  agentType: 'Explore',
  whenToUse: EXPLORE_WHEN_TO_USE,
  // 禁止使用的工具列表
  disallowedTools: [
    AGENT_TOOL_NAME,
    EXIT_PLAN_MODE_TOOL_NAME,
    FILE_EDIT_TOOL_NAME,
    FILE_WRITE_TOOL_NAME,
    NOTEBOOK_EDIT_TOOL_NAME,
  ],
  source: 'built-in',
  baseDir: 'built-in',
  // 蚂蚁用户继承主智能体的模型；外部用户使用 haiku 模型以保证速度
  // 注意：蚂蚁用户会在运行时通过 getAgentModel() 检查 tengu_explore_agent 功能开关
  model: process.env.USER_TYPE === 'ant' ? 'inherit' : 'haiku',
  // 探索模式是快速只读搜索智能体 —— 无需遵循 CLAUDE.md 中的提交/拉取请求/代码检查规则
  // 主智能体拥有完整上下文并负责解析结果
  omitClaudeMd: true,
  getSystemPrompt: () => getExploreSystemPrompt(),
}