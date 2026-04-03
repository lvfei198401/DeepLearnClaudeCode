import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { registerBundledSkill } from '../bundledSkills.js'
import { SKILL_FILES, SKILL_MD } from './verifyContent.js'

// 解析技能Markdown内容的前置元数据和主体内容
const { frontmatter, content: SKILL_BODY } = parseFrontmatter(SKILL_MD)

// 定义技能描述，优先使用元数据中的描述，无则使用默认描述
const DESCRIPTION =
  typeof frontmatter.description === 'string'
    ? frontmatter.description
    : '通过运行应用验证代码变更是否符合预期。'

/**
 * 注册代码验证技能
 * 仅当用户类型为ant时注册该内置技能
 */
export function registerVerifySkill(): void {
  // 非指定用户类型时直接返回，不注册技能
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  // 注册内置验证技能
  registerBundledSkill({
    name: 'verify',
    description: DESCRIPTION,
    userInvocable: true,
    files: SKILL_FILES,
    // 异步获取命令执行所需的提示内容
    async getPromptForCommand(args) {
      const parts: string[] = [SKILL_BODY.trimStart()]
      // 存在用户请求参数时，追加到内容中
      if (args) {
        parts.push(`## 用户请求\n\n${args}`)
      }
      return [{ type: 'text', text: parts.join('\n\n') }]
    },
  })
}