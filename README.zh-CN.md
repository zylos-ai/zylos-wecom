<p align="center">
  <strong>zylos-wecom</strong>
</p>

<p align="center">
  <a href="https://github.com/zylos-ai">Zylos</a> AI Agent 的企业微信通讯组件
</p>

<p align="center">
  <a href="https://github.com/zylos-ai/zylos-wecom/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node.js"></a>
  <a href="https://work.weixin.qq.com"><img src="https://img.shields.io/badge/WeCom-企业微信-07C160.svg" alt="WeCom"></a>
</p>

---

## 功能特性

- **WebSocket 长连接** -- 通过企业微信智能机器人 WebSocket 协议连接
- **无需公网 IP** -- 出站 WebSocket 连接，无需回调 URL 或 SSL
- **简单凭证** -- 仅需 Bot ID + Secret（2 个值，无需 corpSecret/token/AES key）
- **消息类型** -- 支持文本、Markdown 发送；文本、图片、语音、视频、文件接收
- **访问控制** -- 私聊策略(开放/白名单/仅主人)和群聊策略(按群配置)
- **主人自动绑定** -- 第一个发送私聊消息的用户自动成为主人
- **上下文追踪** -- 内存中的聊天记录用于上下文对话
- **自动重连** -- 断线后指数退避 + 随机抖动重连
- **C4 桥接** -- 标准 Zylos 通讯桥接集成
- **管理 CLI** -- 无需手动编辑 JSON 的配置管理
- **热重载** -- 配置更改无需重启即可生效(大部分设置)

## 环境要求

- Node.js >= 20.0.0
- 企业微信企业账号
- 管理员权限（用于创建智能机器人）

## 快速开始

### 1. 安装

```bash
# 通过 Zylos CLI
zylos add wecom

# 或手动安装
git clone https://github.com/zylos-ai/zylos-wecom.git ~/zylos/.claude/skills/wecom
cd ~/zylos/.claude/skills/wecom
npm install
node hooks/post-install.js
```

### 2. 创建智能机器人

1. 打开企业微信客户端 > 工作台 > 智能机器人 > 创建机器人
2. 选择 **API模式创建**（需要管理员权限）
3. 选择 **使用长连接**
4. 复制 **Bot ID**（格式：`aibXXX`）和 **Secret**
5. Secret 只显示一次 -- 立即保存

### 3. 配置凭证

添加到 `~/zylos/.env`:

```bash
WECOM_BOT_ID=aibxxxxxxxxxxxxxxxx
WECOM_BOT_SECRET=你的bot_secret
```

### 4. 启动服务

```bash
pm2 start ecosystem.config.cjs
pm2 logs zylos-wecom
```

### 5. 测试

向企业微信机器人发送一条消息。第一个发送私聊消息的用户将成为主人。

## 配置

### 配置文件

`~/zylos/components/wecom/config.json`

```json
{
  "enabled": true,
  "internal_port": 4459,
  "owner": { "bound": false, "user_id": "", "name": "" },
  "dmPolicy": "owner",
  "dmAllowFrom": [],
  "groupPolicy": "allowlist",
  "groups": {},
  "message": { "context_messages": 10, "welcome_text": "" },
  "ws": {
    "url": "wss://openws.work.weixin.qq.com",
    "heartbeat_interval": 30000,
    "reconnect_initial_delay": 1000,
    "reconnect_max_delay": 30000
  }
}
```

### 管理命令

```bash
ADM="node ~/zylos/.claude/skills/wecom/src/admin.js"

$ADM show                    # 显示完整配置
$ADM show-owner              # 显示主人信息
$ADM set-dm-policy owner     # 设置私聊策略
$ADM list-dm-allow           # 查看私聊白名单
$ADM add-dm-allow <user_id>  # 添加用户到白名单
$ADM help                    # 显示所有命令
```

## 访问控制

### 私聊策略

| 策略 | 行为 |
|------|------|
| `owner` | 仅主人可私聊(默认,最严格) |
| `allowlist` | 仅白名单用户可私聊 |
| `open` | 任何人可私聊 |

主人始终绕过所有访问检查。

### 群聊策略

| 策略 | 行为 |
|------|------|
| `disabled` | 丢弃所有群消息 |
| `allowlist` | 仅已配置的群生效(默认) |
| `open` | 响应所有群 |

## 架构设计

详见 [DESIGN.md](./DESIGN.md)。

## 服务管理

```bash
pm2 status zylos-wecom     # 查看状态
pm2 logs zylos-wecom       # 查看日志
pm2 restart zylos-wecom    # 重启服务
pm2 stop zylos-wecom       # 停止服务
```

## 许可证

[MIT](./LICENSE)
