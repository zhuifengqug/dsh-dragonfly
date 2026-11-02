# AGENTS.md

给在本仓库工作的 Agent 的入口说明。

## Agent skills

### Issue tracker

Issue 与 spec 都放在 GitHub Issues（`zhuifengqug/tianshu-caifeng`），统一走 `gh` CLI。见 `docs/agents/issue-tracker.md`。

### Triage labels

Triage 用默认五角色 `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`；wayfinder 另用 `wayfinder:map` / `research` / `prototype` / `grilling` / `task`。见 `docs/agents/triage-labels.md`。

### Domain docs

single-context 布局：根目录一份 `GLOSSARY.md`，架构决定放 `docs/adr/`。见 `docs/agents/domain.md`。
