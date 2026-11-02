# Issue tracker：GitHub

本仓库的 issue 与 spec 都放在 GitHub Issues 里，仓库是 `zhuifengqug/tianshu-caifeng`。所有操作走 `gh` CLI。

## 约定

- **建票**：`gh issue create --title "..." --body "..."`。多行正文用 heredoc。
- **读票**：`gh issue view <number> --json number,title,body,labels,comments`。
- **列票**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按需加 `--label` / `--state` 过滤。
- **挂子票**：`gh issue create --parent <parent> ...`，或事后 `gh issue edit <parent> --add-sub-issue <child>`（`gh` 2.94+）。老版本：`gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`（用数据库 id，取法见下条 **阻塞**）。若 sub-issue 不可用，在子票正文开头写 `Part of #<parent>`。
- **阻塞**：用 GitHub 原生 issue dependencies，这是唯一在 UI 上可见的规范表示。`gh issue create --blocked-by <n>,<n> ...` 或 `gh issue edit <child> --add-blocked-by <blocker>`（`gh` 2.94+）。老版本：`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是阻塞方票的数字**数据库 id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，**不是** `#number`，也不是 `node_id`）。依赖关系不可用时，退化为子票正文开头的 `Blocked by: #<n>, #<n>` 一行。所有阻塞方关闭后，这张票才算可开工。
- **数未关闭的阻塞方**：`gh api repos/<owner>/<repo>/issues/<n> --jq .issue_dependencies_summary.blocked_by`（只数未关闭的；0 表示可开工）。`gh issue view <n> --json blockedBy` 会把已关闭的也算进去，需要过滤：`--jq '[.blockedBy.nodes[] | select(.state == "OPEN")] | length'`。
- **评论**：`gh issue comment <number> --body "..."`。
- **加/摘标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`。
- **关票**：先用 `gh issue comment <number> --body "..."` 说明理由，再 `gh issue close <number>`。注意：对已关闭的票执行 `gh issue close --comment` 会丢掉评论但仍然返回 0。

仓库由 `git remote -v` 推断，`gh` 在克隆目录里会自动识别。

只往本仓库（用户自己的仓库）建票。永远不要往 `mattpocock/skills`（这些技能的来源仓库）建票，除非用户就是那个仓库的所有者。在 fork 里 `gh` 可能默认指向 upstream 父仓库，所以每个会话的第一次 `gh issue create` 之前，先跑 `gh repo view --json nameWithOwner` 核对目标，若不是用户自己的仓库就先跟用户确认。

## Pull request 作为 triage 入口

**PRs as a request surface: no.**（若本仓库把外部 PR 当作功能请求处理，改成 `yes`；`/triage` 会读这个标志。）

设为 `yes` 时，PR 走与 issue 相同的标签与状态，对应命令换成 `gh pr`：

- **读 PR**：`gh pr view <number>`，再看 `gh pr view <number> --comments`（非 TTY 下 `--comments` 只打印评论、不含正文），diff 用 `gh pr diff <number>`。
- **列出待 triage 的外部 PR**：`gh api --paginate 'repos/{owner}/{repo}/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`。
- **评论 / 打标签 / 关闭**：`gh pr comment`、`gh pr edit --add-label` / `--remove-label`、`gh pr close`。

GitHub 的 issue 与 PR 共用一套编号，所以裸写的 `#42` 可能指其中之一：先用 `gh pr view 42` 解析，失败再回退 `gh issue view 42`。

## 技能说「发布到 issue tracker」时

建一个 GitHub issue。

## 技能说「取出相关票据」时

按上面 **读票** 的操作读它。

## Wayfinding 操作

由 `/wayfinder` 使用。**地图**就是一张 issue，**票**是它的子 issue。

- **建地图**：一张 `wayfinder:map` 标签的 issue，正文承载 Notes / Decisions-so-far / Fog。`gh issue create --label wayfinder:map`。
- **建票**：作为地图的 GitHub sub-issue 挂在下面（见 **挂子票**）。sub-issue 不可用时，把子票加进地图正文的 task list，并在子票正文开头写 `Part of #<map>`。标签用 `wayfinder:<type>`（`research` / `prototype` / `grilling` / `task`）。被认领后，票分配给驱动的开发者。
- **阻塞**：见 **约定** 里的 **阻塞**。
- **找前沿票**：列出地图的未关闭子票（`gh issue list --state open`，按地图的子票 / task list 收窄），剔除有未关闭阻塞方的（见 **数未关闭的阻塞方**，或 `Blocked by` 行里还有未关闭的票）以及已有认领人的；地图顺序里最靠前的那张胜出。
- **认领**：`gh issue edit <n> --add-assignee @me`，这是本会话的第一次写操作。
- **结票**：`gh issue comment <n> --body "<结论>"`，再 `gh issue close <n>`，然后把上下文指针（要点 + 链接）追加到地图的 Decisions-so-far。
