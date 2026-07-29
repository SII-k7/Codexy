# Codexy iPhone MVP 验收

## 目标

使用一台 Windows 电脑、同一 Tailnet 中的一台 iPhone 和至少两个并行 Codex CLI，
验证安装、通知、深链、远程 Prompt、草稿隔离和 Prompt 回放。

## 安装前检查

```powershell
npm.cmd run check
npm.cmd run private:build
npm.cmd run release:check
npm.cmd run diagnose
```

`diagnose` 必须能分别显示 Node、Codex、Tailscale、Relay 8797、App Server 4510、
全局 Hook 与 `codexy` 启动器状态。

## iPhone 安装

1. 在电脑预演 `npm.cmd run setup`。
2. 确认范围后运行 `npm.cmd run setup:apply`；需要开机启动时改用管理员 PowerShell
   执行 `.\scripts\setup-codexy.ps1 -Apply -InstallStartup`。
3. iPhone Safari 打开脚本给出的私有 `https://...ts.net:8443` 地址。
4. 选择“分享 → 添加到主屏幕”，从主屏幕打开 Codexy。
5. 连接 Relay，在电脑领取配对码，再回到设置页开启后台通知。

## 功能验收

1. 在两个项目目录分别运行 `codexy`，发送不同 Prompt。
2. 手机出现两条独立轨道，短码不同，最近 Prompt 不串线。
3. 在第三个终端触发等待用户决定；锁屏时收到横幅。
4. 点击横幅，必须直达对应会话。
5. 点“我知道了”后会话仍保持“需要你决定”；回电脑真正处理后才变化。
6. 为两个会话分别写草稿，来回关闭和打开，内容仍各自保留。
7. Queue 一条 Prompt，发送前页核对目标、模式和全文；在未送达时测试撤回。
8. 将通知语气切到“有点人味”，频率切到“只推需要我”，触发一次测试事件。
9. 停止 Relay，10 秒内应显示离线；草稿保留，发送被禁用。
10. 恢复 Relay 后发送草稿，回执必须明确送达状态。

## 通过标准

- 无 Prompt、路径、代码或工具内容出现在系统横幅。
- 同一会话通知延续更新，不同会话不会跳错。
- `turn_finished` 始终描述为“本轮结束”。
- 断线与失败不出现假成功。
- 普通用户日常只需在项目目录运行 `codexy`。
