# Codexy

Codexy 是一个面向 Codex CLI 用户的非官方手机伴侣。它把多终端 Codex
会话集中到手机上，并专注六件明确的事情：

- Codex 等待确认或完成一轮响应时，发送可直达对应会话的手机通知；
- 在会话顶部提炼最新一轮 Codex 回复，让用户用几秒钟看懂结果、验证与下一步；
- 从手机调整指定会话的模型与思考强度，并原生执行状态刷新、上下文压缩、
  Review 和停止回合；
- 从手机向指定 Codex 会话发送经过二次确认的 Prompt；
- 回看每个会话最近 10 条经过本地脱敏的用户 Prompt；
- 整理项目目标、约束、未决问题和下一条建议 Prompt。

Codexy 与 OpenAI 没有隶属、授权或背书关系。应用图标为独立设计，不使用
OpenAI 或 ChatGPT 的官方标志。

## 新人安装：只需 3 步

### 第 1 步：准备电脑和 iPhone

电脑需要：

- Windows PowerShell 5.1 或更新版本；
- 当前 Node.js LTS 与 npm；
- 已安装并登录的 Codex CLI；
- 若希望离开家庭局域网仍可使用：电脑和 iPhone 安装 Tailscale，并登录同一账号。

克隆仓库后进入目录：

```powershell
git clone https://github.com/SII-k7/Codexy.git
cd Codexy
```

### 第 2 步：先预演，再一键安装

首次运行默认是 **Dry Run**。它只检查环境、展示将要执行的范围，不会修改任何
文件、Hook、启动器、计划任务或 Tailscale 路由：

```powershell
npm.cmd run setup
```

确认输出无误后执行：

```powershell
npm.cmd run setup:apply
```

这个命令会复用仓库已有流程，依次完成依赖安装、私有 PWA 准备、Codexy 全局
Hook 增量合并和 `codexy` 启动器安装。真正写入前仍会明确列出范围，并要求输入
`INSTALL CODEXY`。

需要开机自动启动并通过 Tailscale HTTPS 使用时，请在管理员 PowerShell 中执行：

```powershell
.\scripts\setup-codexy.ps1 -Apply -InstallStartup
```

重复安装时可保留现有 `node_modules`：

```powershell
.\scripts\setup-codexy.ps1 -Apply -SkipNpmInstall
```

安装流程不会覆盖非 Codexy Hook，不会创建或修改 `acx`，也不会让
`127.0.0.1:4510` 的 Codex App Server 暴露到手机或公网。

### 第 3 步：安装到 iPhone 并开始控制

1. 在 iPhone Safari 打开启动脚本显示的私有 `https://...ts.net:8443` 地址。
2. 点击 **分享 → 添加到主屏幕**，再从主屏幕启动 Codexy。
3. 在 App 中领取六位配对码，然后在电脑运行：

   ```powershell
   npm.cmd run relay:claim -- 123456
   ```

4. 在 App 设置页启用后台通知。
5. 以后在任意项目目录运行 `codexy`；每个终端都会成为一条独立、可从手机调整
   模型、执行快捷控制并发送 Prompt 的会话轨道。

普通 `codex` 会话仍可通过 Hook 同步状态，但默认不接受远程 Prompt。需要手机
控制时请显式使用 `codexy` 启动。

## 一条命令诊断

诊断脚本完全只读，会报告 Node、Codex、Tailscale、8797/4510 端口、全局 Hook
和 `codexy` 启动器状态：

```powershell
npm.cmd run diagnose
```

它不会启动、停止或安装任何内容，也不会修改配置。

## 安全卸载

先预演 Codexy Hook 的移除范围：

```powershell
.\scripts\remove-global-hooks.ps1
```

确认后仅移除 Codexy 自有 Hook 条目与带管理标记的
`~/.codex/codexy-hooks`：

```powershell
.\scripts\remove-global-hooks.ps1 -Apply
```

再按需移除启动器和开机任务：

```powershell
npm.cmd run control:uninstall
npm.cmd run private:remove-startup
```

非 Codexy Hook、旧 `acx`、其他 Tailscale Serve 路由都会保留。开机任务卸载
不会自动执行 `tailscale serve reset`，避免误删其他服务的路由。

