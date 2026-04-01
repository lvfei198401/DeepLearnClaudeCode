# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

本仓库是从 `@anthropic-ai/claude-code` npm 包（版本 2.1.88）的 source map (`cli.js.map`) 中还原的 TypeScript 源码，**仅供研究学习用途**。源码版权归 Anthropic 所有。

## 仓库结构

- `package/` — 原始 npm 发布包内容（`cli.js` 为打包后的单文件入口，`cli.js.map` 为 source map）
- `extract-sources.js` — 从 source map 提取源码的 Node.js 脚本
- `restored-src/` — 还原出的源码（4756 个文件，含 1884 个 `.ts`/`.tsx` 文件）
  - `restored-src/src/` — Claude Code 主应用源码
  - `restored-src/node_modules/` — 还原出的依赖源码
- `详细文件清单.md` — `restored-src/src/` 的完整目录树（需要查找具体文件时参考此文件）

## 常用命令

```bash
# 重新提取源码（需要 source-map 包）
node extract-sources.js

# 统计代码行数
python count_lines.py
```

本仓库不包含构建/测试/lint 脚本，因为是从打包产物逆向还原而非原始开发仓库。

## 核心架构 (restored-src/src/)

**入口**：`main.tsx` — CLI 启动入口，使用 Commander.js 解析命令行参数，通过 React (Ink) 渲染终端 UI。

**工具系统** (`tools/`)：每个工具一个目录，对应 Claude 可调用的能力（BashTool、FileEditTool、GrepTool、AgentTool、WebFetchTool 等 40+ 个）。工具接口定义在 `Tool.ts`。

**命令系统** (`commands/`)：斜杠命令实现（/commit、/compact、/config、/help 等），注册在 `commands.ts`。

**服务层** (`services/`)：
- `api/` — Anthropic API 通信、bootstrap 数据
- `mcp/` — MCP (Model Context Protocol) 服务器管理与工具调用
- `oauth/` — OAuth 认证流程
- `analytics/` — GrowthBook 特性开关、遥测
- `lsp/` — Language Server Protocol 集成
- `compact/` — 上下文压缩策略
- `policyLimits/` — 策略与速率限制

**多 Agent 协调** (`coordinator/`)：子 Agent 编排与协作模式。

**状态管理**：
- `state/` — 全局状态定义
- `context/` + `context.ts` — React Context 提供系统/用户上下文
- `bootstrap/state.ts` — 启动阶段状态初始化

**其他关键模块**：
- `hooks/` — 用户自定义 hook 执行（响应工具调用等事件的 shell 命令）
- `skills/` — 技能系统（可扩展的预定义提示词模板）
- `plugins/` — 插件系统
- `query/` + `QueryEngine.ts` — 查询引擎
- `bridge/` — 桌面应用与 Web 端的通信桥接层
- `remote/` — 远程会话管理
- `utils/` — 大量工具函数（git 操作、模型选择、认证、环境检测、设置管理等）
- `vim/` — Vim 模式键绑定
- `voice/` — 语音交互支持
