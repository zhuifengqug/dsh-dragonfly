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
├─ index.js                    host 入口：配置、路由、工具注册、调度
├─ client.js                   设置页 + 主区页（一套视觉，两边样式都不复用）
├─ cordis.patch.yml            bundle patch
├─ icon.svg
├─ dsh-plugin.naming.json
├─ locale/{zh-CN,en}.json
├─ prompts/
│  └─ duty.md                  值班章程（B站/抖音合写，人格内联）
├─ profile-template/
│  └─ caifeng-duty/
│     ├─ cordis.patch.yml      受限 profile（照 bili 的边界改 id）
│     ├─ cordis.yml
│     └─ package.json
├─ lib/
│  ├─ paths.mjs                家目录解析（可配置根 + $DSH_HOME 回退）
│  ├─ state.mjs                配置读写、额度计数、运行锁
│  ├─ seen.mjs                 判重表读写
│  ├─ report.mjs               日报拼装与写入（含单片笔记）
│  ├─ charter.mjs              章程校验（sha256）+ 每轮注入
│  ├─ models.mjs               采风模型的候选列表与解析
│  ├─ login.mjs                B站扫码登录
│  ├─ verify.mjs               运行时自检
│  ├─ diagnose.mjs             诊断
│  ├─ uvfetch.mjs              Python 运行时（uv venv 管理）
│  └─ hostdeps.mjs             Python/uv 探测
├─ bili/
│  ├─ search.mjs
│  ├─ subtitle.mjs
│  ├─ comments.mjs
│  ├─ frames.mjs               故事板取帧
│  ├─ favorites.mjs            收藏夹最近
│  ├─ reply.mjs                发评论 / 回复
│  ├─ dm.mjs                   私信
│  └─ mcp.mjs                  B站 MCP 通道（vendor 内嵌）
├─ dy/
│  ├─ core.mjs                 抖音浏览器层（修剪版，见 §12）
│  ├─ browser-launcher.mjs     专用 Edge 启动/连接
│  ├─ browser-host.mjs
│  ├─ browser-pages.mjs        页归属与锁
│  ├─ browser-pause.mjs
│  ├─ video-storyboard.mjs     分镜帧
│  └─ tools.mjs                4 个抖音工具的定义与参数校验
├─ vendor/bilibili-mcp/
└─ tests/
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
      "inject": ["@deepseek-ai/dsh-client-ui-settings-general"]
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
├─ seen.md                  判重表（§8）
├─ duty.md                  章程副本
├─ charter.sha256           章程指纹
├─ duty.log                 值班日志
├─ run-lock.json            运行锁
├─ creds/bili-credential.json
├─ dy/profile/              专用 Edge 的 user-data-dir（持久登录）
└─ dy/control/              浏览器锁
```

改根目录时的规则：

- 立即生效，下一次运行就用新目录
- 只**复制** `config.json` / `seen.md` / `creds/` 到新目录，`out/` 和 `reports/` 不搬（历史留在原处，设置页提示"旧目录还有 N 份日报"）
- 新目录里没有 `dy/profile/` 时提示"换目录需要重新扫码登录"
- 目标是已存在的非空目录时先确认，不覆盖

**首次启动**：从旧 `$DSH_HOME/bili-duty/` 做一次性幂等导入——`config.json` 字段按名迁移、`seen.md` 并入 `## B站` 节、`out/*.md` 不搬。导入完成写 `migrated-from: bili-duty`，此后不再读旧目录。**不覆写旧目录**，旧插件可以继续跑着对照。

---

## 6. 工具契约

16 个工具，前缀统一 `caifeng_`。

### B站

| 工具 | 参数 | 返回 |
|---|---|---|
| `caifeng_bili_search` | `{ keyword, sort?: 'pubdate'\|'click'\|'totalrank', pages?: 1-5 }` | `[{ bvid, title, author, play, duration, pubdate, desc }]` |
| `caifeng_bili_subtitle` | `{ bvid }` | `{ ok, lang, text, chars }`；无字幕返回 `{ ok:false, reason:'no-subtitle' }` |
| `caifeng_bili_comments` | `{ bvid, limit?: 1-50 }` | `[{ rpid, user, text, like, replies }]` |
| `caifeng_bili_frames` | `{ bvid, at?: number[] }` | 图片附件（1-6 帧） |
| `caifeng_bili_favorites` | `{ folder?: string, days?: 1-30 }` | `[{ bvid, title, author, favedAt, folder }]` |
| `caifeng_bili_reply` | `{ bvid, rpid?: number, text, force?: true }` | `{ sent, rpid }`；`autoComment=false` 时拒绝，除非 `force:true`（本人当场授权） |
| `caifeng_bili_dm` | `{ action: 'list'\|'read'\|'reply', uid?, text? }` | `list` → 最近会话；`read` → 消息；`reply` 受 `dmMode` 闸门 |

