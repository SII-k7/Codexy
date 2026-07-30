# Codexy engineering guide

Codexy 是面向 Codex CLI 的非官方、单用户、本机优先手机伴侣。MVP 只维护：
状态推送、最新回复速览、会话控制、远程 Prompt、最近 10 条脱敏 Prompt、项目思路整理。

## Commands

- `npm run typecheck`: 检查 Expo/React Native TypeScript。
- `npm run relay:test`: 测试配对、鉴权、事件、会话隔离、Prompt 队列与隐私边界。
- `npm run check`: 运行全部静态检查和 Relay 测试。
- `npm run private:build`: 构建并验证私有 PWA。
- `npm run release:check`: 检查 Codexy 品牌、版本、端口与 PWA 隔离。

## Product invariants

- 产品名是 `Codexy`；不得声称是 OpenAI 官方产品或使用官方 ChatGPT/OpenAI 标志。
- 每个并行 Codex CLI 必须是独立轨道，只向手机暴露哈希会话标识和项目别名。
- `needs_you` 必须产生清晰的视觉状态和可选推送；点击含 `session_ref` 的通知必须
  回到对应会话。
- 会话页必须优先呈现最新一轮已结束的 Codex 回复速览；控制台默认折叠，只在用户
  主动展开后占用完整空间。
- 回复速览只能按需读取最新一轮已结束的 `agentMessage`，优先选择
  `phase: final_answer`。必须在电脑本机过滤代码、路径、URL、邮箱和疑似密钥，只返回
  2–4 条结构化要点；完整回复不得进入推送或 Relay 持久状态。
- 推送不得包含原始 Prompt、代码、路径、URL、邮箱、密钥、工具输入输出或对话。
- 每个会话最多保留 10 条脱敏用户 Prompt，最多 24 小时；回放不得触发推送。
- 任何整理或建议 Prompt 都必须让用户复核；不得自动提交。
- 手机完整 Prompt 必须先确认目标和文本，长度不超过 4,000 字符。Queue 是默认
  模式；Steer 必须显式选择并带 active turn 前置条件。
- 完整远程 Prompt 只可存在内存队列，终态或超时后删除，不得写入通知或持久状态。
- Codex App Server 必须保持 loopback-only；原始 thread ID 和工作目录不得返回手机。
- `turn_finished` 仅表示一轮回复结束，不得表述为整个目标已完成。

## Isolation invariants

- 原“回神”项目保持冻结；只在 `F:\codex\codexy-app` 开发 Codexy。
- Codexy Relay 默认端口是 `8797`，iPhone 预览端口是 `8084`。
- Codexy 使用自己的 `relay/.data/state.json`、App 标识和
  `codexy-shell-*` Service Worker 缓存。
- 不覆盖旧项目的启动器、状态文件、端口、PWA 安装身份或浏览器存储键。
- 日常自用只通过 localhost 与私有 Tailscale HTTPS；不要直接暴露公网。

## MVP scope

不要在 MVP 中加入阅读信息流、待办、社交、支付、广告、归因、公开账号体系或
多租户云服务。新增能力必须直接服务于 Codex 状态、输入、Prompt 回放或思路整理。
