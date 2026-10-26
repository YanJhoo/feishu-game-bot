<div align="center">

# 🃏 飞书德州扑克机器人

**拉进飞书群就能玩的德州扑克和谁是卧底。点按钮下注，底牌只有你自己看得到，不需要服务器。**

[![Test](https://github.com/YanJhoo/feishu-poker-bot/actions/workflows/test.yml/badge.svg)](https://github.com/YanJhoo/feishu-poker-bot/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Feishu / Lark](https://img.shields.io/badge/飞书%20%2F%20Lark-机器人-3370FF)](https://open.feishu.cn/)

[安装教程](INSTALL.md) · [让 AI 帮你装](AGENT_INSTALL.md) · [命令一览](#命令) · [English](#english)

</div>

<!--
  演示动图：录一段群里「开桌 → 牌桌卡片 → 查看我的底牌 → 结算」的屏幕录像，
  转成 GIF（建议宽 800px 以内、5MB 以内），保存为 docs/demo.gif，
  然后把下面这行图片代码移到注释外面（删掉这整段注释，只保留图片那一行）。
<p align="center"><img src="docs/demo.gif" alt="群聊演示" width="720"></p>
-->

## ✨ 亮点

- 🎴 **全程卡片操作**：牌桌、公共牌、底池、筹码实时更新，过牌 / 跟注 / 加注 / 弃牌一键点按钮，还有半池、满池快捷加注
- 🔒 **底牌真私密**：点「查看我的底牌」后只有你自己的客户端能看到，旁观者和旧卡片都看不了
- 🕵️ **不止德州**：内置「谁是卧底」，机器人匿名代发描述、匿名投票，最后才揭晓身份
- 🏆 **战绩和每日称号**：自动记录胜负和最大单局盈利，每天早上 9 点在群里发布昨日称号榜
- 🖥️ **零服务器**：用飞书长连接收事件，不需要公网 IP 和域名，一台能联网的电脑就能跑
- ✅ **规则严谨**：完整边池、7 选 5 比牌、短码全下不重开加注，41 个测试覆盖核心规则

## 安装

| 方式 | 适合 |
| --- | --- |
| 📖 [**安装教程 INSTALL.md**](INSTALL.md) | 自己动手，从建飞书应用到后台常驻，一步一步来，约 15 分钟 |
| 🤖 [**交给 AI 助手 AGENT_INSTALL.md**](AGENT_INSTALL.md) | 复制一段提示词给 Claude Code / Codex / Cursor，让它帮你装 |
| ⚡ 下面的「快速开始」 | 熟悉飞书开放平台和 Node.js 的人 |

## 完整功能

- 以 `chat_id` 隔离牌桌；不同群可同时游戏。
- 最多 9 人、昵称与固定座位、初始筹码；每局安全随机庄家，小盲/大盲按顺时针确定。
- 使用 Node `crypto.randomInt` 的 52 张牌 Fisher–Yates 安全洗牌。
- 完整 Preflop / Flop / Turn / River / Showdown 状态机，以及公共牌群消息。
- `过牌`、`跟注`、`加注`、`弃牌`、`allin`，包含轮到谁、最小加注和短码全下不重新开放加注的规则。
- 动态主池与边池、7 选 5 牌型判断、同牌分池与余码顺时针分配。
- 私聊底牌和轮到行动提醒；可配置行动超时自动弃牌。
- 群内实时牌桌卡片：公共牌图形、底池、玩家筹码，以及过牌/跟注、最小加注、All-in、弃牌按钮。
- 行动卡提供半池、三分之二池、满池快捷加注，并显示跟注后的底池赔率、阶段进度和最近三次行动。
- 支持暂停/恢复参赛；连续两次超时会从下一局自动暂停。
- 群牌桌采用独享更新模式；玩家点击“查看我的底牌”后，只在自己的客户端看到本人底牌，旁观者和旧局卡均无法查看。
- 行动超时前再次 @ 玩家提醒；结算后筹码低于 1000 的玩家可用六档固定额度口令补充筹码，每局一次，最终不超过 1000，并为筹码王保留至少 200 优势。
- 开局、公共牌、行动和结算均使用卡片；常用行动使用按钮，其他加注额可发送“加注 数字金额”。
- 每局自动统计参局数、胜局、净胜负和最高单局盈利，保存于 `data/stats.json`，重启后保留。
- 每天北京时间 09:00 只在配置的大群发布上一日称号；其他群的牌局不会进入该榜单。
- 全员同等房间权限、重复事件过滤、每群消息串行处理、基础离桌和解散保护。
- 交互卡片预留适配层：`src/interaction-adapter.js` 可将卡片回调转换为同一套命令，核心规则无需变更。
- 群活动大厅支持德州扑克、谁是卧底；谁是卧底包含私发词语、随机发言顺序、机器人匿名代发、匿名投票/弃票、身份揭晓、结算与永久比分。

## 快速开始

1. 先按下面「飞书开放平台设置」建好应用，拿到 App ID 和 App Secret，并把机器人拉进你的群。

2. 下载代码并安装依赖：

   ```bash
   git clone https://github.com/YanJhoo/feishu-poker-bot.git
   cd feishu-poker-bot
   npm install
   ```

3. 复制环境变量示例并填写飞书应用凭据（Windows 用 `copy`，macOS / Linux 用 `cp`）：

   ```bash
   cp .env.example .env
   ```

   `.env` 至少需要：

   ```dotenv
   FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
   FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
   ```

   `.env` 里是你的密钥，已经写进 `.gitignore`，**不要提交到任何仓库**。

   可选项：

   ```dotenv
   TURN_TIMEOUT_MS=60000
   TURN_WARNING_MS=10000
   STARTING_STACK=1000
   SMALL_BLIND=5
   BIG_BLIND=10
   BAILOUT_DELAY_MS=10000
   ALLOW_SOLO_GAME=false
   TURN_CARD_MODE=private
   DAILY_TITLE_CHAT_ID=
   ```

   每个选项的含义见 `.env.example` 里的注释。`DAILY_TITLE_CHAT_ID` 填一个群的 `oc_` 开头的 chat_id，每天北京时间 09:00 会在这个群发布前一天的称号榜；留空则不发。

4. 启动：

   ```bash
   npm start
   ```

   正常会显示：

   ```text
   🃏 飞书德州扑克机器人启动成功（文字命令版）
   ```

## 飞书开放平台设置

1. 在 [飞书开放平台](https://open.feishu.cn/app) 创建「企业自建应用」，在「添加应用能力」里加上**机器人**。
2. 在「凭证与基础信息」里拿到 App ID 和 App Secret，填进 `.env`。
3. 在「权限管理」里开通收发群消息、读取群成员、给用户发单聊消息等相关权限。
4. 在「事件与回调」里选择**使用长连接接收事件**，按下面的说明订阅事件和回调。
5. 发布应用版本，然后把机器人添加到要玩的群里。

应用需开启长连接并订阅事件 `im.message.receive_v1` 和 `im.message.recalled_v1`，同时在“事件与回调 → 回调配置”中添加 `card.action.trigger`。缺少撤回事件时，机器人无法取消已撤回的补充口令；缺少卡片回调时按钮不会响应。机器人还需要群消息与发送消息的权限，并必须能向用户单聊发送消息；否则私聊底牌会被飞书拒绝。

机器人只处理群聊的文本消息；请在群里 @ 机器人后发送命令。由于事件中通常没有用户展示名，第一次加入建议使用 `加入 昵称`。

## 命令

在群里 @ 机器人会打开“顶尖运营”大厅（默认名字是“运营助手”，用 `FEISHU_BOT_NAME` 改成你自己的机器人名字），可选择德州扑克或谁是卧底。谁是卧底支持 `加入`、`开始`、群内独享输入卡匿名描述、趣味代号投票、`弃票` 和 `比分`；每轮顺序随机，结算时才揭晓代号与昵称，私聊描述保留为备用。

| 场景 | 命令 | 说明 |
| --- | --- | --- |
| 创建 | `开桌` | 创建本群独立牌桌；发令者成为房主。 |
| 入座 | `加入 昵称` | 昵称可省略，省略时使用座位默认名。 |
| 离桌 | `离开` | 等待/结算时立即离开；对局中自动弃牌并在结算后离开。筹码账户会长期保留，重新加入时恢复原余额。 |
| 暂停 | `暂停` / `恢复` | 下一局暂不参赛或恢复参赛，保留座位和筹码。 |
| 查看 | `查看` | 显示阶段、底池、公共牌、座位和筹码。 |
| 开始 | `开始` | 任意已入座玩家；至少两名有筹码玩家。 |
| 过牌 | `过牌` | 仅无需跟注且轮到自己时。 |
| 跟注 | `跟注` | 筹码不足时自动跟注全下。 |
| 加注 | `加注 20` | **20 是本街总下注额**，不是在现有下注上再加 20。 |
| 弃牌 | `弃牌` | 仅轮到自己时。 |
| 全下 | `allin` / `全下` | 下注全部剩余筹码。 |
| 下一局 | `下一局` | 不会自动开局；任意已入座玩家可手动开始。牌桌内有人筹码为 0 时，必须先补充或离桌。 |
| 战绩 | `战绩` | 用卡片查看永久历史排行榜。 |
| 规则 | `规则` | 显示面向新手的完整规则教学卡。 |
| 补充 | `补充` | 显示当前筹码低于 1000 的玩家；符合条件者可点击按钮打开仅本人可见的六档补充通道。 |
| 验牌彩蛋 | `我要验牌` / `窝腰验牌` | 回复固定验牌结果。 |
| 解散 | `解散` | 所有人都可执行；德州对局进行中不能解散。 |
| 帮助 | `帮助` | 显示命令摘要。 |

例如，当前下注为 10、最小加注幅度为 10 时，合法的最小完整加注是 `加注 20`。短码玩家可用 `allin` 做不足最小幅度的加注；这种短码加注不会让已经行动过的玩家再次获得加注权。

## 验证步骤

先验证逻辑：

```bash
npm test
```

项目自带测试覆盖：52 张唯一牌和安全洗牌、7 选 5 牌型、完整跟注/过牌到摊牌、边池分配、最小加注及翻牌前行动顺序。

再用两个飞书账号在同一个群测试：

```text
@机器人 开桌
@机器人 加入 小王
@机器人 加入 小李
@机器人 开始
```

确认每位玩家都收到仅自己可见的两张底牌。随后按照机器人提示依次行动；结算后由任意已入座玩家点击“开始下一局”，验证庄家和盲注轮转。建议再在第二个群执行 `开桌`，确认两个群的玩家、筹码和牌局彼此隔离。

## 目录说明

```text
index.js                    飞书长连接入口（沿用正确事件注册方式）
src/table.js                单桌规则、下注状态机、边池与结算
src/table-manager.js        按 chat_id 管理多桌、房主权限、行动超时
src/evaluator.js            7 选 5 牌型与比较
src/cards.js                牌堆、安全洗牌、展示格式
src/commands.js             中文文字命令解析
src/feishu-transport.js     群消息与私聊发送
src/interaction-adapter.js  交互卡片的命令适配层
src/stats-store.js          永久战绩存储
src/daily-title-scheduler.js 每日 09:00 大群称号调度
src/bailout.js              六档低筹码补充口令与固定额度
test/core.test.js           核心规则测试
```

## 运行边界

牌桌状态会自动保存到 `data/tables.json`。机器人重启后会恢复房间、玩家筹码、当前公共牌、底牌和行动位置；永久战绩保存在 `data/stats.json`。请定期备份这两个文件。


## 开源协议

[MIT](LICENSE)。可以自由使用、修改和分发，请保留版权声明。

---

<div align="center">

觉得好玩的话，欢迎点个 ⭐ Star，有想法也欢迎提 [Issue](https://github.com/YanJhoo/feishu-poker-bot/issues)。

</div>

## English

**A Feishu / Lark group chat bot for Texas Hold'em and "Who's the Spy" (谁是卧底).**

- Play entirely through interactive cards: live table, community cards, pot and stacks, with one-tap check / call / raise / fold and quick pot-size raises.
- Hole cards are truly private: each player sees their own cards on their own client only.
- Full No-Limit Hold'em rules: side pots, best-5-of-7 evaluation, split pots, short all-ins that don't reopen betting. Covered by 41 tests.
- Persistent stats and a daily leaderboard posted to a group every morning (Beijing time).
- Uses Feishu's **long-connection (WebSocket) mode**, so no public server, IP or domain is needed.

**Quick start:** Node.js 18+, then

```bash
git clone https://github.com/YanJhoo/feishu-poker-bot.git
cd feishu-poker-bot
npm install
cp .env.example .env   # fill in FEISHU_APP_ID and FEISHU_APP_SECRET
npm start
```

In the Feishu developer console, enable the bot capability, choose long-connection mode, subscribe to `im.message.receive_v1` and `im.message.recalled_v1`, add the `card.action.trigger` callback, then publish a version. See [INSTALL.md](INSTALL.md) for the full step-by-step guide (in Chinese). The bot's commands and UI are in Chinese.

License: [MIT](LICENSE).