### 抖音

| 工具 | 参数 | 返回 |
|---|---|---|
| `caifeng_dy_open` | `{ query?: string }` | 状态快照；无 `query` 打开推荐流，有 `query` 走搜索 |
| `caifeng_dy_state` | `{}` | `{ url, video:{id,author,title,time,duration,paused}, pageKind, searchResults[], visibleText, loginRequired, verificationRequired }` |
| `caifeng_dy_next` | `{}` | 换下一条后的状态快照 |
| `caifeng_dy_frames` | `{ seconds?: 1-10 }` | 图片附件 + `{ videoId, duration }` |

### 本地与运维

| 工具 | 参数 | 返回 |
|---|---|---|
| `caifeng_report_write` | `{ date?, entries:[{source,id,title,verdict,why,comment,detail?}], skipped:[{source,id,reason}], note? }` | `{ path, notes: string[], bytes }`；同一天多次调用按 `id` 合并去重；`detail` 存在且 `notesEnabled` 时另写 `reports/<id>.md` |
| `caifeng_seen` | `{ check?: string[], mark?: [{source,id,verdict}] }` | `{ seen: string[], marked: number, total }` |
| `caifeng_status` | `{}` | 今日条数/额度/下次窗口/最近日报路径/两信源可用性/当前模型 |
| `caifeng_run` | `{}` | 立刻跑一轮（不等窗口），返回 `{ runId, startedAt }` |
| `caifeng_config` | `patch: object` | 改配置并回读（只认 §9 字段） |

**登录、装 Python、诊断这类一次性运维不进工具**，全在设置页里做——它们需要人看二维码、需要进度条，做成工具只会污染 duty 会话的工具箱。

**duty 会话白名单**：B站 7 + 抖音 4 + `report_write` + `seen` = 13 个。`status`/`run`/`config` 只给用户自己的会话。

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
- 3 条新私信，其中 2 条值得回

## 判重
今天新记 7 条，累计 128 条

## 总结
三两句话，说今天这一圈的整体判断。
```

约束：

- 每条必须有 `[B站]` 或 `[抖音]` 前缀，跨信源按"值得看"优先排序
- `为什么值得` 不许空话；写不出具体理由就降到 `扫过没收的`
- 同一天重复跑，按 `id` 合并而不是追加新文件
- 「私信」节只在 `dmEnabled` 且有新消息时出现

---

## 8. 判重表

`seen.md`，分信源两节，同 id 只记一次：

```markdown
## B站
BV1xx  2026-11-01  收
BV1yy  2026-11-01  弃

## 抖音
7400...  2026-11-01  弃
```

`caifeng_seen` 一次调用同时能查能记。跨信源 id 不会撞（BV 前缀 vs 纯数字），但仍分节，方便人肉查。

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
  "dmEnabled": true,
  "dmMode": "read",            // read | draft | auto（默认 read，见 §16）
  "dmUid": 0
}
```

抖音侧没有独立配置块——只借 `sources.douyin`、`dyDailyMinutes`、`keywords`。旧 douyin 插件的 7 类设置（人格、视频时间、自检、好友互动、公开评论、音频密钥、日报）合并成上面这几行，其余全部砍掉。

**模型的候选列表从哪来**：实现时确认——优先读 DSH 已配置的 provider/model 注册面；读不到就退化成手填 `provider` + `model` 两个文本框。不做硬编码列表。

---

## 10. 设置页

两个页签。

### 顶部（两页签共用）

一条状态带，不是卡片：

```
今日已收 3 条（B站 2 / 抖音 1）· 额度 5 · 下次 14:00 · [现在就跑]
```

### 页签一：今天

- 今日日报正文（只读渲染，`<家目录>/out/<今天>.md`）
- 日期切换（最近 7 天）
- 空态：今天还没跑 → 显示"还没采过，[现在就跑]"
- 与主区页是**同一个组件**，这里挂精简版（无侧栏、无导出按钮）

### 页签二：设置

四段平铺，后两段默认折起：

