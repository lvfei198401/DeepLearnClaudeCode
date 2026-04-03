// 用于验证捆绑技能的内容。
// 每个 .md 文件在构建时通过 Bun 的文本加载器以内联字符串的形式导入。

import cliMd from './verify/examples/cli.md'
import serverMd from './verify/examples/server.md'
import skillMd from './verify/SKILL.md'

export const SKILL_MD: string = skillMd

export const SKILL_FILES: Record<string, string> = {
  'examples/cli.md': cliMd,
  'examples/server.md': serverMd,
}