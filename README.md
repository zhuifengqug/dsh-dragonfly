# 天枢·采风

**采风**：旧时派人出去搜集风物，回来呈报。这个插件干的就是这件事——每天替你去 B站和抖音转一圈，把值得看的挑出来，写成一份日报。

替代现在的 `dsh-bili-scroll` + `dsh-douyin-browser-local` 两个插件。不是把两边合并，是**取零件重造**：以 bili 的骨架（值班章程 + 受限 profile + 日报契约）为准，抖音降级成第二个信源。

---

## 1. 名字与坐标

| 项 | 值 |
|---|---|
| 中文名 | 天枢·采风 |
| 插件名 | `tianshu-caifeng` |
| coordinate | `zhuifengqug/tianshu-caifeng` |
| 包名 | `@zhuifengqug/dsh-tianshu-caifeng` |
| loader id | `zhuifengqug-tianshu-caifeng` |
| 命令 | `/caifeng` |
| 服务 | `ctx.tianshuCaifeng` |
| 工具前缀 | `caifeng_` |
| 目录 | `天枢/天枢-采风`（与 `天枢-蜂群` 同级） |
| 家目录 | 默认 `$DSH_HOME/tianshu-caifeng/`，**可在设置页改** |
| 设置页标题 | 采风 |
| 主区页标题 | 采风 |

**为什么是"采风"**：与 `群策` 同属古典双字，系列感一致；"风"既指风物也暗合信息流；UI 文案读起来都顺——今天采了什么 / 采风范围 / 采风时间 / 采风额度 / 采风日报。备选过的 `甄录`（强调筛选）语义更硬，但文案会僵；`择片` 太直白，撑不起系列。

---

## 2. 定位

它**是**：一个每天自己跑一次的值班程序。只读、只挑、只写 Markdown。

它**不是**：内容聚合器（不建库、不做索引）、自动互动机器人（评论和私信是可选边角）、独立软件。

**唯一产出**：`<家目录>/out/<日期>.md`。所有设计都服从这一条。

**两个入口，同一份数据**：

- 主区整页（`main` 槽）——完整日报 + 最近 7 天历史
- 设置页「今天」页签——同一组件，精简挂载

---

## 3. 为什么不并库

字面合并会得到 830KB 代码 + 两套编排哲学 + 两套人格存储。用户明确不需要的模块本身约 700KB：chat-* 270KB、comment-browser 56KB、video-forward 42KB、spark-* 34KB、qq-sync 34KB、persona-memory 35KB、autonomous-share/comments 44KB、api-agent 33KB、独立软件 app.mjs 47KB。

bili 真正值钱的三件事，抖音一件都没有：

1. `prompts/duty.md`——值班章程，把"怎么挑"写成可执行文字
2. 受限 duty profile——值班会话没有 bash/fs/web/subagent，越权面接近零
3. 判重表 + 日报格式——跨天稳定的契约

抖音值钱的只有浏览器那层（约 40KB），其余全部丢弃。

---

## 4. 包结构

```
天枢-采风/
├─ package.json
├─ index.js                    host 入口：配置、路由、工具注册、调度、抖音宿主这一头
├─ client.js                   设置页 + 主区页（一套视觉，两边样式都不复用）
├─ cordis.patch.yml            bundle patch
├─ icon.svg
├─ dsh-plugin.naming.json
├─ locale/zh-CN.json
├─ prompts/
│  └─ duty.md                  值班章程（B站/抖音合写，人格内联）
├─ profile-template/
│  └─ caifeng-duty/
│     ├─ cordis.patch.yml      受限 profile（照 bili 的边界改 id）
│     ├─ cordis.yml
│     └─ package.json          ⚠️ bundles 必须写在 dsh.profile.bundles 里
├─ lib/
│  ├─ paths.mjs                家目录解析（可配置根 + $DSH_HOME 回退）
│  ├─ state.mjs                磁盘读写、日志、运行锁、当日计数、章程铺设
│  ├─ clock.mjs                时窗判定（北京时区、跨零点、谷时）
│  ├─ config.mjs               默认值与钳制（永不抛）、volatile 脱壳
│  ├─ seen.mjs                 判重表读写（扫描定位 id，不认列位）
│  ├─ report.mjs               日报拼装与合并（按 id 整条替换）+ 界面要的字段拆解
│  ├─ covers.mjs               封面缓存（B站 x/web-interface/view → covers/<BV>.jpg）
│  ├─ workspace-link.mjs       会话归工作区（盯新会话 + 开机对账 attach/detach）
│  ├─ charter.mjs              章程取件 + 把设置页的值讲给模型听
│  ├─ duty.mjs                 profile 铺设、overlay 生成、dsh/node 解析、spawn
│  ├─ service.mjs              宿主这一头：状态、跑一轮、调度、写口
│  ├─ dy-host.mjs              抖音宿主侧：令牌握手、分钟数闸门、动作分派
│  ├─ mcp.mjs                  极简 MCP stdio 客户端（宿主侧调试与验证用）
│  ├─ models.mjs               采风模型的候选列表与解析
│  ├─ login.mjs                B站扫码登录
│  ├─ verify.mjs               评论复核
│  ├─ diagnose.mjs             把日志尾巴翻成一句人话
│  ├─ migrate.mjs              从旧 bili-duty 导入 / 换存放位置
│  ├─ uvfetch.mjs              Python 运行时（uv venv 管理）
│  └─ hostdeps.mjs             从宿主树解析 schemastery / dsh-tools
├─ dy/
│  ├─ core.mjs                 抖音浏览器层（修剪版，见 §12）
│  ├─ browser-host.mjs         专用 Edge 启动/连接、playwright 解析、端口挑选
│  ├─ tools.mjs                4 个抖音动作的定义与失败码
│  └─ mcp-bridge.mjs           极简 MCP 服务：把 duty 轮的工具调用转回宿主
├─ vendor/caifeng-bili-mcp/
│  ├─ server.py                B站 MCP 服务（9 个工具，白名单在注册期过滤）
│  ├─ requirements.txt
│  └─ LICENSE
└─ tests/
   ├─ core/                    纯函数
   ├─ host/                    宿主面（假 ctx）+ 抖音宿主侧
   ├─ client/                  客户端自注册
   ├─ dy/                      抖音浏览器层（假 controller + DOM 桩）
   └─ mcp/                     两条 MCP 的清单与白名单
```

`package.json` 要点（照 `天枢-蜂群` 的规范）：

```jsonc
{
  "name": "@zhuifengqug/dsh-tianshu-caifeng",
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg",
    "./package.json": "./package.json"
  },
  "engines": { "node": ">=22.19.0" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-client-ui-settings-general",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-sidebar"
      ]
    }
  }
}
```

---

## 5. 家目录与数据

根目录**可配置**（设置页「设置 → 运行环境 → 存放位置」）。