| 段 | 项 |
|---|---|
| **信源与额度** | 两个信源开关、每天几条、抖音分钟、每轮细看几条、时段 |
| **怎么挑** | 关键词、排除词、排序、翻页、人格 |
| **互动与产出**（折起） | 自动评论（开关/每轮/长度/@谁）、回复评论、私信、收藏夹、单片笔记、日报详略 |
| **运行环境**（折起） | **模型下拉**、**存放位置**、B站登录、抖音浏览器、诊断、Python 环境 |

视觉规则：

- 单列，`max-width: 640px`；主区页可放宽到 900px
- 只有两种字号：13px 正文 / 11px 小节标题
- 不要卡片墙，用分组 + 分隔线
- 一套自绘 CSS，不复用 bili 的 `[data-bd-*]`，也不复用 douyin 的 primitives 内联样式

### 主区页（`main` 槽）

```
采风                                    [现在就跑]
今日已收 3 条 · 额度 5 · 下次 14:00
────────────────────────────────────────
今日日报（完整渲染）
────────────────────────────────────────
最近 7 天  ·  2026-10-31  ·  2026-10-30 …
```

---

## 11. 安全边界

照搬 bili 的做法，只改 id：`profile-template/caifeng-duty/cordis.patch.yml` 建一个专用 profile，`bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']`。

禁用：`tool-bash` `tool-pwsh` `tool-jobs` `jobs` `tool-ralph` `tool-fs` `tool-fs-search` `tool-web` `web-fetch-http` `web-search-deepseek` `tool-subagent*` `subagent*` `workflow-ptc` `ptc-runtime` `tool-workflow` `skill` `skill-filesystem` `skill-badge` `tool-skill` `agent-instructions` `tool-plugin-manager` `plugin-manager` `hmr` `goal*` `plan-mode` `tool-todo` `mcp-resources`

补开：`credentials` `authorization` `deepseek-account` `agent-default-model`（config 由 §9 的 `model` 决定，空则用 `deepseek-account` + `deepseek-flash`）

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

---

## 13. 实施

分两步，每步都能单独验收。

### 第一步：骨架 + B站

交付：包骨架、命名清单、`lib/`、`bili/`、设置页两页签 + 主区页、`prompts/duty.md`、受限 profile 模板、B站 7 个工具 + 本地 2 个 + 运维 3 个。

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

## 14. 取件清单

参考源码（已 clone，实现时可直接对照）：

- bili v2.3.1 → `D:\dsh-workspaces\dev\local-plugins\2026-11-01-刷片插件合并\tmp\bili-src`
- douyin v1.4.6 → `D:\dsh-workspaces\dev\local-plugins\2026-11-01-刷片插件合并\tmp\douyin-src`

| 目标 | 来源 | 处理 |
|---|---|---|
| `lib/{state,login,verify,diagnose,uvfetch,hostdeps}.mjs` | bili `lib/` 同名 | 直接搬，改导入路径 |
| `bili/mcp.mjs` + `vendor/bilibili-mcp/` | bili `lib/mcp.mjs` + `vendor/` | 直接搬 |
| `bili/{search,subtitle,comments,frames,favorites,reply,dm}.mjs` | bili `index.js` 里对应工具的实现 | **拆出来**，不整体搬 |
| `lib/paths.mjs` | 新写 | 借鉴 douyin `runtime-paths.mjs` 的解析顺序，加可配置根 |
| `lib/{seen,report,charter,models}.mjs` | 新写 | 契约见 §5 §7 §8 §9 |
| `prompts/duty.md` | bili `prompts/duty.md` | **重写**：合并抖音信源、人格内联、工具名换成 `caifeng_*` |
| `profile-template/caifeng-duty/*` | bili `profile-template/bili-duty/*` | 改 id 与白名单 |
| `dy/core.mjs` | douyin `core.mjs` | 按 §12 删 |
| `dy/{browser-launcher,browser-host,browser-pages,browser-pause,video-storyboard}.mjs` | douyin 同名 | 直接搬 |
| `dy/tools.mjs` | douyin `tool-definitions.mjs` | 只留 4 个工具的定义 |
| `client.js` | 新写 | 只借 bili 的 CSS 结构思路，不复用样式 |
| `lib/asr.py` `lib/favops.py` | bili `lib/` | **不搬**（无转写）；`favops.py` 的收藏夹逻辑改写成 `bili/favorites.mjs` |

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

## 16. 待确认

- **`dmMode` 默认值**：定为 `read`（只看不发，最安全）。想要别的档说一声。
- **`icon.svg`**：建议一枚单色简化的风向标或罗盘，实现时画。
- **`locale/en.json`**：`群策` 有，可以照做；不做也能跑。
