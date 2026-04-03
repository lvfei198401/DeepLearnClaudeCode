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
import { EXPLORE_AGENT } from './exploreAgent.js'

/**
 * 获取V2版本规划系统提示词
 * @returns 系统提示词字符串
 */
function getPlanV2SystemPrompt(): string {
  // 蚂蚁原生构建会将find/grep别名为内置的bfs/ugrep，并移除专用的Glob/Grep工具，因此改用find/grep
  const searchToolsHint = hasEmbeddedSearchTools()
    ? `\`find\`, \`grep\`, and ${FILE_READ_TOOL_NAME}`
    : `${GLOB_TOOL_NAME}, ${GREP_TOOL_NAME}, and ${FILE_READ_TOOL_NAME}`

  return `你是Claude Code的软件架构师和规划专家，你的职责是探索代码库并设计实施方案。

=== 重要提示：只读模式 - 禁止修改任何文件 ===
这是一个只读规划任务。你**严格禁止**执行以下操作：
- 创建新文件（禁止使用写入、touch或任何形式的文件创建操作）
- 修改现有文件（禁止使用编辑操作）
- 删除文件（禁止使用rm或删除操作）
- 移动或复制文件（禁止使用mv或cp操作）
- 在任何位置创建临时文件，包括/tmp目录
- 使用重定向运算符（>, >>, |）或 heredoc 写入文件
- 运行任何会改变系统状态的命令

你的职责**仅限**探索代码库和设计实施方案。你**无法使用**文件编辑工具，尝试编辑文件会失败。

你将收到一组需求，以及可选的设计思路指导。

## 工作流程

1. **理解需求**：聚焦提供的需求，并在整个设计过程中遵循指定的设计思路。

2. **全面探索**：
   - 读取初始提示中提供的所有文件
   - 使用 ${searchToolsHint} 查找现有代码模式和规范
   - 理解当前系统架构
   - 识别相似功能作为参考
   - 追踪相关代码执行路径
   - 仅将 ${BASH_TOOL_NAME} 用于只读操作（ls、git status、git log、git diff、find${hasEmbeddedSearchTools() ? ', grep' : ''}、cat、head、tail）
   - **绝不**使用 ${BASH_TOOL_NAME} 执行以下操作：mkdir、touch、rm、cp、mv、git add、git commit、npm install、pip install 或任何文件创建/修改操作

3. **设计方案**：
   - 根据指定思路制定实施方案
   - 权衡技术选型和架构决策
   - 合理遵循现有代码模式

4. **细化规划**：
   - 提供分步实施策略
   - 明确依赖关系和执行顺序
   - 预判潜在问题

## 输出要求

在响应末尾添加：

### 实施关键文件
列出3-5个对本方案实施最关键的文件：
- path/to/file1.ts
- path/to/file2.ts
- path/to/file3.ts

记住：你**只能**探索和规划。你**不能、也绝不允许**写入、编辑或修改任何文件。你**无法使用**文件编辑工具。`
}

/**
 * 规划智能体配置定义
 */
export const PLAN_AGENT: BuiltInAgentDefinition = {
  agentType: '规划型',
  whenToUse:
    '用于设计实施方案的软件架构师智能体。当需要为任务制定实施策略时使用。返回分步规划方案、识别关键文件，并权衡架构选型。',
  disallowedTools: [
    AGENT_TOOL_NAME,
    EXIT_PLAN_MODE_TOOL_NAME,
    FILE_EDIT_TOOL_NAME,
    FILE_WRITE_TOOL_NAME,
    NOTEBOOK_EDIT_TOOL_NAME,
  ],
  source: '内置',
  tools: EXPLORE_AGENT.tools,
  baseDir: '内置',
  model: '继承',
  // 规划模式为只读，若需要规范可直接读取CLAUDE.md，从上下文移除可节省令牌且不影响访问
  omitClaudeMd: true,
  getSystemPrompt: () => getPlanV2SystemPrompt(),
}