```
<家目录>/
├─ config.json              唯一配置（§9）
├─ out/2026-11-01.md        日报，按日期
├─ reports/BV1xx.md         单片笔记（notesEnabled 时写）
├─ covers/BV1xx.jpg         封面缓存（界面上那张缩略图，取一次存下来）
├─ seen.md                  判重表（§8）
├─ seen/2026-10.md          判重表滚动归档（超过 30 天的行挪这里）
├─ state.json               当天计数（收了几条、跑了几次、抖音看了几秒）
├─ duty.md                  章程副本
├─ charter.sha256           章程指纹
├─ duty.log                 值班日志（超过 512KB 滚成 .1）
├─ run-lock.json            运行锁（10 分钟过期，fail-open）
├─ comments.md              评论台账（发了什么、rpid 是多少）
├─ verify-state.json        评论复核的记账（7 天内核过的跳过）
├─ qrcode_login.png         B站登录二维码（设置页摆出来用）
├─ mcp_server.py            B站 MCP 服务（从 vendor 铺过来，那一轮起的是这一份）
├─ headless-overlay.yml     每一轮重写的 overlay
├─ .venv/                   Python 环境（uv 建，装 mcp / bilibili-api / Pillow / qrcode）
├─ creds/bili-credential.json
├─ archive/                  旧插件搬过来的历史（legacy-out/ 旧日报、digest/ 月度归档，只留档不解析）
├─ dy/profile/              专用 Edge 的 user-data-dir（持久登录）
└─ dy/control/
   ├─ host.json             宿主地址 + 令牌（桥靠它找回来）
   └─ port.json             专用 Edge 的调试端口
```

改根目录时的规则：

- 立即生效，下一次运行就用新目录
- 只**复制** `config.json` / `seen.md` / `creds/` 到新目录，`out/` 和 `reports/` 不搬（历史留在原处，设置页提示"旧目录还有 N 份日报"）
- 新目录里没有 `dy/profile/` 时提示"换目录需要重新扫码登录"
- 目标是已存在的非空目录时先确认，不覆盖

**首次启动**：从旧 `$DSH_HOME/bili-duty/` 做一次性幂等导入——`config.json` 字段按名迁移、`seen.md` 并入 `## B站` 节、`out/*.md` 不搬。导入完成写 `migrated-from: bili-duty`，此后不再读旧目录。**不覆写旧目录**，旧插件可以继续跑着对照。

### 值班轮的会话归到哪个工作区

值班轮是 `spawn(dsh … --profile caifeng-duty <prompt>)` 起的**独立进程**，只有 `cwd`、没有 `workspaceId`。而宿主的「会话属于哪个工作区」是 `workspace.json` 里的 `sessionIds` 数组，唯一的官方写法是 `WorkspaceEntity.attachSession()`；它只会被 `SessionService.create()`（从某个工作区发起）调到。⇒ 直接 spawn 出来的会话会落在「未分组」里。

所以由宿主这一侧补记账，分两条路（`lib/workspace-link.mjs`）：

**跑的那一轮——盯着新会话**

1. 那一轮 spawn 之前先记下 `sessions/<projectKey(cwd)>/` 下已有的会话 id
2. 每 400ms 看一次这个目录，出现新 id 就 `ctx.get('workspaceRegistry').resolveByPath(cwd)` → `attachSession(id)`
3. `cwd` 取 `workspaceDir`（空则数据目录）；目录建不出、或该路径还没登记成工作区，就安静地不挂
4. `attachSession()` 自己会把关：会话头里的 `cwd` 与工作区 path 不严格相等就抛错，所以**不可能挂错**

**开机那一趟——一次对账（`reconcileWorkspace`）**

只靠上面那条不够：它只在「那一轮正在跑」的窗口里看着，插件重装、应用升级、那一轮异常退出都会留下「目录里有会话、记账里没有」的空档。所以 `apply()` 里还有一个 `ctx.effect`，插件起来时对一次账：

- `live = listSessionIds(sessions/<projectKey(cwd)>/, cwd)`
- `missing = live − ws.sessionIds` 逐个 `attachSession()`；`dead = ws.sessionIds − live` 逐个 `detachSession()`
- 已经对上的一个字节都不写（宿主 `mutate()` 有 `unchangedSentinel`，无变化时不落盘、不发事件）
- `workspaceRegistry` 还没起来（`no-registry`）就退避重试：1s 起、每次翻倍、上限 30s、最多 8 次；其他原因只记一行日志

三条不做的事（都试过，都会坏）：

- **不自己写 `workspace.json`**：`dsh-storage-json` 以内存态为准，应用在跑时外部改动会被下一次工作区操作覆盖
- **不手拼 session 文件**：zstd 多帧格式的块头是 3 字节，读错一位就把整份日志写成只有头部（真机翻过车）
- **不用 `--session-id` 接管**：headless 的 `assertAdoptable()` 会拦住带 `agent-preset/selected` 的会话

> 界面上要看到效果，得让宿主重新加载插件（重启应用）。开机对账会把「目录里已经躺着、但没记账」的会话（比如插件装好之前跑的那几轮）一并补进来；但**躺在别的 cwd 目录下的会话补不了** —— 它们的 `header.cwd` 是创建时那个路径，改不回来（硬改会撞 `assertStoredIdentity` 的路径校验，真机翻过车）。

---

## 6. 工具契约

16 个工具，前缀统一 `caifeng_`。

B站那 7 个和本地 2 个写口在 **Python MCP 服务**里（`vendor/caifeng-bili-mcp/server.py`），抖音那 4 个在 **Node 薄桥**里（`dy/mcp-bridge.mjs`），三个 `status`/`run`/`config` 在宿主进程里。duty 那一轮只看得见前两条 MCP 挂进来的 13 个。

### B站（Python MCP）

| 工具 | 参数 | 返回 |
|---|---|---|
| `caifeng_bili_search` | `keyword`、`num=10`、`order="totalrank"`、`page=1` | `{ keyword, count, videos:[{ bvid, aid, title, author, play, review, danmaku, duration, pubdate, description }] }` |
| `caifeng_bili_subtitle` | `bvid` | `{ bvid, title, language, segments, text }`；无字幕 `{ ok:false, reason:'no-subtitle' }` |
| `caifeng_bili_comments` | `bvid`、`num=30` | `{ count, comments:[{ rpid, user, content, like, reply_count, time }] }` |
| `caifeng_bili_frames` | `bvid`、`num=3`（1-6）、`at=[秒]` | 图片附件 + `{ ok, duration, covered_sec, tile:'480x270', frames:[{ index, want_sec, got_sec, kb }], failed, note }` |
| `caifeng_bili_favorites` | `folder=""`、`days=7` | `{ folders:[{ id, title, count }], items:[{ bvid, title, author, favedAt }] }` |
| `caifeng_bili_reply` | `bvid`、`text`、`rpid=0`、`root=0` | `{ ok, sent, rpid }`；`autoComment=false` 时拒绝，除非 `force:true`（本人当场授权）；被语感闸门拦下回 `{ ok:false, sent:false, blocked_by:'style', error }` |
| `caifeng_bili_dm` | `action: 'list'\|'read'\|'reply'`、`uid=0`、`text=""` | `reply` 受 `dmMode` 闸门；超 500 字符接口回 **code 21007** |

