import { open, stat } from 'fs/promises'
import { CLAUDE_CODE_GUIDE_AGENT_TYPE } from 'src/tools/AgentTool/built-in/claudeCodeGuideAgent.js'
import { getSettingsFilePathForSource } from 'src/utils/settings/settings.js'
import { enableDebugLogging, getDebugLogPath } from '../../utils/debug.js'
import { errorMessage, isENOENT } from '../../utils/errors.js'
import { formatFileSize } from '../../utils/format.js'
import { registerBundledSkill } from '../bundledSkills.js'

// 默认读取的调试日志行数
const DEFAULT_DEBUG_LINES_READ = 20
// 日志尾部读取的字节数
const TAIL_READ_BYTES = 64 * 1024

/**
 * 注册调试技能
 */
export function registerDebugSkill(): void {
  registerBundledSkill({
    name: 'debug',
    description:
      process.env.USER_TYPE === 'ant'
        ? '通过读取会话调试日志调试当前的Claude代码会话，包含所有事件日志'
        : '为当前会话启用调试日志功能，协助诊断问题',
    allowedTools: ['Read', 'Grep', 'Glob'],
    argumentHint: '[问题描述]',
    // 禁用模型自动调用，确保用户在交互模式下必须显式触发，同时避免描述占用上下文空间
    disableModelInvocation: true,
    userInvocable: true,
    async getPromptForCommand(args) {
      // 非ant用户默认不会写入调试日志，立即开启日志功能，以便捕获本次会话后续的操作记录
      const wasAlreadyLogging = enableDebugLogging()
      const debugLogPath = getDebugLogPath()

      let logInfo: string
      try {
        // 仅读取日志尾部内容，无需读取完整文件
        // 长时间会话的调试日志会无限增长，完整读取会导致内存占用飙升
        const stats = await stat(debugLogPath)
        const readSize = Math.min(stats.size, TAIL_READ_BYTES)
        const startOffset = stats.size - readSize
        const fd = await open(debugLogPath, 'r')
        try {
          const { buffer, bytesRead } = await fd.read({
            buffer: Buffer.alloc(readSize),
            position: startOffset,
          })
          const tail = buffer
            .toString('utf-8', 0, bytesRead)
            .split('\n')
            .slice(-DEFAULT_DEBUG_LINES_READ)
            .join('\n')
          logInfo = `日志大小：${formatFileSize(stats.size)}\n\n### 最后 ${DEFAULT_DEBUG_LINES_READ} 行\n\n\`\`\`\n${tail}\n\`\`\``
        } finally {
          await fd.close()
        }
      } catch (e) {
        logInfo = isENOENT(e)
          ? '尚未生成调试日志，日志功能刚刚启用。'
          : `读取调试日志最后 ${DEFAULT_DEBUG_LINES_READ} 行失败：${errorMessage(e)}`
      }

      const justEnabledSection = wasAlreadyLogging
        ? ''
        : `
## 调试日志已启用

本次会话的调试日志功能此前处于关闭状态，本次/debug调用之前的操作未被记录。

告知用户调试日志已在路径 \`${debugLogPath}\` 启用，让用户复现问题后重新读取日志。
若无法复现，可使用 \`claude --debug\` 命令重启程序，捕获启动阶段的日志。
`

      const prompt = `# 调试技能

协助用户排查当前Claude代码会话中遇到的问题。
${justEnabledSection}
## 会话调试日志

当前会话的调试日志路径：\`${debugLogPath}\`

${logInfo}

如需更多上下文信息，可在完整文件中搜索[ERROR]和[WARN]相关日志行。

## 问题描述

${args || '用户未描述具体问题，请读取调试日志并汇总所有错误、警告及异常信息。'}

## 配置文件

配置文件路径：
* 用户配置 - ${getSettingsFilePathForSource('userSettings')}
* 项目配置 - ${getSettingsFilePathForSource('projectSettings')}
* 本地配置 - ${getSettingsFilePathForSource('localSettings')}

## 操作指引

1. 查看用户的问题描述
2. 最后 ${DEFAULT_DEBUG_LINES_READ} 行展示了调试文件格式，需在完整文件中查找[ERROR]、[WARN]条目、堆栈信息及异常模式
3. 可启动${CLAUDE_CODE_GUIDE_AGENT_TYPE}子代理，理解相关的Claude代码功能
4. 用通俗易懂的语言说明排查结果
5. 提供具体的修复方案或后续操作建议
`
      return [{ type: 'text', text: prompt }]
    },
  })
}