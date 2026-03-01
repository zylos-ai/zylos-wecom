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

- **Webhook 集成** -- 通过加密 webhook 回调接收企业微信消息
- **企业微信加密** -- 完整的 AES-256-CBC 加解密实现
- **消息类型** -- 支持文本、Markdown、图片、文件的收发
- **媒体处理** -- 通过企业微信临时素材 API 上传和下载媒体文件
- **访问控制** -- 私聊策略(开放/白名单/仅主人)和群聊策略(按群配置)
- **主人自动绑定** -- 第一个发送私聊消息的用户自动成为主人
- **上下文追踪** -- 内存中的聊天记录用于上下文对话
- **C4 桥接** -- 标准 Zylos 通讯桥接集成
- **管理 CLI** -- 无需手动编辑 JSON 的配置管理
- **热重载** -- 配置更改无需重启即可生效(大部分设置)
- **优雅关闭** -- SIGINT/SIGTERM 信号下的资源清理

## 环境要求

- Node.js >= 20.0.0
- 企业微信企业账号
- 已创建自建应用并开启消息接收
- 用于 webhook 回调的公网 HTTPS 地址

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

### 2. 配置凭证

添加到 `~/zylos/.env`:

```bash
WECOM_CORP_ID=ww...
WECOM_CORP_SECRET=应用Secret
WECOM_AGENT_ID=1000002
WECOM_TOKEN=回调Token
WECOM_ENCODING_AES_KEY=回调EncodingAESKey_43位
```

### 3. 企业微信后台配置

1. 登录[企业微信管理后台](https://work.weixin.qq.com)
2. 创建自建应用
3. 在应用设置中开启"接收消息":
   - 设置回调 URL: `https://your-domain.com/wecom/webhook`
   - 设置 Token 和 EncodingAESKey(与 .env 中相同)
4. 记下 AgentId 和 Secret

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
  "webhook_port": 3459,
  "bot": { "agent_id": 0 },
  "owner": { "bound": false, "user_id": "", "name": "" },
  "dmPolicy": "owner",
  "dmAllowFrom": [],
  "groupPolicy": "allowlist",
  "groups": {},
  "proxy": { "enabled": false, "host": "", "port": 0 },
  "message": { "context_messages": 10, "useMarkdownCard": false }
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
$ADM set-markdown on         # 启用 Markdown 消息
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