### 抖音（Node 桥 → 宿主）

| 工具 | 参数 | 返回 |
|---|---|---|
| `caifeng_dy_open` | `query?` | `{ ok, query, url, state }`；无 `query` 打开推荐流，有 `query` 走搜索 |
| `caifeng_dy_state` | — | `{ ok, state:{ pageKind, video:{id,author,title,time,duration,paused,viewport}, searchResults, loginRequired, verificationRequired } }` |
| `caifeng_dy_next` | — | 换下一条后的状态；换不动回 `{ ok:false, reason:<reasonCode>, hint, state, before }`，不假装成功 |
| `caifeng_dy_frames` | `seconds=3`（1-10） | 图片附件 + `{ ok, videoId, duration }` |

`pageKind` 只有 `video` / `search` / `live-preview` / `unknown` 四种。`unknown` 就是「我看不出来」，那一轮该跳过，**不许猜**。

### 本地与运维（Python MCP 那两个写口）

| 工具 | 参数 | 返回 |
|---|---|---|
| `caifeng_report_write` | `date?`、`entries`（JSON **字符串**）、`skipped`（JSON **字符串**）、`note?` | `{ ok, path, added:[id], replaced:[id], notes:[单片笔记路径] }`；同一天多次调用按 `id` 整条替换；`detail` 存在且 `notesEnabled` 时另写 `reports/<id>.md`；`note` 给了就**整段替换**上一轮写的「总结」 |
| `caifeng_seen` | `check`（JSON 字符串数组）、`mark`（JSON 字符串数组） | `{ seen:[id], unknown:[id], marked, total }`；一次调用同时能查能记 |

`entries` / `skipped` / `check` / `mark` 都是 **JSON 字符串**而不是数组 —— MCP 的参数是字符串，模型得自己 `JSON.stringify`。

### 宿主里那三个（只给用户会话）

| 工具 | 参数 | 返回 |
|---|---|---|
| `caifeng_status` | — | 今日条数/额度/下次窗口/存放位置/两信源可用性/运行环境 |
| `caifeng_run` | — | 立刻跑一轮（不等窗口）；额度与冷却照走 |
| `caifeng_config` | `patch` | 改配置并回读（只认 §9 字段） |

**登录、装 Python、诊断这类一次性运维不进工具**，全在设置页里做——它们需要人看二维码、需要进度条，做成工具只会污染 duty 会话的工具箱。

**duty 会话白名单**：B站 7 + 抖音 4 + `report_write` + `seen` = 13 个。`status`/`run`/`config` 只给用户自己的会话。

**白名单是在「注册期」生效的，不是「调用期」**：`server.py` 的 `@tool()` 装饰器读 `CAIFENG_BILI_TOOLS`，名单外的函数连 `tools/list` 里都不出现；`mcp-bridge.mjs` 同理读 `CAIFENG_TOOLS`。所以那一轮不是「有个工具但调不动」，而是**根本没见过这个工具**。

---

## 7. 日报契约

沿用 bili 现在的格式，只加信源标签。路径 `<家目录>/out/<YYYY-MM-DD>.md`。

```markdown
# 2026-11-01

### [B站] BV1xxxxxxxxx / 标题
**档位**：值得看
**为什么值得**：三段式叙事，必须含具体数字（时长、播放、评论数、讲到的具体点）
**我的一句话**：一句短评

### [抖音] 7400000000000000000 / 标题
**档位**：可以看
**为什么值得**：……
**我的一句话**：……

## 扫过没收的
- [B站] BV1yyyy — 一句话为什么没收
- [抖音] 74zzz — ……

## 因缺证据跳过
- [抖音] 2 条：无画面/未加载完成
- [B站] 1 条：无字幕

## 私信
- 收到 3 条，其中 2 条值得回（`dmMode=draft` 时把想回的话写在这里当草稿，`read` 时只写收到了什么）

## 判重
今天新记 7 条，累计 128 条

## 总结
三两句话，说今天这一圈的整体判断。
```

约束：

- 每条必须有 `[B站]` 或 `[抖音]` 前缀，跨信源按"值得看"优先排序
- `档位` 只有三个值：`值得看` / `可以看` / `不值当`；判成 `值得看` 必须有字幕或画面证据
- `为什么值得` 不许空话；写不出具体理由就降到 `扫过没收的`
- 同一天重复跑，按 `id` **整条替换**而不是追加；「总结」以最后一轮为准，不拼接
- 一天只有一份，永远不新建第二个文件
- 一条既然收进了「今天挑的」，就不许同时挂在「扫过没收的」下面
- 「因无字幕跳过 N 条」N=0 也要写出来 —— 空是一种结果，不是失败
- 「私信」节只在 `dmEnabled` 且有新消息时出现

**私信这一节只写「收到了什么」**，不写「发了什么」：采风的产出只落日报，从不往任何人的私信里发东西（`dmMode=auto` 也只是在日报里记下回了什么，投递目标永远是本人）。

### 宿主自己追加的小节

那一条轮次结束后，宿主会做两件它自己负责的事，写成独立小节附在日报末尾：

```markdown
## 评论复核（宿主自动跑的，不是那一轮自己说的）
- `BV173xP6kE5E` rpid **322726703680** —— 公开可见（赞 0） · 依据：顶层·最新一页
```

- 只在 `autoComment` 为真、且这一轮确实试过发评论时才出现
- 措辞只准「公开可见」或「**没查到**」——「没查到」不等于「没发出去」，写清楚别让人误会
- 取不到 `rpid` 就写「未取到 rpid，这条没法核（不猜）」，绝不编一个数字
- 同一轮触发两次也只出现一遍（写之前先把它切掉再写）

---

## 8. 判重表

`seen.md`，分信源两节，同一天同一条只记一行：

```markdown
# 见闻录

## B站

| 日期 | id | 标题 | UP | 状态 |
| ---- | -- | ---- | -- | ---- |
| 2026-11-01 | BV1xx411c7mD | 标题 | UP 名 | 收 |
| 2026-11-01 | BV1yy411c7mE | 标题 | UP 名 | 弃 |

## 抖音

| 日期 | id | 标题 | UP | 状态 |
| ---- | -- | ---- | -- | ---- |
| 2026-11-01 | 7400000000000000000 | 标题 | 作者 | 弃 |
```

- 状态只有 `收` / `弃`。同一天同一条再记一次是**替换**（弃可以升成收，不会出现两行）
- `caifeng_seen` 一次调用同时能查能记：`check` 问「这几条见过没」、`mark` 往回记
- **解析靠扫描定位 id，不认列位**——人手改过的表格（id 挪到第一格、多加一列）照样能读，读不出来就跳过不瞎猜
- 超过 30 天的行自动滚进 `seen/<YYYY-MM>.md`，主表只留近期
- 跨信源 id 不会撞（BV 前缀 vs 纯数字），但仍分节，方便人肉查

---

## 9. 配置项（唯一一份）

