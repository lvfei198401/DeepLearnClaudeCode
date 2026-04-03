import { readdir } from 'fs/promises'
import { getCwd } from '../../utils/工作目录.js'
import { registerBundledSkill } from '../内置技能.js'

// claudeApiContent.js 打包了247KB的.md字符串。在getPromptForCommand内懒加载
// 这样这些字符串仅在调用/claude-api时才会加载到内存中。
type 技能内容 = typeof import('./claudeApiContent.js')

type 识别到的语言 =
  | 'python'
  | 'typescript'
  | 'java'
  | 'go'
  | 'ruby'
  | 'csharp'
  | 'php'
  | 'curl'

const 语言标识: Record<识别到的语言, string[]> = {
  python: ['.py', 'requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'],
  typescript: ['.ts', '.tsx', 'tsconfig.json', 'package.json'],
  java: ['.java', 'pom.xml', 'build.gradle'],
  go: ['.go', 'go.mod'],
  ruby: ['.rb', 'Gemfile'],
  csharp: ['.cs', '.csproj'],
  php: ['.php', 'composer.json'],
  curl: [],
}

async function 识别语言(): Promise<识别到的语言 | null> {
  const 当前工作目录 = getCwd()
  let 目录项: string[]
  try {
    目录项 = await readdir(当前工作目录)
  } catch {
    return null
  }

  for (const [语言, 标识列表] of Object.entries(语言标识) as [
    识别到的语言,
    string[],
  ][]) {
    if (标识列表.length === 0) continue
    for (const 标识 of 标识列表) {
      if (标识.startsWith('.')) {
        if (目录项.some(项 => 项.endsWith(标识))) return 语言
      } else {
        if (目录项.includes(标识)) return 语言
      }
    }
  }
  return null
}

function 获取语言对应文件(
  语言: 识别到的语言,
  内容: 技能内容,
): string[] {
  return Object.keys(内容.技能文件).filter(
    路径 => 路径.startsWith(`${语言}/`) || 路径.startsWith('shared/'),
  )
}

function 处理内容(markdown文本: string, 内容: 技能内容): string {
  // 去除HTML注释。循环处理嵌套注释
  let 输出结果 = markdown文本
  let 上一次结果
  do {
    上一次结果 = 输出结果
    输出结果 = 输出结果.replace(/<!--[\s\S]*?-->\n?/g, '')
  } while (输出结果 !== 上一次结果)

  输出结果 = 输出结果.replace(
    /\{\{(\w+)\}\}/g,
    (匹配项, 键名: string) =>
      (内容.技能模型变量 as Record<string, string>)[键名] ?? 匹配项,
  )
  return 输出结果
}

function 构建内联参考文档(
  文件路径列表: string[],
  内容: 技能内容,
): string {
  const 文档片段: string[] = []
  for (const 文件路径 of 文件路径列表.sort()) {
    const markdown文本 = 内容.技能文件[文件路径]
    if (!markdown文本) continue
    文档片段.push(
      `<doc path="${文件路径}">\n${处理内容(markdown文本, 内容).trim()}\n</doc>`,
    )
  }
  return 文档片段.join('\n\n')
}

const 内联阅读指南 = `## 参考文档

系统已在下方的\`<doc>\`标签中包含你当前识别语言的相关文档。每个标签都有\`path\`属性显示其原始文件路径，可通过该属性快速找到对应章节：

### 快速任务参考

**单文本分类/摘要/提取/问答：**
→ 查看\`{lang}/claude-api/README.md\`

**聊天界面或实时响应展示：**
→ 查看\`{lang}/claude-api/README.md\` + \`{lang}/claude-api/流式响应.md\`

**长时间对话（可能超出上下文窗口）：**
→ 查看\`{lang}/claude-api/README.md\` —— 内容压缩章节

**提示词缓存/优化缓存/「缓存命中率低原因」：**
→ 查看\`shared/提示词缓存.md\` + \`{lang}/claude-api/README.md\`（提示词缓存章节）

**函数调用/工具使用/智能体：**
→ 查看\`{lang}/claude-api/README.md\` + \`shared/工具使用概念.md\` + \`{lang}/claude-api/工具使用.md\`

**批量处理（非低延迟敏感场景）：**
→ 查看\`{lang}/claude-api/README.md\` + \`{lang}/claude-api/批量处理.md\`

**多请求文件上传：**
→ 查看\`{lang}/claude-api/README.md\` + \`{lang}/claude-api/文件API.md\`

**内置工具智能体（文件/网页/终端，仅支持Python和TypeScript）：**
→ 查看\`{lang}/智能体SDK/README.md\` + \`{lang}/智能体SDK/开发模式.md\`

**错误处理：**
→ 查看\`shared/错误码.md\`

**通过网络获取最新文档：**
→ 查看\`shared/实时资源.md\`获取URL地址`

function 构建提示词(
  语言: 识别到的语言 | null,
  参数: string,
  内容: 技能内容,
): string {
  // 提取技能提示词到「阅读指南」章节之前的内容
  const 清理后提示词 = 处理内容(内容.技能提示词, 内容)
  const 阅读指南索引 = 清理后提示词.indexOf('## 阅读指南')
  const 基础提示词 =
    阅读指南索引 !== -1
      ? 清理后提示词.slice(0, 阅读指南索引).trimEnd()
      : 清理后提示词

  const 内容片段: string[] = [基础提示词]

  if (语言) {
    const 文件路径列表 = 获取语言对应文件(语言, 内容)
    const 定制阅读指南 = 内联阅读指南.replace(/\{lang\}/g, 语言)
    内容片段.push(定制阅读指南)
    内容片段.push(
      '---\n\n## 已包含文档\n\n' +
        构建内联参考文档(文件路径列表, 内容),
    )
  } else {
    // 未识别到语言——包含所有文档，让模型主动询问
    内容片段.push(内联阅读指南.replace(/\{lang\}/g, 'unknown'))
    内容片段.push(
      '未自动检测到项目语言。请询问用户使用的编程语言，然后参考下方对应文档。',
    )
    内容片段.push(
      '---\n\n## 已包含文档\n\n' +
        构建内联参考文档(Object.keys(内容.技能文件), 内容),
    )
  }

  // 保留「何时使用网络获取」和「常见问题」章节
  const 网络获取索引 = 清理后提示词.indexOf('## 何时使用网络获取')
  if (网络获取索引 !== -1) {
    内容片段.push(清理后提示词.slice(网络获取索引).trimEnd())
  }

  if (参数) {
    内容片段.push(`## 用户请求\n\n${参数}`)
  }

  return 内容片段.join('\n\n')
}

export function 注册ClaudeAPI技能(): void {
  注册内置技能({
    name: 'claude-api',
    description:
      '使用Claude API或Anthomic SDK构建应用。\n' +
      '触发条件：代码导入`anthropic`/`@anthropic-ai/sdk`/`claude_agent_sdk`，或用户请求使用Claude API、Anthomic SDK、智能体SDK。\n' +
      '不触发条件：代码导入`openai`/其他AI SDK、通用编程任务、机器学习/数据科学任务。',
    allowedTools: ['读取文件', '文本搜索', '文件匹配', '网络获取'],
    userInvocable: true,
    async getPromptForCommand(参数) {
      const 内容 = await import('./claudeApiContent.js')
      const 语言 = await 识别语言()
      const 提示词 = 构建提示词(语言, 参数, 内容)
      return [{ type: 'text', text: 提示词 }]
    },
  })
}