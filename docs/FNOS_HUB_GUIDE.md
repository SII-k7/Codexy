# 飞牛 NAS：安装与排障

完整构建、配置、电脑接入、手机登录与更新流程见 [README](../README.md#全流程部署)。NAS 只作为中枢，不需要安装 Codex CLI。以下针对飞牛部署中可能遇到的问题，不含任何个人设备地址或访问凭据。

## Tailscale 路径与私有 HTTPS

安装器优先查找 PATH 中的 `tailscale`；否则尝试飞牛应用路径 `/var/apps/tailscale/target/bin/tailscale`，配套 socket 默认 `/vol1/@appdata/tailscale/tailscaled.sock`。应用数据盘不同或手工安装时，显式指定：

```sh
sudo env CODEXY_TAILSCALE_BIN=/actual/path/tailscale \
  CODEXY_TAILSCALE_SOCKET=/actual/path/tailscaled.sock \
  sh ./install.sh
```

标准 Linux Tailscale 安装使用其默认 socket，无需指定。安装器不会启用 Funnel，不覆盖已有的不同 8443 路由，也不会重置 NAS 其他 Serve 配置。HTTPS 地址使用中枢自己的 `*.ts.net` 域名；FN Connect 地址是 NAS 管理入口，不是 Codexy Hub 的入口。

查看飞牛路由示例（按实际路径调整）：

```sh
sudo /var/apps/tailscale/target/bin/tailscale \
  --socket=/vol1/@appdata/tailscale/tailscaled.sock serve status
```

## Docker 镜像拉取出现 401 Unauthorized

若构建 `node:22-alpine` 时错误指向镜像加速域名，失败发生在基础镜像下载阶段，并非 Codexy 登录密钥错误。可先修复该镜像源的访问权限，或在**本项目部署目录** `.env` 中添加：

```dotenv
CODEXY_NODE_IMAGE=public.ecr.aws/docker/library/node:22-alpine
```

然后重新运行 `sudo sh ./install.sh`。这是 Docker Official Images 的 ECR Public 分发地址，仍要求 NAS 能访问该仓库；不要修改全局 Docker 镜像配置或其他应用。需要固定版本时用自己已验证的 `@sha256:…` 摘要替换标签。仓库中的 `scripts/probe-hub-image.py` 可检查该源的 amd64 镜像元数据与部分下载链路，不代表所有架构或完整构建均通过。

## SSH 提示没有用户主目录

`Could not chdir to home directory ...` 表示账号已通过认证，但系统登记的主目录尚未创建。先运行 `getent passwd "$(id -un)"` 核对真实主目录；确认 `$HOME` 正确后再执行：

```sh
sudo mkdir -p "$HOME"
sudo chown "$(id -un):$(id -gn)" "$HOME"
chmod 750 "$HOME"
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
```

不要照抄其他人的账号、目录或公钥。已有 `authorized_keys` 文件的所有者应为该用户，权限通常为 600。首次 SSH 连接应核对主机指纹。

若日志显示 `correct key but not from a permitted host`，说明公钥匹配，但 `authorized_keys` 的 `from=` 限制与 NAS 实际看到的来源不符。飞牛的某些 Tailscale 部署方式会让 sshd 看到 `127.0.0.1`，应根据日志和实际网络方式调整这把专用密钥的允许来源；不要关闭全局 SSH 校验。

## 容器读取 config.json 失败

初始化应由普通部署用户执行；`.env` 的 `CODEXY_HUB_UID` / `CODEXY_HUB_GID` 应与该用户的 `id -u` / `id -g` 一致。目录 700 和文件 600 要求容器用户能够读取。不要通过把密钥文件改成所有人可读来绕过权限问题。

如果之前以 root 初始化，可在核对部署目录后，把该目录下 `data/`、`access/` 的所有权修正到部署用户，再补齐 UID/GID 配置。只处理这个部署目录，不递归修改共享盘权限。

## 手机打不开 / 状态未知

1. 在 NAS 确认 `curl --fail http://127.0.0.1:8797/healthz` 成功，且 `docker compose ps` 显示 Hub 在运行。
2. 检查手机和 NAS 的 Tailscale 在线、网络访问规则允许 8443；用 Serve 状态打印的 HTTPS 地址进入。
3. 手机要求“中枢访问密钥”时，使用部署目录 `access/phone-access.txt`；不是 NAS 密码、agent token 或六位配对码。
4. Hub 可打开但电脑不在线：检查工作电脑的 Relay、有效本地配对、`CODEXY_HUB_AGENT_CONFIG` 绝对路径、独立 host ID/token，以及该电脑到中枢的 Tailscale 连接。
5. 电脑在线但某个会话不可控：确认会话由 `codexy` 启动并连接 App Server。历史会话、休眠电脑或未提供运行指标的 Codex 版本不能凭旧快照当作实时运行。

## 更新原则

先备份私有部署目录，再覆盖新部署包并执行安装器。保留 `.env`、`data/` 和 `access/`，不要重新生成手机密钥；同步更新电脑 Relay。中枢重启会暂时清空在线快照，电脑重连后恢复。工作电脑 Relay 重启会清空待发送的内存队列，更新前先处理这些指令。
