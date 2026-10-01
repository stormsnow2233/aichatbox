# AI Chatbox

一个基于 Node.js、Express、Vue 3 和 SQLite 的 AI 聊天工作台。支持 Ollama 本地模型，也支持 OpenAI 兼容接口和 Anthropic Claude 接口。

## 功能

- 通过 `userid` 标识账户，并按用户隔离对话记录
- 流式 AI 回复、Markdown 渲染、重新生成和复制消息
- 接入 Ollama 本地模型
- 在管理后台配置多个 OpenAI 兼容或 Anthropic API 服务商
- 管理员可设置全局提示词和 Ollama 生成参数
- 用户可设置个人提示词和界面主题
- 管理员可统一控制所有用户可用的模型
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

1. 使用 `http://localhost:8000/?userid=1` 进入 ID 为 `1` 的账户；访问根地址不带 `userid` 时会显示“拒绝访问”。
2. 不同 `userid` 对应不同账户和聊天历史。请为每个用户分配稳定且不冲突的 ID。
3. 管理员使用 `http://localhost:8000/?userid=admin`。打开设置菜单中的“管理后台”后，需要输入 6 位访问码；初始访问码为 `111111`，可在后台修改。
4. 管理后台第二个分页可查看用户 ID、IP、对话数和最后活动时间；模型设置由管理员统一管理。

## 配置模型

### Ollama 本地模型

服务默认连接 `http://localhost:11434`。启动 Ollama 并拉取至少一个模型，例如：

```bash
ollama pull llama3.2
```

模型会从 Ollama 的模型列表自动读取。确保运行 `server.js` 的机器能够访问 Ollama 地址。

### 外部 API

使用 `userid=admin` 进入后，在“设置”中打开“管理后台”，添加服务商并填写：

- 显示名称
- 接口类型：OpenAI 兼容或 Anthropic
- API 根地址
- API Key
- 模型 ID 列表（可手动填写，或尝试使用“获取模型”）

保存后，管理员可在聊天界面的“模型管理”中统一启用对应模型；普通用户只能使用已启用模型。OpenAI 兼容接口需要提供兼容的模型列表及聊天补全接口；Anthropic 配置使用其 Messages API。

管理后台还可以设置全局系统提示词，以及 `temperature`、`num_ctx`、`top_p`、`top_k`、`repeat_penalty`、`seed` 和 `num_predict`。这些生成参数应用于 Ollama 对话。

## 数据与文件

- `server.js`：Express 服务、API、模型调用和数据库初始化
- `index.html`：聊天界面
- `admin.html`：管理员设置界面
- `styles/`：样式文件
- `vendor/`：本地 Vue 和 Marked 浏览器构建文件
- `chatbox.db`：运行时创建的 SQLite 数据库

`chatbox.db` 已加入 `.gitignore`，不会被 Git 跟踪。请妥善备份数据库；删除数据库会丢失应用中保存的用户、对话和设置。

## 安全与部署注意

- `userid` 是账户标识，不是密码或安全令牌；知道某个 ID 的人可以访问该账户数据。`admin` 是固定管理员 ID，不要将服务直接暴露到不可信网络。
- 管理员访问码保存在 SQLite 中，不会由管理设置读取接口返回；修改访问码后，之前签发的管理验证凭据会失效。
- 外部 API 代理地址可在管理员后台设置；留空时直连。
- 当前服务没有配置 HTTPS 或反向代理。不要直接将其暴露到不可信的公网；对外部署时应配置 TLS、网络访问控制和适当的反向代理。
- API Key 保存在本地 SQLite 数据库中。限制数据库文件的访问权限，并避免提交或分享数据库文件。

## 开发说明

启动服务请使用 `node server.js`；可用 `PORT` 环境变量指定端口。运行自动化测试请使用 `npm test`。