```jsonc
{
  // —— 信源 ——
  "sources": { "bili": true, "douyin": true },

  // —— 额度与节奏 ——
  "perDay": 5,                 // 每天最多"收"几条
  "dyDailyMinutes": 10,        // 抖音每天最多看几分钟
  "fetchPerRound": 8,          // 每轮最多细看几条候选
  "windows": ["00:00-24:00"],
  "peakValley": true, "noon": true, "night": true,
  "manualMax": 3,
  "manualCooldownMin": 10,

  // —— 怎么挑 ——
  "keywords": ["deepseek", "ai", "插件", "游戏开发"],
  "excludeWords": [],
  "searchSort": "pubdate",
  "searchPages": 2,
  "personaPrompt": "",         // 人格，注入章程；空则用内置默认

  // —— 产出 ——
  "outputDir": "",             // 空 = 默认 $DSH_HOME/tianshu-caifeng
  "reportLevel": "full",       // full | brief
  "notesEnabled": true,        // 单片笔记
  "favoritesEnabled": true,    // 收藏夹也入日报
  "favoritesDays": 7,

  // —— 采风用哪个模型 ——
  "model": { "provider": "", "model": "" },   // 空 = 跟随 DSH 当前默认

  // —— B站互动 ——
  "autoComment": true,
  "commentPerRound": 1,
  "commentLength": "medium",   // short<=15 / medium<=40 / long<=100
  "mentionName": "蚍蜉zzzz",
  "replyToComments": true,     // 回复别人在你评论下的回复

  // —— 私信：管"收到的怎么处理"，不管"往哪儿投" ——
  "dmEnabled": true,
  "dmMode": "read",            // read | draft | auto（默认 read，见 §16）
  "dmUid": 0,

  // —— 运行环境（设置页自己写的，一般不用手改） ——
  "pythonPath": "",            // 空 = 还没装；点过"装 Python 环境"就自动填上
  "workspaceDir": "",          // 值班轮在哪个目录里跑；空 = 数据目录（那边不会显示成工作区）

  // —— 显示：只决定入口挂不挂，不影响跑不跑 ——
  "showSidebar": true,         // 侧栏留个入口
  "showConversation": true     // 会话顶部挂「今天」
}
```

抖音侧没有独立配置块——只借 `sources.douyin`、`dyDailyMinutes`、`keywords`。旧 douyin 插件的 7 类设置（人格、视频时间、自检、好友互动、公开评论、音频密钥、日报）合并成上面这几行，其余全部砍掉。

**`dmMode` 管的是「收到的私信怎么处理」**，不是「把日报投到谁的私信里」：

| 值 | 行为 |
|---|---|
| `read`（默认） | 只读，收到什么写进日报的「私信」节，一个字都不回 |
| `draft` | 读，并把想回的话写进日报当草稿，但**绝不调用 reply** |
| `auto` | 允许回。设置页会先单独确认一次；一条最多 4~5 句（超 500 字符接口回 code 21007）；转账、点链接、加好友一律不执行 |

`dmEnabled=false` 连读都不读。**采风从不往任何人私信里发日报**——唯一产出是 `<家目录>/out/<日期>.md`。

**模型的候选列表从哪来**：优先读 DSH 已配置的 provider/model 注册面（`ctx.llm.listProviders()` / `listModels()`）；读不到就退化成手填 `provider` + `model` 两个文本框。不做硬编码列表。

---

## 10. 设置页

两个页签。

### 顶部（两页签共用）

一条状态带，不是卡片：

```
今日已收 3 条（B站 2 / 抖音 1）· 额度 5 · 下次 14:00 · [现在就跑]
```

### 页签一：今天

**先选信源，再选日期，然后看正文。** 顺序是刻意的：多数时候你要的是「全部」，所以它排第一；信源定了之后，日期才有意义。

```
[全部 7] [B站 5] [抖音 2]          [11-03] [11-02]
────────────────────────────────────────────────
[封面 112×63]  我让 AI 组了个队：一个管家两个打工的   值得看
                12 分 40 秒，播放 3.2 万，评论 47 条…
                │ 这句「分工不等于独立审核」比功能清单值钱
                B站 · BV1YL4K66EHG
```

- 信源 chip 上带条数（只数「值得看」），点一下就把下面过滤掉
- 日期 chip 取最近 7 天；只选信源不选日期时看今天
- 每条：**封面缩略图**（点开去 B站，`<img>` 走 `/api/caifeng/cover?bvid=`，拿不到就把位置让出来）+ 标题（点开去原视频）+ 档位 chip + 「为什么值得」正文 + 左竖线引文
- 抖音的条目没有封面（那个站没有公开接口），单列铺满
- 「扫过没收的」「因缺证据跳过」这些按节列在下面，也按信源过滤
- 空态：今天还没跑 → "还没采过，[现在就跑]"
- 与主区页是**同一个组件**（`TodayPanel`），这里挂精简版（`compact`，不铺 900 宽）

### 页签二：设置

五段平铺，后两段默认折起：

| 段 | 项 |
|---|---|
| **信源与额度** | 两个信源开关、每天几条、抖音分钟、每轮细看几条、时段 |
| **怎么挑** | 关键词、排除词、排序、翻页、人格 |
| **互动与产出**（折起） | 自动评论（开关/每轮/长度/@谁）、回复评论、私信、收藏夹、单片笔记、日报详略 |
| **运行环境**（折起） | **模型下拉**、**存放位置**、**值班轮的工作区**、B站登录、抖音浏览器、诊断、Python 环境 |
| **显示** | 侧栏留个入口、会话顶部挂「今天」 |

「显示」那两个开关是**真挂/真摘槽位**，不是渲染空壳：关掉侧栏就把 `sidebar.panellist` 那条注销掉，关掉会话顶部就把 `conversation.view` 注销掉。空壳会留一个点不开的按钮，比没有更糟。主区页（`main`）与设置页（`settings.section`）**不随这两个开关消失** —— 它们是「怎么进来」的两条腿。

视觉规则：

- 单列，`max-width: 640px`；主区页的「今天」放宽到 900px，设置页回到 640
- 只有两种字号：13px 正文 / 11px 小节标题
- 不要卡片墙，用分组 + 分隔线
- 一套自绘 CSS，不复用 bili 的 `[data-bd-*]`，也不复用 douyin 的 primitives 内联样式

### 主区页（`main` 槽）

```
采风                                    [现在就跑]
今日已收 3 条 · 额度 5 · 下次 14:00
今天 | 设置
────────────────────────────────────  ← 这条以上固定，以下滚
[全部 3] [B站 3] [抖音 0]
[所有档位] [值得看 2] [可以看 1] [不值当 0]
[11-03] [11-02]
[封面] 我让 AI 组了个队…              值得看
       …
```

三排筛子顺序固定是**信源 → 档位 → 日期**：先定"看谁家的"，再定"看什么档"，最后才选哪天。档位那一排只列**这一天真出现过的档位**（没出现过的摆上去只会让人白点一下），选中态各有各的颜色（值得看绿 / 可以看琥珀 / 不值当红），一眼能看出跟信源那排是两种筛子。

