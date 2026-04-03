// 从会话内存工具模块导入获取会话内存内容的方法
import { getSessionMemoryContent } from '../../services/SessionMemory/sessionMemoryUtils.js'
// 导入消息类型定义
import type { Message } from '../../types/message.js'
// 从消息工具模块导入获取压缩边界后的消息方法
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
// 从捆绑技能模块导入注册捆绑技能的方法
import { registerBundledSkill } from '../bundledSkills.js'

/**
 * 提取用户消息
 * @param messages - 消息数组
 * @returns 过滤后的纯用户文本消息数组
 */
function extractUserMessages(messages: Message[]): string[] {
  return messages
    // 过滤出类型为用户的消息
    .filter((m): m is Extract<typeof m, { type: 'user' }> => m.type === 'user')
    .map(m => {
      const content = m.message.content
      // 如果内容是字符串类型，直接返回
      if (typeof content === 'string') return content
      // 过滤出文本类型的内容块并拼接
      return content
        .filter(
          (b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text',
        )
        .map(b => b.text)
        .join('\n')
    })
    // 过滤掉空文本
    .filter(text => text.trim().length > 0)
}

// 技能生成提示词模板
const SKILLIFY_PROMPT = `# 技能生成 {{userDescriptionBlock}}

你正在将会话中的可重复流程提炼为可复用的技能。

## 会话上下文

以下是会话内存摘要：
<session_memory>
{{sessionMemory}}
</session_memory>

以下是用户在本次会话中的消息。请注意用户如何引导流程，以帮助在技能中记录他们的详细偏好：
<user_messages>
{{userMessages}}
</user_messages>

## 任务说明

### 步骤1：分析会话

在提问前，先分析会话并确定以下内容：
- 执行了哪些可重复的流程
- 输入/参数是什么
- 清晰的步骤（按顺序）
- 每个步骤的成功成果/标准（例如，不只是“编写代码”，而是“CI完全通过的开放PR”）
- 用户纠正或引导你的地方
- 需要的工具和权限
- 使用的智能体
- 目标和成功成果是什么

### 步骤2：询问用户

使用用户提问功能了解用户希望自动化的内容。重要说明：
- 所有问题都必须使用用户提问功能！禁止通过纯文本提问
- 每一轮按需迭代，直到用户满意
- 始终为用户提供自由格式的“其他”选项以输入编辑内容或反馈——不要添加自定义的“需要调整”或“我会提供编辑”选项。仅提供实质性选项

**第一轮：高层级确认**
- 根据分析为技能建议名称和描述。请用户确认或重命名
- 为技能建议高层级目标和具体的成功标准

**第二轮：补充细节**
- 将识别出的高层级步骤以编号列表形式呈现。告知用户下一轮会深入细节
- 如果认为技能需要参数，根据观察结果建议参数。确保明确用户需要提供的内容
- 如果不明确，询问该技能应以内联方式（当前对话）还是分叉方式（独立上下文的子智能体）运行。分叉方式更适合无需过程中用户输入的独立任务；内联方式更适合用户希望过程中引导的场景
- 询问技能的保存位置。根据上下文建议默认值（仓库专属工作流→仓库，跨仓库个人工作流→用户）。选项：
  - **当前仓库**（\`.claude/skills/<名称>/SKILL.md\`）——用于本项目专属工作流
  - **个人**（\`~/.claude/skills/<名称>/SKILL.md\`）——跨所有仓库通用

**第三轮：拆解每个步骤**
对于每个主要步骤，若不明确，询问：
- 该步骤生成哪些后续步骤需要的内容？（数据、成果、ID）
- 如何证明该步骤成功完成，可以继续下一步？
- 是否需要用户确认后再继续？（尤其是合并、发送消息、破坏性操作等不可逆操作）
- 是否有步骤相互独立可并行执行？（例如，同时发布Slack消息和监控CI）
- 技能应如何执行？（例如，始终使用任务智能体进行代码审查，或调用智能体团队执行并发步骤）
- 有哪些硬性约束或偏好？必须发生或禁止发生的事项

此处可进行多轮用户提问，每个步骤一轮，尤其是步骤超过3个或需要大量澄清问题时。按需迭代

重要提示：特别关注会话中用户纠正你的地方，为设计提供参考

**第四轮：最终问题**
- 确认技能的触发时机，同时建议/确认触发短语（例如，挑选PR工作流可说明：用户希望将PR挑选到发布分支时使用。示例：'挑选到发布分支'、'CP此PR'、'热修复'）
- 如果仍不明确，可询问其他需要注意的问题或陷阱

获取足够信息后停止询问。重要提示：简单流程不要过度提问！

### 步骤3：编写SKILL.md文件

在用户第二轮选择的位置创建技能目录和文件

使用以下格式：

\`\`\`markdown
---
name: {{技能名称}}
description: {{单行描述}}
allowed-tools:
  {{会话中观察到的工具权限模式列表}}
when_to_use: {{Claude应自动触发该技能的详细说明，包含触发短语和用户消息示例}}
argument-hint: "{{参数占位符提示}}"
arguments:
  {{参数名称列表}}
context: {{内联或分叉——内联可省略}}
---

# {{技能标题}}
技能描述

## 输入
- \`$参数名称\`：输入说明

## 目标
工作流的明确目标。最好定义清晰的成果或完成标准

## 步骤

### 1. 步骤名称
步骤执行内容。具体且可操作。适当时包含命令

**成功标准**：必须包含！表明步骤完成可继续下一步。可使用列表形式

重要提示：参见下一部分了解每个步骤可选的注释说明

...
\`\`\`

**步骤注释说明**：
- **成功标准**：每个步骤必填。帮助模型理解用户对工作流的预期，以及何时可自信继续下一步
- **执行方式**：\`直接\`（默认）、\`任务智能体\`（简单子智能体）、\`协作伙伴\`（支持并行和智能体间通信）或\`[人工]\`（用户执行）。非直接方式时需指定
- **成果**：步骤生成的后续步骤所需数据（例如PR编号、提交哈希）。仅后续步骤依赖时包含
- **人工检查点**：需要暂停并询问用户的时机。用于不可逆操作（合并、发送消息）、错误判断（合并冲突）或输出审核
- **规则**：工作流的硬性规则。参考会话中用户的纠正内容

**步骤结构技巧**：
- 可并发执行的步骤使用子编号：3a、3b
- 需要用户操作的步骤标题添加\`[人工]\`
- 简单技能保持简洁——2步技能无需每个步骤都加注释

**前置元数据规则**：
- \`allowed-tools\`：所需最低权限（使用\`Bash(gh:*)\`等模式而非\`Bash\`）
- \`context\`：仅独立且无需过程中用户输入的技能设置\`context: fork\`
- \`when_to_use\`：至关重要——告知模型自动触发时机。以“使用场景：”开头并包含触发短语。示例：“使用场景：用户希望将PR挑选到发布分支时。示例：'挑选到发布分支'、'CP此PR'、'热修复'”
- \`arguments\`和\`argument-hint\`：仅技能需要参数时包含。正文中使用\`$名称\`进行替换

### 步骤4：确认并保存

写入文件前，将完整的SKILL.md内容以yaml代码块形式输出，方便用户通过语法高亮审核。然后使用用户提问功能请求确认，例如“此SKILL.md是否可以保存？”——不要使用正文字段，保持问题简洁

写入完成后，告知用户：
- 技能保存位置
- 触发方式：\`/{{技能名称}} [参数]\`
- 可直接编辑SKILL.md文件进行优化
`

/**
 * 注册技能生成功能
 */
export function registerSkillifySkill(): void {
  // 非指定用户类型则不注册
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  // 注册捆绑技能
  registerBundledSkill({
    name: 'skillify',
    description:
      '将本次会话的可重复流程提炼为技能。在流程结束时调用，可附带可选描述',
    allowedTools: [
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'AskUserQuestion',
      'Bash(mkdir:*)',
    ],
    userInvocable: true,
    disableModelInvocation: true,
    argumentHint: '[需要提炼的流程描述]',
    async getPromptForCommand(args, context) {
      // 获取会话内存内容
      const sessionMemory =
        (await getSessionMemoryContent()) ?? '无可用会话内存'
      // 提取用户消息
      const userMessages = extractUserMessages(
        getMessagesAfterCompactBoundary(context.messages),
      )

      // 构建用户描述块
      const userDescriptionBlock = args
        ? `用户对流程的描述："${args}"`
        : ''

      // 替换提示词模板变量
      const prompt = SKILLIFY_PROMPT.replace('{{sessionMemory}}', sessionMemory)
        .replace('{{userMessages}}', userMessages.join('\n\n---\n\n'))
        .replace('{{userDescriptionBlock}}', userDescriptionBlock)

      return [{ type: 'text', text: prompt }]
    },
  })
}