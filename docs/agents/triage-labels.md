# Triage 标签词表

技能用五个规范的 triage 角色说话。本文件把角色映射到本仓库 issue tracker 里实际使用的标签字符串。

| 角色（技能里叫这个） | 本仓库实际标签 | 含义 |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | 维护者需要先评估这张票 |
| `needs-info` | `needs-info` | 等报告人补充信息 |
| `ready-for-agent` | `ready-for-agent` | 已描述完整，可交给 AFK agent 直接干 |
| `ready-for-human` | `ready-for-human` | 需要人来实现 |
| `wontfix` | `wontfix` | 不做 |

技能里提到某个角色时（比如「打上 AFK-ready 的 triage 标签」），用本表对应行的标签字符串。

状态流转：未打标签的票通常先落 `needs-triage`；从那里再走向 `needs-info`、`ready-for-agent`、`ready-for-human` 或 `wontfix`。报告人回复后，`needs-info` 回到 `needs-triage`。维护者随时可以覆盖；遇到看起来不寻常的流转，先问再做。

## Wayfinder 标签

`/wayfinder` 用另一套标签，与 triage 角色互不混用：

| 标签 | 用途 |
| --- | --- |
| `wayfinder:map` | 探索地图本体（一张 issue） |
| `wayfinder:research` | 调研型票 |
| `wayfinder:prototype` | 原型型票 |
| `wayfinder:grilling` | 拷问 / 追问型票 |
| `wayfinder:task` | 动手实现型票 |

规则：地图与它的票**只带** `wayfinder:` 系列标签，绝不带 `ready-for-agent` 之类的 triage 标签——它们是决策产物，不是实现工作。