外壳是 `height:100%` 的 flex 列，表头（状态带 + 页签）`flex:none`，正文区 `flex:1;min-height:0;overflow-y:auto` —— **页面自己滚，不是整块被顶出去**（照群策 `client.js` 那套写法）。

`main` 是 **keyed** 槽：`register({ name:'main', key:'caifeng' }, …)`。它自己不会出现在侧栏——**必须同时注册 `sidebar.panellist`（`{ id:'caifeng', order:100, label:'采风' }`）**，侧栏那个图标才是进主区页的唯一入口。两者 id/key 都是 `caifeng`，配对关系，缺一个就进不去。侧栏图标是**内联 SVG 罗盘**（16px、`currentColor`、1.5 描边），不是 emoji —— emoji 在那一列单色图标里显得脏。

会话顶部还有一块 `conversation.view`（`{ id:'caifeng-today', order:20, scope:'session', label:'采风' }`），内容就是「今天」的精简版；它替换掉了原来 bili 插件挂的「刷过的视频」。

这一块**要铺满**，跟上游那个「轨迹」视图一样占满整片 area 并自己滚 —— 但宿主给的那层 `viewArea` 在 `data-phase=active` 时是 `flex:1 0 auto; min-height:auto`（高跟着内容长），子元素写 `height:100%` 等于循环依赖，撑不起来（实测被算成 3611px、内层 `scrollable:false`）。所以反过来改**父级**：

```css
/* 用结构选择器，不认宿主那几个哈希类名（升级换了哈希也还命中） */
[data-slot="conversation.session"] > div:has(> [data-slot="conversation.view"] > [data-cf-conv]){
  flex:1 1 0;min-height:0;overflow:hidden;}
[data-cf-conv]{flex:1 1 0;min-height:0;height:auto;max-height:none;display:flex;flex-direction:column;}
```

改后实测 `596×1100`、内层 `clientHeight 595 / scrollHeight 5108`、`scrollable:true`。会话区矮，chip 得钉住（`[data-cf-conv] [data-cf-sticky]{position:sticky;top:0}`），不然翻两条就滚没了。会话区宽，页面的 `max-width` 也要放开（`[data-cf-conv] [data-cf-page]{max-width:none}`），不然右边空一大片。

设置页走 `settings.section`（`{ id:'caifeng', order:60, label:'采风' }`）。四处注册各自 try/catch，缺一个其他照起。

数据面：客户端只读 `/api/caifeng/*` 这几张口子 —— `status` `config`(GET/POST) `run` `report` `days` `cover` `models` `python`(GET/POST) `login/start` `login/poll` `whoami` `diagnose` `review` `import` `move-home` `dy-reset`。抖音桥走 `/api/caifeng/dy/<action>`，那条不走同源判断，走 `x-caifeng-token`。

`cover` 只服务 B站：先看 `<家目录>/covers/<BV号>.jpg`，没有就去 `x/web-interface/view` 取 `data.pic` 再下图存起来（4MB 上限、8 秒超时）。拿不到就 404，界面把图藏掉，不留破图。

---

## 11. 安全边界

照搬 bili 的做法，只改 id：`profile-template/caifeng-duty/cordis.patch.yml` 建一个专用 profile。

```jsonc
// profile-template/caifeng-duty/package.json
// ⚠️ bundles 必须写在 dsh.profile 下面。写成顶层 "bundles" 会被静默忽略，
//    这个 profile 一个 entry 都组不起来 —— 表现出来是「所有 MCP 都 pending
//    (waiting for service: tools)」，而报错信息里只说某个 entry not found。
{
  "name": "dsh-profile-caifeng-duty",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } }
}
```

禁用：`tool-bash` `tool-pwsh` `tool-jobs` `jobs` `tool-ralph` `tool-fs` `tool-fs-search` `tool-web` `web-fetch-http` `web-search-deepseek` `tool-subagent*` `subagent*` `workflow-ptc` `ptc-runtime` `tool-workflow` `skill` `skill-filesystem` `skill-badge` `tool-skill` `agent-instructions` `tool-plugin-manager` `plugin-manager` `hmr` `goal*` `plan-mode` `tool-todo` `mcp-resources`

补开：`credentials` `authorization` `deepseek-account` `agent-default-model`（config 由 §9 的 `model` 决定）。

**模型路由有一条硬限制**：受限 profile 里能免密钥跑通的只有 `deepseek-account`；`deepseek-official` 要 `DEEPSEEK_API_KEY`，其他 provider 要 providers 配置，这里都没有。所以设置页没填模型时，overlay 不会照抄桌面默认，而是**回退到 `deepseek-account` + `deepseek-flash`** 并在日志里说清原因。要固定别的模型，在设置页填。

### duty 那一轮的工具面从哪来

宿主 `ctx.tools.register` 注册的工具**对子进程不可见**。那一轮的 13 个工具全部来自 overlay 里插的两条 MCP：

| overlay 条目 | 是什么 | 谁起 | 什么时候不起 |
|---|---|---|---|
| `mcp-caifeng-bili` | `@deepseek-ai/dsh-mcp-client` + Python stdio 服务 | `<家>/.venv/Scripts/python.exe <家>/mcp_server.py` | 没装 Python 环境、或 `mcp_server.py` 没铺到家里 |
| `mcp-caifeng-dy` | `@deepseek-ai/dsh-mcp-client` + Node 薄桥 | `node dy/mcp-bridge.mjs` | 抖音桥文件不在包里 |

两条各自独立：一条挂了另一条照跑，那一轮降级成单信源并在日报里写明。两条都没插上时 `run()` 直接回 `no_source`（带上是哪条为什么没起来），不白跑一轮。

