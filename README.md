# AI Chatbox

一个基于 Node.js、Express、Vue 3 和 SQLite 的 AI 聊天工作台。支持 Ollama 本地模型，也支持 OpenAI 兼容接口和 Anthropic Claude 接口。

## 功能

- 用户注册、登录，以及按用户隔离的对话记录
- 流式 AI 回复、Markdown 渲染、重新生成和复制消息
- 接入 Ollama 本地模型
- 在管理后台配置多个 OpenAI 兼容或 Anthropic API 服务商
- 管理员可设置全局提示词和 Ollama 生成参数
- 用户可设置个人提示词、启用模型和界面主题
- SQLite 本地保存用户、对话和应用设置

## 环境要求

- Node.js（建议使用当前受支持的 LTS 版本）
- npm
- 使用本地模型时，需要安装并运行 [Ollama](https://ollama.com/)，并至少下载一个模型

## 安装与启动

在项目根目录执行：

```bash
npm install
node server.js
```

默认访问地址：<http://localhost:8000>

可通过 `PORT` 环境变量修改端口：

```powershell
$env:PORT = 8080
node server.js
```

```bash
PORT=8080 node server.js
```

首次启动会在运行目录创建 `chatbox.db`，并初始化所需的数据表和默认配置。请从项目根目录启动服务，以便数据库文件位于项目目录中。

## 首次使用

1. 打开 <http://localhost:8000>。
2. 注册默认开放，不需要邀请码。管理员可在 `admin.html` 设置注册邀请码；设置后用户必须提供匹配的邀请码，清空后恢复开放注册。
3. 默认管理员账号为 `admin`，默认密码为 `admin123`。
4. 登录后打开侧边栏“设置”。管理员可进入“管理后台”配置模型；普通用户可在“模型管理”中选择自己要使用的模型。

请在部署前修改默认管理员密码。编辑根目录的 `config.txt`：

```text
admin_username=your_admin_name
admin_password=use_a_strong_password
```

保存后重启服务。服务启动时会使用该文件中的管理员用户名和密码更新管理员账号。若配置文件不存在，服务会自动以默认值创建该文件。

## 配置模型

### Ollama 本地模型

服务默认连接 `http://localhost:11434`。启动 Ollama 并拉取至少一个模型，例如：

```bash
ollama pull llama3.2
```

模型会从 Ollama 的模型列表自动读取。确保运行 `server.js` 的机器能够访问 Ollama 地址。

### 外部 API

以管理员账号登录，在“设置”中打开“管理后台”，添加服务商并填写：

- 显示名称
- 接口类型：OpenAI 兼容或 Anthropic
- API 根地址
- API Key
- 模型 ID 列表（可手动填写，或尝试使用“获取模型”）

保存后，用户可通过“模型管理”启用对应模型。OpenAI 兼容接口需要提供兼容的模型列表及聊天补全接口；Anthropic 配置使用其 Messages API。

管理后台还可以设置全局系统提示词，以及 `temperature`、`num_ctx`、`top_p`、`top_k`、`repeat_penalty`、`seed` 和 `num_predict`。这些生成参数应用于 Ollama 对话。

## 数据与文件

- `server.js`：Express 服务、API、模型调用和数据库初始化
- `index.html`：聊天界面
- `admin.html`：管理员设置界面
- `styles/`：样式文件
- `vendor/`：本地 Vue 和 Marked 浏览器构建文件
- `config.txt`：管理员账号配置
- `chatbox.db`：运行时创建的 SQLite 数据库

`config.txt` 和 `chatbox.db` 已加入 `.gitignore`，不会被 Git 跟踪。请妥善备份数据库；删除数据库会丢失应用中保存的账号、对话和设置。

## 安全与部署注意

- 注册默认开放；邀请码由管理员在后台设置并保存在 SQLite 中。若服务部署在公网，建议设置邀请码或在网络层限制访问。
- 新用户密码使用带随机盐的 scrypt 哈希保存；旧 SHA-256 密码会在用户成功登录时自动升级。
- 首页访问验证只在浏览器端执行，不应作为服务端访问控制。
- 管理员初始凭据是公开默认值；部署前请修改 `config.txt` 中的管理员凭据。
- 外部 API 代理地址可在管理员后台设置；留空时直连。
- 当前服务没有配置 HTTPS 或反向代理。不要直接将其暴露到不可信的公网；对外部署时应配置 TLS、网络访问控制和适当的反向代理。
- API Key 保存在本地 SQLite 数据库中。限制数据库文件的访问权限，并避免提交或分享数据库文件。

## 开发说明

`package.json` 当前未定义启动或自动化测试脚本。启动开发服务请使用 `node server.js`；可用 `PORT` 环境变量指定端口。