Codexy 使用独立的 Tailscale HTTPS `:8443` 入口代理到本机 `127.0.0.1:8797`；
这不会覆盖已经占用默认 HTTPS 根路径的其他个人应用。

## 本地开发

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd run preview:iphone
```

电脑和 iPhone 位于同一可信局域网时，在 iPhone Safari 打开：

```text
http://电脑局域网IP:8084/
```

常用命令：

```powershell
npm.cmd run typecheck
npm.cmd run relay:test
npm.cmd run private:build
npm.cmd run release:check
```

Relay 默认监听 `127.0.0.1:8797`，Codex App Server 默认监听
`127.0.0.1:4510`。`.env.local`、Relay 状态与私钥均被 Git 忽略；Codexy 使用
独立的 `CODEXY_*` 环境变量和 `~/.codex/codexy` 状态目录。

## 为什么不是另一个 Codex Remote

OpenAI 官方 Remote 适合把 ChatGPT 桌面端正在运行的 Codex 工作带到手机，覆盖远程
继续对话、审批、查看输出与在多台主机间切换。Codexy 不复制这些完整能力，而专注
普通 Codex CLI 重度用户更窄的一段工作流：

- 一眼分清多个并行 CLI 中，哪一个真正需要你；
- 在低打扰横幅中延续同一会话，而不是堆叠状态噪声；
- 在手机会话页优先显示最新回复速览，完整控制台默认只占一行、需要时再展开；
- 在每条轨道内直接切换电脑实时提供的模型和思考强度，并把 `/status`、
  `/compact`、`/review` 与停止回合映射为原生控制操作；
- 为每个会话保留独立手机草稿、Queue / Steer 与可撤回待发指令；
- 从最近 10 条脱敏用户 Prompt 恢复目标、约束、决定和未决问题。

因此 Codexy 的目标不是笼统地“替代官方 Remote”，而是在 **CLI-first、多会话、注意力
分诊与 Prompt 工作流** 这一条路径上更快上手、更少打扰。

## 隐私与控制边界

- 推送只携带生命周期状态、脱敏摘要和哈希会话标识，不携带原始 Prompt、代码、
  文件路径、工具输入输出或完整对话。
- 回复速览只在打开会话或手动刷新时读取最新一轮已结束的 Codex 回复；电脑本机先
  过滤代码、路径、链接、邮箱和疑似密钥，再返回 2–4 条结构化要点。完整回复不进入
  推送，也不写入 Relay 持久状态。
- 每个会话最多保留最近 10 条脱敏 Prompt，默认保留 24 小时；它们不会触发推送。
- 手机发送完整 Prompt 前必须确认目标和内容；默认使用 Queue。Steer 必须由用户
  明确选择，并校验当前进行中的 turn。
- 完整远程 Prompt 只短暂存在 Relay 内存队列；完成、失败、取消或超时后删除，
  不写入持久状态或通知。
- 模型与思考强度变更只作用于所选会话的后续回合；压缩、Review 和停止回合
  必须经过二次确认。快捷控制不伪装成用户 Prompt。
- 原始 Codex thread ID 与工作目录只留在电脑端；手机仅看到哈希标识和项目别名。
- `turn_finished` 只表示一轮回答结束，不代表整个项目目标已经完成。

## MVP 端到端验收

1. 两个并行 `codexy` 终端在手机显示为两条独立会话轨道；
2. 某个会话等待确认时，iPhone 收到横幅通知；
3. 点击通知直接打开对应会话；
4. 手机复核 Prompt 后可 Queue 到指定会话；
5. 会话顶部能显示最新一轮回复的 2–4 条速览要点；完整回复不会被推送或持久化；
6. 控制台默认折叠为一行，展开后能读取该电脑的实时模型目录，切换模型与思考强度，
   并明确显示“下一轮生效”；
7. `/status` 可直接刷新；压缩、Review、停止回合均有状态门禁和二次确认；
8. 最近 Prompt 数量不超过 10，敏感信息已经过滤；
9. 思路页能展示目标、约束、未决问题与下一条建议 Prompt；
10. 关闭电脑或 Relay 后，手机明确显示离线，不会假装发送成功。