overlay 每次运行重写，还负责三件它必须做的事：补开 `credentials`/`authorization`/`deepseek-account`（headless bundle 自带 patch 把它们关了）、按当前模型写 `agent-default-model`、所有路径按 YAML 单引号转义并在 Windows 上把 `\` 换成 `/`。

值班会话的工具面 = §6 的 13 个 `caifeng_*`。它能读网、能写日报，不能碰文件系统、不能起子代理、不能装东西。

---

## 12. 抖音那层怎么移植

`core.mjs` 有 1214 行，其中 8 个 service getter 全是 `import('./chat-*.mjs')` 动态导入——**不删也不会在 import 时报错**，只在使用时才会。所以移植策略是复制后做减法，不做重写。

**保留**（约 400 行，逻辑对着抖音 DOM 磨过，重写等于重踩坑）：

`readPageState` `endpoint` `lock` `wait` `aborted` `RECOMMEND`，以及 `BrowserController` 的
`connect` `navigate` `settle` `state` `withPage` `currentVideo` `switchVideo` `capture` `close`

**删除**：

- 共享帧证明整套（`SHARED_CAPTURE_MODE` `SHARED_PROOFS` `verifySharedVideoFrameProof` `observeChatSharedWork` `sharedProgress`）
- 8 个 service getter：`getMediaAdapter` `getForwarder` `getChatService` `getSparkService` `getCommenter` `getComments` `getReport` `getWatchMode` `applyWatchMode`
- `store()` `getPersonaMemory()` `observeSharedWork` `execute`（换成 `dy/tools.mjs` 的薄分派）
- `captureAudio` `listen`（不做音频）
- `createBackgroundPage` `acquireBrowserOperationLock` `dedicatedHostReadiness`——引用者都在 core.mjs 内部，删完无断口

**改造点**：

- `state()` 里 `this.store().recordVideo(...)` 删掉；`this.limits().notePlayback(...)` 换成 §9 的统一额度计数
- `withPage()` 里 `getWatchMode().apply(page)` 删掉——不需要"静默模式"，值班本来就是后台跑
- `connect()` 里的 `source` 取值收敛成一个 `'duty'`，不做 `api`/`dsh`/`verification` 多来源区分

**抖音必须有真浏览器**：抖音不接受 headless，且登录态要持久。方案是专用 Edge 实例（独立 `user-data-dir` 在 `dy/profile/`），首次由用户在设置页点一次"打开并登录"，扫码后 profile 留着；之后值班时按需连接，跑完**不关浏览器**（关了就丢登录态，反复扫码会毁掉体验）。

### 这张图是分两半的

抖音的浏览器活在**宿主进程**里，不在 duty 那一轮里：

```
宿主进程                               duty 子进程（受限 profile）
─────────────────────────              ────────────────────────────
BrowserController                      mcp-caifeng-dy（Node 薄桥）
  专用 Edge（dy/profile）                  │  只有 4 个 caifeng_dy_* 工具
  readPageState / switchVideo / capture    │  白名单由 CAIFENG_TOOLS 决定
        ▲                                  │
        │  POST /api/caifeng/dy/<action>   │
        └──────────────────────────────────┘
           带 x-caifeng-token（令牌在
           <家>/dy/control/host.json）
```

这样分的原因很实在：受限 profile 里没有 `bash`、没有 `fs`，起不了浏览器；而且一个进程里只能有一台专用 Edge（`user-data-dir` 会被锁）。

**跨进程那条线不靠文件锁**，靠令牌 + 宿主自己数的额度：

- 宿主每次起来 `publish()` 一次，把 `{ baseUrl, token }` 原子写进 `<家>/dy/control/host.json`；重新 publish 会换令牌，旧的立刻作废
- 桥只认这个文件；读不到就回 `{ ok:false, reason:'no-host-record' }`，不猜地址
- **每日分钟数由宿主数**：`open` / `next` / `frames` 三个"往回看"的动作进出时计时，累计到 `dyDailyMinutes` 就回 `{ ok:false, reason:'daily-limit' }`；`state` 只读一次状态，不计时也不受额度拦

`dyDailyMinutes` 因此是**真闸门**，不是章程里的一句嘱咐——模型想多刷也刷不动。

### 移植时踩过的六个坑（都已修，别再踩回去）

1. **裸 `https://www.douyin.com/` 会被甩到 `/jingxuan`**，那页没有能上下滑的作品流。得用 `?recommend=1&from_nav=1`，且落在 `/jingxuan` 时点一下导航里文本为「推荐」的 tab。
2. **`page.evaluate` 不收源码字符串**。`String.raw` 写出来的函数传进去会被当表达式求值，返回 `undefined`，参数全丢。要先 `new Function` 编译成真函数再传。
3. **`readyState=complete` 不代表有作品**。推荐流先挂直播卡（`live-preview`）再换成作品，中间有约一秒空窗。`navigate()` 之后要等到 `pageKind` 认得出是 `video` 或 `search` 才交回去；认出是 `live-preview` 就 4 秒内收手交给上层划走（直播卡不会自己变成作品，等满 12 秒也是白等）。
4. **找不到 `playwright-core` 不要报「没装」就完事**。桌面版把它装在 profile 的 `node_modules` 里，插件自己的 `node_modules` 里没有。要按顺序找：环境变量 → 插件自己 → `$DSH_HOME/profiles/*/node_modules` → npm 全局，全都用 `pathToFileURL` 动态 import。
5. **跑完不关浏览器，下一轮就会自己撞自己**。`port.json` 记的端口只是线索：上一轮那台 Edge 还占着 9227，`probePort` 却说「9227 不空」⇒ 挑 9228 ⇒ 同一个资料目录再 launch ⇒ Edge 单例把新进程转给老进程后立刻退出 ⇒ `launch-failed`。所以 `ensureBrowser` 要**先 `findLiveCdp` 接管活着的调试口**，没有才新开；`port.json` 只是"先试这个"的提示。
6. **`im-dialog` 一直挂在 DOM 上**（私信面板没打开也存在）。按"有没有这个节点"判私信面板，会让推荐流永远落不进 `live-preview`，整片读成 `unknown`。要判它**可见**。

---

## 13. 实施

分两步，每步都能单独验收。

### 第一步：骨架 + B站

交付：包骨架、命名清单、`lib/`、`vendor/caifeng-bili-mcp/`、设置页两页签 + 主区页、`prompts/duty.md`、受限 profile 模板、B站 7 个工具 + 本地 2 个 + 运维 3 个。

验收：

1. 插件装上，设置页「采风」出现，两个页签都能开，主区出现「采风」页，无控制台报错
2. 设置页能改模型（下拉有候选或手填可用）、能改存放位置（改完下一次运行生效）
3. 点「现在就跑」走完一轮，`out/<今天>.md` 生成，读起来与旧 bili 日报同档（档位/为什么值得/我的一句话都在）
4. 连跑两次，第二次判重生效，不重复收同一条
5. 收藏夹开时，收藏夹里的新条出现在候选里
6. `notesEnabled` 时 `reports/<id>.md` 生成
7. duty 会话里 `tool-bash`/`tool-fs`/`tool-subagent` 全部不可用
8. 停用旧 `dsh-bili-scroll` 后仍然跑得通

### 第二步：抖音信源

交付：`dy/` 移植、4 个抖音工具、专用 Edge 启动/登录流程、抖音候选并入同一次值班。

验收：

1. 设置页「运行环境」能看到抖音浏览器状态，点一次能打开并完成扫码登录
2. 单独调 `caifeng_dy_state` 能读到当前视频的 id/作者/标题/时长
3. `caifeng_dy_frames` 能拿到画面
4. 同一次值班里两个信源都有条目，日报里 `[B站]`/`[抖音]` 标签正确
5. 判重表两个分节各自独立，跨信源不串
6. 抖音每日分钟数用尽后自动停

---

## 14. 取件清单（实现时照这张表取，别自己造）

参考源码（已 clone，实现时可直接对照）：

- bili v2.3.1 → `D:\dsh-workspaces\dev\local-plugins\2026-11-01-刷片插件合并\tmp\bili-src`
- douyin v1.4.6 → `D:\dsh-workspaces\dev\local-plugins\2026-11-01-刷片插件合并\tmp\douyin-src`

