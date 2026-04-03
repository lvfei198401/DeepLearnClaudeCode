import { registerBundledSkill } from '../bundledSkills.js'

// 提示文本包含`ps`命令作为Claude要执行的指令，
// 并非本文件要执行的命令。
// eslint-disable-next-line custom-rules/no-direct-ps-commands
const STUCK_PROMPT = `# /stuck — 诊断卡死/运行缓慢的Claude Code会话

用户认为本机上的另一个Claude Code会话出现卡死、停滞或运行极慢的情况。进行排查并向#claude-code-feedback频道提交报告。

## 排查要点

扫描其他Claude Code进程（排除当前进程——进程ID在\`process.pid\`中，执行shell命令时直接排除运行本提示的进程ID即可）。进程名通常为\`claude\`（安装版）或\`cli\`（原生开发构建版）。

会话卡死的特征：
- **持续高CPU占用（≥90%）** —— 大概率是死循环。间隔1-2秒采样两次，确认不是瞬时峰值。
- **进程状态为\`D\`（不可中断睡眠）** —— 通常是I/O挂起。查看\`ps\`输出中的\`state\`列；仅关注首字符（忽略\`+\`、\`s\`、\`<\`等修饰符）。
- **进程状态为\`T\`（已停止）** —— 用户可能误按了Ctrl+Z。
- **进程状态为\`Z\`（僵尸进程）** —— 父进程未回收子进程资源。
- **极高常驻内存（≥4GB）** —— 可能存在内存泄漏导致会话运行卡顿。
- **子进程卡死** —— 挂起的\`git\`、\`node\`或shell子进程会导致父进程卡死。对每个会话执行\`pgrep -lP <pid>\`检查。

## 排查步骤

1. **列出所有Claude Code进程**（macOS/Linux系统）：
   \`\`\`
   ps -axo pid=,pcpu=,rss=,etime=,state=,comm=,command= | grep -E '(claude|cli)' | grep -v grep
   \`\`\`
   筛选\`comm\`为\`claude\`，或\`comm\`为\`cli\`且命令路径包含"claude"的行。

2. **对可疑进程**，收集更多上下文信息：
   - 子进程：\`pgrep -lP <pid>\`
   - 若CPU占用过高：间隔1-2秒再次采样，确认是持续高占用
   - 若子进程疑似挂起（如git命令），通过\`ps -p <子进程ID> -o command=\`记录完整命令行
   - 若能推断会话ID，查看会话调试日志：\`~/.claude/debug/<会话ID>.txt\`（最后几百行通常能显示挂起前的操作）

3. **对完全卡死的进程可考虑生成堆栈转储**（高级操作，可选）：
   - macOS系统：执行\`sample <进程ID> 3\`获取3秒原生堆栈采样
   - 数据量较大——仅在进程明确卡死且需要排查原因时使用

## 报告要求

**仅在确实发现卡死进程时，才向Slack提交报告。** 若所有会话状态正常，直接告知用户即可——无需向频道提交无异常报告。

若发现卡死/缓慢的会话，通过Slack MCP工具向**#claude-code-feedback**频道（频道ID：\`C07VBSHV7EV\`）提交报告。若工具未加载，通过工具搜索查找\`slack_send_message\`。

**采用双消息结构**，方便频道快速浏览：

1. **顶层消息** —— 简短一行：主机名、Claude Code版本、简洁症状（例如"会话PID 12345 CPU占用100%持续10分钟"或"git子进程处于D状态挂起"）。无代码块、无详细信息。
2. **线程回复** —— 完整诊断信息。将顶层消息的\`ts\`作为\`thread_ts\`传入。包含：
   - 进程ID、CPU占用率、常驻内存、状态、运行时长、命令行、子进程
   - 问题原因诊断
   - 相关调试日志末尾内容或捕获的\`sample\`输出

若Slack MCP不可用，将报告格式化为用户可直接复制粘贴到#claude-code-feedback频道的消息（并告知用户自行将详情作为线程回复）。

## 注意事项
- 请勿终止或发送信号给任何进程——本操作仅用于诊断。
- 若用户提供了参数（如指定进程ID或症状），优先排查对应内容。
`

export function registerStuckSkill(): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  registerBundledSkill({
    name: 'stuck',
    description:
      '[仅ANT用户] 排查本机上卡死/停滞/运行缓慢的Claude Code会话，并向#claude-code-feedback频道提交诊断报告。',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = STUCK_PROMPT
      if (args) {
        prompt += `\n## 用户提供的上下文\n\n${args}\n`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}