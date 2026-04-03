import {
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  DEFAULT_MAX_AGE_DAYS,
  isKairosCronEnabled,
} from '../../tools/ScheduleCronTool/prompt.js'
import { registerBundledSkill } from '../bundledSkills.js'

// 默认执行间隔
const DEFAULT_INTERVAL = '10m'

// 使用说明信息
const USAGE_MESSAGE = `使用方法: /loop [间隔时间] <指令/提示词>

按照固定循环间隔执行提示词或斜杠命令。

间隔格式: 数字+单位（Ns秒、Nm分钟、Nh小时、Nd天，例如 5m、30m、2h、1d）。最小精度为1分钟。
如果未指定间隔时间，默认使用 ${DEFAULT_INTERVAL}。

示例:
  /loop 5m /babysit-prs
  /loop 30m 检查部署状态
  /loop 1h /standup 1
  /loop 检查部署状态          (默认使用 ${DEFAULT_INTERVAL})
  /loop 每20分钟检查部署状态`

/**
 * 构建处理循环任务的提示词内容
 * @param args 用户输入的参数
 * @returns 格式化后的提示词字符串
 */
function buildPrompt(args: string): string {
  return `# /loop 命令 — 调度循环执行的提示词

将下方输入解析为 \`[间隔时间] <提示词...>\` 格式，并通过 ${CRON_CREATE_TOOL_NAME} 进行调度。

## 解析规则（按优先级排序）

1. **开头匹配**：如果第一个以空格分隔的字符符合 \`^\\d+[smhd]$\` 格式（例如 \`5m\`、\`2h\`），则该部分为间隔时间，剩余内容为提示词。
2. **结尾"every/每"匹配**：若输入以 \`every <数字><单位>\` 或 \`every <数字> <单位全称>\` 结尾（例如 \`every 20m\`、\`every 5 minutes\`、\`every 2 hours\`），提取该部分作为间隔时间并从提示词中移除。仅当"every/每"后跟随时间表达式时匹配 —— \`check every PR\` 无有效间隔时间。
3. **默认规则**：不满足以上条件时，间隔时间为 \`${DEFAULT_INTERVAL}\`，全部输入内容作为提示词。

若解析后的提示词为空，展示使用说明 \`/loop [间隔时间] <提示词>\` 并终止执行 —— 不调用 ${CRON_CREATE_TOOL_NAME}。

示例:
- \`5m /babysit-prs\` → 间隔 \`5m\`，提示词 \`/babysit-prs\`（规则1）
- \`check the deploy every 20m\` → 间隔 \`20m\`，提示词 \`check the deploy\`（规则2）
- \`run tests every 5 minutes\` → 间隔 \`5m\`，提示词 \`run tests\`（规则2）
- \`check the deploy\` → 间隔 \`${DEFAULT_INTERVAL}\`，提示词 \`check the deploy\`（规则3）
- \`check every PR\` → 间隔 \`${DEFAULT_INTERVAL}\`，提示词 \`check every PR\`（规则3 — "every"后无时间）
- \`5m\` → 提示词为空 → 展示使用说明

## 间隔时间 → 定时表达式

支持的单位后缀: \`s\`（秒，向上取整为分钟，最小1分钟）、\`m\`（分钟）、\`h\`（小时）、\`d\`（天）。转换规则:

| 间隔格式            | 定时表达式       | 备注                                      |
|---------------------|------------------|-------------------------------------------|
| \`Nm\` 且 N ≤ 59    | \`*/N * * * *\`  | 每N分钟执行一次                           |
| \`Nm\` 且 N ≥ 60    | \`0 */H * * *\`  | 转换为小时（H = N/60，需能被24整除）|
| \`Nh\` 且 N ≤ 23    | \`0 */N * * *\`  | 每N小时执行一次                           |
| \`Nd\`              | \`0 0 */N * *\`  | 每N天在本地时间午夜执行                   |
| \`Ns\`              | 按 \`ceil(N/60)m\` 处理 | 定时任务最小精度为1分钟              |

**若间隔时间无法被对应单位整除**（例如 \`7m\` → \`*/7 * * * *\` 会在56分→0分产生不均匀间隔；\`90m\` → 1.5小时无法用定时表达式表示），选择最接近的合规间隔，并在调度前告知用户取整结果。

## 执行操作

1. 调用 ${CRON_CREATE_TOOL_NAME} 并传入参数:
   - \`cron\`: 上述表格生成的定时表达式
   - \`prompt\`: 解析后的原始提示词（斜杠命令原样传递）
   - \`recurring\`: \`true\`
2. 简要确认信息：已调度的内容、定时表达式、人类可读的执行周期、循环任务将在 ${DEFAULT_MAX_AGE_DAYS} 天后自动过期，可通过 ${CRON_DELETE_TOOL_NAME} 提前取消（包含任务ID）。
3. **立即执行解析后的提示词** —— 无需等待首次定时触发。如果是斜杠命令，通过技能工具调用；否则直接执行。

## 用户输入

${args}`
}

/**
 * 注册循环任务技能
 */
export function registerLoopSkill(): void {
  registerBundledSkill({
    name: 'loop',
    description:
      '按照固定循环间隔执行提示词或斜杠命令（例如 /loop 5m /foo，默认间隔10分钟）',
    whenToUse:
      '当用户需要设置循环任务、轮询状态、或按间隔重复执行某操作时使用（例如 "每5分钟检查部署状态"、"持续执行 /babysit-prs"）。一次性任务请勿调用。',
    argumentHint: '[间隔时间] <提示词>',
    userInvocable: true,
    isEnabled: isKairosCronEnabled,
    async getPromptForCommand(args) {
      const trimmed = args.trim()
      if (!trimmed) {
        return [{ type: 'text', text: USAGE_MESSAGE }]
      }
      return [{ type: 'text', text: buildPrompt(trimmed) }]
    },
  })
}