| 落点 | 来源 | 处理 |
|---|---|---|
| `lib/{state,login,verify,diagnose,uvfetch,hostdeps}.mjs` | bili `lib/` 同名 | 直接搬，改导入路径与家目录常量 |
| `lib/mcp.mjs` | bili `lib/mcp.mjs` | 直接搬（宿主侧调试与验证用，duty 轮不用它） |
| `vendor/caifeng-bili-mcp/server.py` | bili `vendor/bilibili-mcp/mcp_server.py` | 剪掉转写、弹幕、排行等，只留 9 个工具；白名单 env 改名；家目录改 `CAIFENG_HOME` |
| `vendor/caifeng-bili-mcp/requirements.txt` | bili 同名 | 去掉 whisper 系依赖；`mcp` 必须锁 `<2` |
| `bili/*.mjs` 七个 | bili `index.js` 里对应工具的实现 | **不搬成 JS**——那 7 个走 Python MCP，宿主侧没有对应文件 |
| `lib/paths.mjs` | 新写 | 借鉴 douyin `runtime-paths.mjs` 的解析顺序，加可配置根 |
| `lib/{seen,report,charter,config,clock,duty,service,dy-host,migrate,models}.mjs` | 新写 | 契约见 §5 §7 §8 §9 §11 |
| `prompts/duty.md` | bili `prompts/duty.md` | **重写**：合并抖音信源、人格内联、工具名换成 `caifeng_*`、私信节改语义 |
| `profile-template/caifeng-duty/*` | bili `profile-template/bili-duty/*` | 改 id 与白名单；**`package.json` 的 bundles 挪进 `dsh.profile`** |
| `dy/core.mjs` | douyin `core.mjs` | 按 §12 删 |
| `dy/browser-host.mjs` | douyin `browser-host.mjs` + `browser-launcher.mjs` + `runtime-paths.mjs` 三合一 | 加 playwright 多根解析、端口文件 |
| `dy/tools.mjs` | douyin `tool-definitions.mjs` | 只留 4 个动作；失败一律结构化，不抛 |
| `dy/mcp-bridge.mjs` | 新写 | 手写极简 MCP stdio 服务（不装 SDK），把工具调用转回宿主 |
| `client.js` | 新写 | 只借 bili 的 CSS 结构思路，不复用样式 |
| `lib/asr.py` `lib/favops.py` | bili `lib/` | **不搬**（无转写）；收藏夹逻辑并进 `server.py` 的 `caifeng_bili_favorites` |

---

## 15. 风险与不做的

**风险**

- **与上游脱钩**：bili 上游已到 2.4.0（本地是 2.3.1），分叉后不再自动跟进。可接受——上游的路线是"用 JS 重写、摆脱 Python"，与本插件目标不同
- **抖音 DOM 变更**：`readPageState` 依赖 `[data-e2e="feed-active-video"]` 等选择器，抖音改版会失效。缓解：`caifeng_dy_state` 返回 `pageKind:'unknown'` 时明确报错，不猜
- **抖音登录态**：profile 一旦损坏就要重扫码。缓解：设置页给出"重置浏览器 profile"按钮，并说明会丢登录
- **Python 依赖仍在**：B站的搜索/字幕/评论/回复走 Python 侧。砍了 ASR 之后不再需要 whisper 模型，装起来轻很多
- **私信的对外发言风险**：`dmMode` 默认 `read`（只看不发）。改成 `auto` 前必须在设置页明确确认一次，并在日报里留发送对账
- **收藏夹里可能有私密内容**：默认纳入，但设置页要说明"收藏夹里的私密收藏也会进日报"

**明确不做**

- 语音转写 ASR（已确认砍掉）
- 抖音公开评论（已确认砍掉）
- 抖音私信、续火花、好友互动
- 视频转发
- QQ 记忆同步
- 独立软件（`app.mjs` 那套桌面端）
- 人格卡独立存储（人格内联进章程）
- 多来源浏览器 controller（`api`/`dsh`/`verification`）
- 音频采集与 `douyin_listen`

---

## 16. 待确认（都已定）

- **`dmMode` 默认值**：定为 `read`（只看不发，最安全）。
- **`icon.svg`**：一枚单色罗盘，已画好（`icon.svg`，96×96，深底 + 双圈 + 红灰双指针）。
- **`locale/en.json`**：不做。只出 `locale/zh-CN.json`。
- **`windows` / `noon` / `night` / `peakValley`**：保留了字段和时窗判定（`lib/clock.mjs`）供自动轮用；默认 `["00:00-24:00"]` 等于全天放行，不强按谷时。

---

## 17. 真机上踩过的坑（照这个顺序排错）

按「症状 → 真因 → 怎么修」写，都是本机实际撞过的，不是设想。

