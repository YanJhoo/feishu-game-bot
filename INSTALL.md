# 安装教程

从零开始，大约 15 分钟。分三步：在飞书后台建应用 → 在电脑上跑起来 → 拉进群测试。

> 不想自己动手？把 [AGENT_INSTALL.md](AGENT_INSTALL.md) 里的提示词发给 Claude Code、Codex、Cursor 之类的 AI 编程助手，它会帮你完成第二步，并告诉你第一步要在飞书后台点哪里。

---

## 第一步：在飞书开放平台建应用

1. 打开 [飞书开放平台](https://open.feishu.cn/app)，点 **创建企业自建应用**，名字随意（比如「运营助手」）。
2. 左侧 **添加应用能力** → 添加 **机器人**。
3. 左侧 **凭证与基础信息** → 记下 **App ID**（`cli_` 开头）和 **App Secret**。
4. 左侧 **权限管理** → 搜索并开通下面这些权限（名字以后台显示为准）：
   | 用途 | 在权限页搜索 |
   | --- | --- |
   | 接收群里 @ 机器人的消息 | 「获取群组中用户@机器人消息」 |
   | 以机器人身份发群消息和私聊 | 「以应用的身份发消息」 |
   | 读取群成员昵称 | 「获取群组信息」或「获取群成员」 |
   | 读取消息内容 | 「获取与发送单聊、群组消息」 |
5. 左侧 **事件与回调**：
   - **事件配置** → 订阅方式选 **使用长连接接收事件** → 添加事件：
     - `im.message.receive_v1`（接收消息）
     - `im.message.recalled_v1`（消息被撤回）
   - **回调配置** → 订阅方式同样选 **长连接** → 添加回调：
     - `card.action.trigger`（卡片回传交互）

   > 选长连接时，飞书可能提示「需要先启动客户端」。那就先做完第二步、让程序跑起来，再回来保存。
6. 左侧 **版本管理与发布** → 创建版本 → 发布。企业自建应用一般由管理员审核，自己就是管理员的话马上就能通过。

> 每次改权限或事件之后，都要**重新发布一个版本**才会生效。

---

## 第二步：在电脑上跑起来

需要 [Node.js](https://nodejs.org/) 18 或更高版本（装 LTS 版就行）和 [Git](https://git-scm.com/)。

```bash
git clone https://github.com/YanJhoo/feishu-game-bot.git
cd feishu-game-bot
npm install
```

复制配置文件（Windows 用 `copy .env.example .env`）：

```bash
cp .env.example .env
```

用记事本或任意编辑器打开 `.env`，把第一步拿到的值填进去：

```dotenv
FEISHU_APP_ID=cli_你的AppID
FEISHU_APP_SECRET=你的AppSecret
```

其他选项都有默认值，可以先不动。

先跑一下测试，确认代码没问题：

```bash
npm test
```

然后启动：

```bash
npm start
```

看到 `🃏 飞书群游戏机器人启动成功` 和长连接 `ws client ready` 之类的日志，就说明连上飞书了。这个窗口要一直开着，关掉机器人就下线了。

---

## 第三步：拉进群测试

1. 在飞书里打开一个群 → 群设置 → **群机器人** → 添加你刚建的应用。
2. 在群里发：`@你的机器人 开桌`，应该会弹出大厅卡片。
3. 找另一个人一起，各自 `@机器人 加入 昵称`，再 `@机器人 开始`。
4. 每个人点「查看我的底牌」应该只看到自己的两张牌。

能走到这一步就装好了。完整命令见 [README](README.md#命令)。

---

## 让它一直在后台运行（可选）

`npm start` 关掉窗口就停了。想让它常驻，推荐用 [pm2](https://pm2.keymetrics.io/)：

```bash
npm install -g pm2
pm2 start index.js --name feishu-game-bot
pm2 save
```

常用命令：`pm2 logs feishu-game-bot` 看日志，`pm2 restart feishu-game-bot` 重启，`pm2 stop feishu-game-bot` 停止。

开机自启：Linux / macOS 运行 `pm2 startup` 按提示操作；Windows 可以装 `pm2-windows-startup`，或者用「任务计划程序」在登录时运行 `npm start`。

> 同一个应用**只能跑一个实例**。如果两台电脑同时运行，群里会收到两遍回复。

---

## 常见问题

| 现象 | 原因和解决 |
| --- | --- |
| 启动报「缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET」 | `.env` 没建或没填。确认文件名是 `.env`（不是 `.env.txt`），并且在项目根目录。 |
| 程序跑着，但群里 @ 它没反应 | ① 事件订阅没选长连接或没加 `im.message.receive_v1`；② 改完没重新发布版本；③ 机器人没被加进这个群；④ 消息里没有 @ 机器人。 |
| 卡片按钮点了没反应 | 回调配置里没加 `card.action.trigger`，或者回调没选长连接。 |
| 收不到私聊底牌 | 缺少发消息权限，或者应用的「可用范围」没包含这个人。到 **应用发布 → 可用范围** 里加上全员。 |
| 撤回补充口令后还是到账了 | 没订阅 `im.message.recalled_v1`。 |
| 想清空所有战绩重新开始 | 停掉机器人，删除 `data/` 文件夹，再启动。 |

## 数据和隐私

- 牌桌状态保存在 `data/tables.json`，战绩保存在 `data/stats.json`，里面有群成员的飞书 open_id 和昵称。
- `.env`（你的密钥）和 `data/`（玩家数据）都已经写进 `.gitignore`。如果你 fork 了这个仓库，**不要**把它们提交上去。
- 万一 App Secret 泄露了，到飞书开放平台的「凭证与基础信息」里重置。
