# 域文档（Domain Docs）

本文件说明工程类技能在探查本仓库时，该如何消费这里的域文档。

**布局结论：本仓库是 single-context**——一个仓库共用一套用语，根目录一份 `GLOSSARY.md`，架构决定放在 `docs/adr/`。不存在多上下文的子项目，因此没有、也不需要根目录的 `GLOSSARY-MAP.md` 与各子项目各自的 `GLOSSARY.md`。

## 动手探查之前，先读这些

- 仓库根目录的 **`GLOSSARY.md`**（single-context：全仓库共用这一份）。
- **`docs/adr/`**：读与本区域相关的 ADR。本仓库是 single-context，不存在 `src/<context>/docs/adr/` 这类按上下文分片的 ADR 目录。

文件或目录还不存在时，**静默通过**——不要提示缺失，也不要提前建议创建。等词语或决定真正定下来时，由 `/domain-modeling` 技能（经 `/grill-with-docs` 与 `/improve-codebase-architecture` 触达）按需创建。

## 文件结构

本仓库（single-context）：

```
/
├── GLOSSARY.md
├── docs/
│   ├── adr/
│   │   ├── 0001-xxx.md
│   │   └── 0002-yyy.md
│   └── agents/          ← 本文件所在处（技能配置，不是域文档）
└── ...
```

## 用词表里的词

产出里要提到某个领域概念时（issue 标题、重构提案、假设、测试名），用 `GLOSSARY.md` 里定义的词，不要漂移成词表明确回避的同义词。

需要用的概念词表里还没有，这本身是个信号：要么你在发明项目不用的语言（重新考虑），要么存在真实空档（记下来交给 `/domain-modeling`）。

## 撞上 ADR 就明说

产出与已有 ADR 冲突时，明确摆出来，不要悄悄覆盖：

> _与 ADR-0007（事件溯源的订单）冲突，但值得重开，因为……_
