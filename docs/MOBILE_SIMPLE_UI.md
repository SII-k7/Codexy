# 简洁手机界面

首页显示“正在推进”和“等待指令”的会话数量，点击数量可筛选，再点一次恢复全部。需要处理的会话置顶；离线和没有实时运行证据的会话单列，不计入正在推进。

点击会话依次查看最近进展、上一条脱敏 Prompt 和下一轮输入框。等待指令仅表示本轮结束，不表示整个目标完成。设备管理和退出中枢收在设置。

发送前复核目标电脑、会话和文本，统一使用下一轮队列；收到已送达才清空草稿。草稿按电脑和会话隔离，离线时保留。授权与选择仍需在电脑端处理。

验证：类型检查、105 项测试、390×844 浏览器布局检查；隔离模拟中枢验证目标确认、单主机发送、回执清空、跨设备草稿隔离。截图保存在 output/playwright/simple-home.png 和 simple-detail.png。

NAS 更新包使用原有 install.sh；上传源码不会改变当前运行容器，需要 sudo 重建才能生效。

## 会话常用功能

- 输入框上方提供 `/goal` 与 `/model`。输入 `/goal 目标内容` 或 `/model` 后也可点击打开对应设置，不会作为普通 Prompt 发送。
- Goal 使用 Codex 原生 `thread/goal/get` / `thread/goal/set`；支持明确确认后设置目标、可选 token 预算、暂停和继续。原文仅送入选中电脑的 Codex，Relay 不写入持久状态，返回手机的目标会脱敏。不通过生成额外 Prompt 来假装启用 Goal。
- 模型与思考强度来自账户的实时模型目录，仅作用于所选会话的后续回合；不支持的强度拒绝应用。
- Context used 使用 `thread/tokenUsage/updated` 的最近一次 `last.totalTokens / modelContextWindow` 估算，不使用会话累计消耗。尚未收到事件、断线重连或切换模型时显示暂不可用。
- Weekly left 根据 `windowDurationMins = 10080` 识别一周窗口，支持该窗口出现在 primary 或 secondary；缺失数据不等于 0。额度属于电脑登录的账户，短时窗口不冒充 weekly。
- 进入详情后读取数字与 Goal 状态；后续响应事件更新并复用一分钟账户额度缓存。不会为读取状态启动会话。

验证：117 项检查测试通过，390×844 模拟环境验证模型/强度切换、Goal 目标和预算确认、启用及暂停。真实电脑 runtime 接口返回 200、Goal 可用和 weekly 剩余值；未更改真实会话目标或模型。NAS 更新已备份并准备，需要运行安装脚本重建生效。

接口参考：[Codex App Server](https://learn.chatgpt.com/docs/app-server)。
