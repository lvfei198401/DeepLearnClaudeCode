// 从工具常量文件导入工具名称常量
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/AskUserQuestionTool/prompt.js'
import { ENTER_PLAN_MODE_TOOL_NAME } from '../../tools/EnterPlanModeTool/constants.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from '../../tools/ExitPlanModeTool/constants.js'
import { SKILL_TOOL_NAME } from '../../tools/SkillTool/constants.js'
// 导入Git工具方法
import { getIsGit } from '../../utils/git.js'
// 导入注册内置技能的方法
import { registerBundledSkill } from '../bundledSkills.js'

// 最小代理数量
const MIN_AGENTS = 5
// 最大代理数量
const MAX_AGENTS = 30

/**
 * 工作节点执行指令
 * 完成代码修改后需要执行的步骤模板
 */
const WORKER_INSTRUCTIONS = `完成修改实现后：
1. **简化代码** — 调用 \`${SKILL_TOOL_NAME}\` 工具，传入参数 \`skill: "simplify"\`，审查并清理你的修改内容。
2. **运行单元测试** — 执行项目的测试套件（检查package.json脚本、Makefile目标，或常用命令如 \`npm test\`、\`bun test\`、\`pytest\`、\`go test\`）。如果测试失败，修复问题。
3. **端到端测试** — 按照协调器提示中的端到端测试步骤执行（见下文）。如果步骤说明当前单元跳过端到端测试，则直接跳过。
4. **提交并推送** — 使用清晰的信息提交所有修改，推送分支，并通过 \`gh pr create\` 创建拉取请求。使用描述性的标题。如果 \`gh\` 命令不可用或推送失败，在最终消息中注明。
5. **结果上报** — 最后输出一行内容：\`PR: <url>\`，方便协调器跟踪。如果未创建PR，输出：\`PR: none — <原因>\`。`

/**
 * 构建批量执行的提示词
 * @param instruction 用户指令
 * @returns 完整的执行提示词
 */