| 症状 | 真因 | 修法 |
|---|---|---|
| 插件整个不激活，`invalid config: $.sources.bili volatile fields require a fixed object path without an enclosing volatile field` | 嵌套对象外层也标了 `.extra('volatile')` | 只标内层字段，`sources` / `model` 外层不标 |
| `command "caifeng" input hint must not be empty`，插件不激活 | 命令传了 `input:{hint:''}` | 命令不吃参数就别传 `input` |
| `cannot set property "tianshuCaifeng" without provide` | cordis 的 `set` 只能改已 provide 的服务 | 用 `ctx.provide(...)` |
| 配置读出来是 `"[object Object]"` | volatile 字段被宿主包成 `{get(){},[write]}` 引用对象 | `lib/config.mjs` 的 `unwrap()` 逐层脱壳，clamp 入口整体先脱 |
| `notesEnabled` / `favoritesEnabled` / `dmEnabled` 明明是 true 却按 false 走 | `key in src` 判空会被 cordis 显式补的 `undefined` 骗过 | 改判 `!== undefined` |
| 那一轮 exit 1，`命令行语法不正确` | 走 `dsh.cmd` 要 `shell:true`，多行中文章程被 cmd.exe 毁掉 | 优先解析 `@deepseek-ai/dsh/lib/bin.js` 用 node 跑；`.cmd` 只作最后兜底 |
| `unsupported Electron runtime fingerprint: Node 24.x ... -electron.0` | 桌面版 `process.execPath` 是 Electron，不是 node | `resolveNode()`：环境变量 → 非 Electron 时用自身 → 扫 PATH 找真 `node.exe` |
| `MISSING_CREDENTIAL: no API key for provider route "deepseek-official"` | 受限 profile 里只有 `deepseek-account` 能免密钥跑 | 没显式指定模型时回退到 `deepseek-account/deepseek-flash` 并记日志 |
| 三个 MCP 全 `pending (waiting for service: tools)`，profile patch 里几十条 `entry "X" not found` | 受限 profile 的 `bundles` 写在了 `package.json` 顶层 | 挪进 `"dsh": { "profile": { "bundles": [...] } }` |
| `search_by_type() got an unexpected keyword argument 'credential'` | `bilibili-api-python` 各版本签名不一致 | 用 `inspect.signature` 探测，认什么传什么 |
| 抖音 `pageKind:'unknown'`，页面里只有导航壳 | 裸域名被甩到 `/jingxuan`，那页没有作品流 | 用 `?recommend=1&from_nav=1`，并点「推荐」tab |
| 换片时 `Cannot read properties of undefined (reading 'blocked')` | `page.evaluate` 传源码字符串被当表达式求值 | `new Function` 编译成真函数再传 |
| 抖音打开后立刻读状态是 `unknown`，那一轮直接跳过 | 客户端渲染，`readyState=complete` 时推荐流还没作品 | `navigate()` 后 `settleState()` 等到 `pageKind` 认得出为止 |
| 抖音整轮 `dy-unknown`，日志里 `launch-failed` + `connect ECONNREFUSED 127.0.0.1:9228` | 跑完不关浏览器，上一轮那台 Edge 还占着 9227，而 `port.json` 记的是 9228；同一个资料目录再 launch 被单例转走后立刻退出 | `ensureBrowser` 先 `findLiveCdp()` 接管活着的调试口，没有才新开；`port.json` 只当"先试这个"的线索 |
| 搜索页里一个 `/video/` 链接都没有 | 默认停在「综合」tab，视频卡是懒加载的 | 先点一下「视频」tab，再轮询等卡片出现（最多 10 秒） |
| 点了搜索结果没反应，页面还停在搜索页 | 抖音的卡片只认真事件，`a.click()` 被拦掉 | 取卡片中心的坐标，用 `page.mouse.click(x, y)` 真点 |
| 抖音一直停在直播卡上，`pageKind` 迟迟不变成 `video` | 推荐流里那张直播卡没有作品 id，等多久都不会变成作品 | `settleState` 认出 `live-preview` 就 4 秒收手；`open()` 自己划走一张并回报 `skipped`，`next()` 换到直播卡再接着划（最多两跳） |
| 推荐流里明明只有一张直播卡，却读成 `unknown` 而不是 `live-preview` | `im-dialog`（私信面板）一直挂在 DOM 上，按"节点存在"判会永远判成私信态 | 判它**可见**：`querySelectorAll(...).some(visible)` |
| `loadPlaywright()` 回 `no-playwright` | 桌面版把 `playwright-core` 装在 profile 的 `node_modules` 里 | 多根解析 + `pathToFileURL` 动态 import |
| 日报里「总结」出现两段互相矛盾的话 | 同一天第二轮把总结追加在上一轮后面 | 给了 `note` 就整段替换，不拼接 |
| 同一条既在「挑的」又在「扫过没收的」 | 模型把已收的 id 又塞进 skipped | 渲染前把 `picks` 里的 id 从 skips 里剔掉 |
| 主区页滚不动，内容被整块顶出去 | 外壳没有高度约束，`overflow` 落在错的那层 | 外壳 `height:100%;display:flex;flex-direction:column;overflow:hidden`，正文 `flex:1;min-height:0;overflow-y:auto` |
| 侧栏那个 emoji 图标跟旁边一圈单色线性图标格格不入 | `🧭` 是彩色 emoji，不吃 `currentColor` | 内联 SVG：16px、`stroke="currentColor"`、1.5 描边 |
| 界面上直接露出 `**档位**：` `**为什么值得**：` 这类原始标记 | 前端把正文整段 `pre-wrap` 出来 | `lib/report.mjs` 的 `entryDetail()` 把 `why` / `quote` / `url` 拆成字段，前端只渲染字段 |
| 关掉「侧栏入口」后还留着一个点不开的按钮 | 做成渲染空壳，槽位其实还挂着 | 开关要**真注销** `sidebar.panellist` / `conversation.view`，重新打开再注册 |
| 值班轮的会话全落在「未分组」里，怎么等都进不去工作区 | 会话的工作区归属靠 `attachSession()`，而它只被 `SessionService.create()`（从工作区发起）调到；CLI spawn 只有 cwd | 宿主盯 `sessions/<projectKey(cwd)>/`，新会话一落盘就 `resolveByPath` + `attachSession`（`lib/workspace-link.mjs`） |
| 上述认领上线了，界面上还是没归位 | 认领只在「那一轮跑着」的窗口里看着；插件重装/升级/那一轮异常退出留下的会话永远补不回来 | 开机再对一次账：`reconcileWorkspace()` 补缺、摘死（`detachSession()`），已对上的零写入 |
| 插件一加载，值班轮连 spawn 都没到就整条崩 | `watchNewSession()` 里 `unref` 打在了恒为 null 的旧变量上（`deadline` vs `deadlineTimer`），默认路径必抛 `Cannot read properties of null (reading 'unref')` | 定时器句柄只留一个变量名；测试里补一条**默认 `unref: true`** 的用例（原来所有用例都传 `unref: false`，正好把这条盖住了） |
| 外部改 `workspace.json` 当时看着生效，一会儿又变回去了 | `dsh-storage-json` 的 single-unit **以内存态为准**，整文件 tmp+rename 重发 | 别写文件；走 `attachSession()`，它同时改内存与磁盘 |
| 手拼会话日志，搬完只剩一个头部 | zstd 多帧的块头是 **3 字节**（`readUIntLE(offset,3)`），读成 4 字节就把整个文件当一帧 | 不碰字节。真要切帧就照 `dsh-session-persistence-jsonl` 的 `scanZstdFrames` 逐字段抄 |
| 会话顶部那块采风只露三条、下面一片空白 | 宿主 `.viewArea` 在 `data-phase=active` 时是 `flex:1 0 auto;min-height:auto`，子元素 `height:100%` 撑不起来 | 用 `:has()` 结构选择器改父级成 `flex:1 1 0;min-height:0`，外壳再 `flex:1` 铺满、自己滚 |

---

## 18. 怎么验（手工）

```powershell
# 1. 装进一个独立 profile（别动 desktop）
cd $env:USERPROFILE\.dsh\profiles\caifeng-smoke   # 或自建：dependencies 里 link 到本仓
dsh plugin --profile caifeng-smoke install

# 2. 起服务，拿 token
cmd /c set CAIFENG_DEBUG=1&& dsh --profile caifeng-smoke --no-open > tmp\smoke.log 2>&1
# 从日志里找：dsh web: http://127.0.0.1:3080/?token=XXXX

# 3. 先用 token 换 cookie（裸打 API 会 401「不允许的来路」）
#    之后带这个 cookie 打 /api/caifeng/*

# 4. 装 Python 环境（约 27 秒）
POST /api/caifeng/python

# 5. 跑一轮
POST /api/caifeng/run
```

单测与语法检查：

```powershell
npm test          # 198 条
npm run check:syntax
```

四条测试缝的边界要说清：真实 B站 网络、真 Edge、真 dsh 子进程**都不在测试里**——那三样交上表的手工验收。测试里用的是假 ctx、假 controller、假 DOM 桩，以及带白名单 env 真起的两条 MCP 进程（那条是真的，因为它验的就是「名单外的工具连名字都不出现」）。