function buildPrompt(instruction: string): string {
  return `# 批量任务：并行工作编排

你正在对该代码库执行大规模、可并行化的修改。

## 用户指令

${instruction}

## 第一阶段：调研与规划（规划模式）

立即调用 \`${ENTER_PLAN_MODE_TOOL_NAME}\` 工具进入规划模式，然后执行以下操作：

1. **明确修改范围**。启动一个或多个子代理（前台执行——需要获取它们的执行结果），深入调研该指令涉及的内容。找到所有需要修改的文件、代码模式和调用位置。理解现有编码规范，保证修改风格统一。

2. **拆解为独立工作单元**。将任务拆分为 ${MIN_AGENTS}–${MAX_AGENTS} 个独立的工作单元。每个单元必须满足：
   - 可在独立的Git工作树中单独实现（与同级单元无共享状态）
   - 可独立合并，无需依赖其他单元的PR先合并
   - 工作量大致均匀（拆分大型单元，合并简单单元）

   根据实际工作量调整数量：文件数量少 → 接近 ${MIN_AGENTS}；文件数量多 → 接近 ${MAX_AGENTS}。优先按目录/模块拆分，而非随机文件列表。

3. **确定端到端测试方案**。明确工作节点如何验证修改真正生效（不仅是单元测试通过）。查找以下方式：
   - \`claude-in-chrome\` 技能或浏览器自动化工具（用于UI修改：遍历受影响流程，截图验证结果）
   - \`tmux\` 或CLI验证技能（用于CLI修改：交互式启动应用，验证修改后的功能）
   - 开发服务器+curl模式（用于API修改：启动服务器，调用受影响接口）
   - 工作节点可直接运行的现有端到端/集成测试套件

   如果无法找到具体的端到端测试方案，使用 \`${ASK_USER_QUESTION_TOOL_NAME}\` 工具询问用户如何验证修改效果。基于调研结果提供2-3个具体选项（例如："通过Chrome插件截图验证"、"执行 \`bun run dev\` 并curl接口验证"、"无需端到端测试——单元测试已足够"）。**不可跳过此步骤**——工作节点无法直接询问用户。

   将测试方案编写为简短、具体的步骤，让工作节点可自主执行。包含所有前置操作（启动开发服务器、先编译）和验证用的精确命令/交互步骤。

4. **编写规划方案**。在规划文件中包含：
   - 调研结果总结
   - 编号的工作单元列表——每个单元包含：简短标题、覆盖的文件/目录列表、一行修改描述
   - 端到端测试方案（如果用户选择跳过，填写"跳过端到端测试，原因：……"）
   - 分配给每个代理的精确工作节点指令（通用模板）

5. 调用 \`${EXIT_PLAN_MODE_TOOL_NAME}\` 提交规划方案等待审核。

## 第二阶段：启动工作节点（规划方案通过后）

方案审核通过后，使用 \`${AGENT_TOOL_NAME}\` 工具为每个工作单元启动一个后台代理。**所有代理必须配置 \`isolation: "worktree"\` 和 \`run_in_background: true\`**。在一个消息块中一次性启动所有代理，实现并行执行。

每个代理的提示词必须完全独立，包含：
- 整体目标（用户指令）
- 当前单元的具体任务（标题、文件列表、修改描述——直接复制规划方案中的内容）
- 调研到的代码库规范（工作节点必须遵守）
- 规划方案中的端到端测试方案（或"跳过端到端测试，原因：……"）
- 以下工作节点指令（直接复制）：

\`\`\`
${WORKER_INSTRUCTIONS}
\`\`\`

除非有更匹配的代理类型，否则使用 \`subagent_type: "general-purpose"\`。

## 第三阶段：进度跟踪

启动所有工作节点后，渲染初始状态表格：

| # | 工作单元 | 状态 | PR链接 |
|---|------|--------|----|
| 1 | <标题> | 执行中 | — |
| 2 | <标题> | 执行中 | — |

收到后台代理的完成通知后，解析每个代理结果中的 \`PR: <url>\` 行，重新渲染状态表格，更新状态（\`完成\` / \`失败\`）和PR链接。为未生成PR的代理记录简短的失败原因。

所有代理上报完成后，渲染最终表格和一行总结（例如："24个单元中22个已提交PR"）。
`
}

/**
 * 非Git仓库提示信息
 */
const NOT_A_GIT_REPO_MESSAGE = `当前目录不是Git仓库。\`/batch\` 命令需要Git仓库支持，因为它会在独立的Git工作树中启动代理，并为每个单元创建PR。请先初始化Git仓库，或在现有仓库内执行该命令。`

/**
 * 缺少用户指令提示信息
 */
const MISSING_INSTRUCTION_MESSAGE = `请提供描述你需要执行的批量修改的指令。

示例：
  /batch 将项目从React迁移到Vue
  /batch 替换所有lodash用法为原生JS方法
  /batch 为所有无类型注解的函数参数添加类型定义`

/**
 * 注册批量修改技能
 */
export function registerBatchSkill(): void {
  registerBundledSkill({
    name: 'batch',
    description: '调研并规划大规模代码修改，然后在5-30个独立工作树代理中并行执行，每个代理自动创建PR。',
    whenToUse: '当用户需要对大量文件执行统一的、机械化的修改时使用（迁移、重构、批量重命名），此类任务可拆解为独立的并行工作单元。',
    argumentHint: '<修改指令>',
    userInvocable: true,
    disableModelInvocation: true,
    async getPromptForCommand(args) {
      const instruction = args.trim()
      // 无指令时返回提示
      if (!instruction) {
        return [{ type: 'text', text: MISSING_INSTRUCTION_MESSAGE }]
      }

      const isGit = await getIsGit()
      // 非Git仓库时返回提示
      if (!isGit) {
        return [{ type: 'text', text: NOT_A_GIT_REPO_MESSAGE }]
      }

      // 构建并返回完整提示词
      return [{ type: 'text', text: buildPrompt(instruction) }]
    },
  })
}
