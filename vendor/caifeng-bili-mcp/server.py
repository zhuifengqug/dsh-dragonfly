#!/usr/bin/env python3
"""
天枢·采风 —— B站 MCP 服务（只做值班一轮需要的 9 个工具）
================================================================================
这个文件是**衍生作品**：基座是上游 AGI_Ananas/bilibili-mcp（MIT，见同目录 LICENSE），
本插件在它的实现手法上只保留采风用得着的那几条路，并加了下面这些它没有的东西。
**将来重新 vendor（把上游 mcp_server.py 拿回来覆盖）时，下面每一处都要原样补回来**，
漏一处就少一道闸：

  ① 工具白名单 `_ALLOWED` + `tool()` 装饰器替身 + 写操作入口的 `_guard()`：
     环境变量是 `CAIFENG_BILI_TOOLS`（逗号分隔）—— 不在名单里的工具**连名字都不会
     出现在 list_tools 里**；`caifeng_bili_reply` 与 `caifeng_bili_dm` 的 reply 分支
     入口再过一道 `_guard()`，没开就直接返回、什么都不做。
  ② 凭证容错 `load_credential()`：读 `<家目录>/creds/bili-credential.json`
     （**不是**同目录）、`encoding="utf-8"`、`OSError`/`ValueError`/非 dict 一律
     退化成「没登录」并打 stderr —— 凭证写坏一次不能让所有工具一起崩。
  ③ 语感闸门 `_style_reason()`（只给 reply 用）：开头八股黑名单正则 +
     跟自己台账 `<家目录>/comments.md` 的 bigram 相似度 ≥0.55 + 跟这条视频热评
     相似 ≥0.5；撞了**不发**，把「为什么 + 怎么改」返回给模型。
     `CAIFENG_STYLE_OFF=1` 可以关掉。
  ④ `caifeng_bili_comments` 把抓取异常带进返回的 `error` 字段 ——
     风控 -412 绝不能伪装成「这条视频 0 条评论」。
  ⑤ `caifeng_bili_reply` 的回执带上 `rpid` / `rpid_str` / `root` / `parent`
     （判重表与评论复核要用）。
  ⑥ 画面帧 `caifeng_bili_frames`：**图作为 MCP image content 返回**，由宿主决定能不能
     进模型上下文（上游没有；这是本插件加的）。
  ⑦ 窄口本地 IO：`caifeng_report_write` / `caifeng_seen` —— 固定路径、不接受路径参数、
     同一天按 id 合并、竖线转义。上游只有「追加」，这里是「合并」。
  ⑧ 家目录从 `CAIFENG_HOME` 取（兜底 `~/.dsh/caifeng`），不再用 `Path(__file__).parent`。

**没有做的事**（写清楚，免得下次有人以为是漏了）：
  · **不下载视频、不用 ffmpeg 裁帧**。画面一律从 B站 自带的故事板
    （`x/player/videoshot`）里裁，`Video.get_video_snapshot(cid=…, json_index=True,
    pvideo=False)` 一行就够。要多精确的时刻、或者视频根本没故事板 —— 那是另一套
    （下载+解码）的实现，不放进值班轮：一轮 30 分钟、跑在受限沙箱里，扛不住。
  · 不做登录/扫码、不做 up 主信息、排行榜、投稿上传、批量采集、弹幕、转写。
    这些要么是运维（设置页里做），要么值班轮根本不用。

工具清单（正好 9 个，多一个都不行）：
    caifeng_bili_search / caifeng_bili_subtitle / caifeng_bili_comments /
    caifeng_bili_frames / caifeng_bili_favorites / caifeng_bili_reply /
    caifeng_bili_dm / caifeng_report_write / caifeng_seen
================================================================================
"""

import asyncio
import base64
import datetime as _dt
import json
import os
import random
import re
import struct
import sys
from pathlib import Path

from mcp.server.fastmcp import FastMCP
from mcp.types import ImageContent, TextContent

from bilibili_api import comment, favorite_list, search, session, video
from bilibili_api import user as bili_user
from bilibili_api.utils.network import Credential

# ============================================================================
# 家目录与固定路径
# ============================================================================

CAIFENG_HOME = Path(
    os.environ.get("CAIFENG_HOME") or (Path.home() / ".dsh" / "caifeng")
)

CRED_FILE = CAIFENG_HOME / "creds" / "bili-credential.json"   # ⚠️ 在 creds/ 子目录里
SEEN_FILE = CAIFENG_HOME / "seen.md"
REPORTS_DIR = CAIFENG_HOME / "reports"
OUT_DIR = CAIFENG_HOME / "out"
COMMENTS_FILE = CAIFENG_HOME / "comments.md"


# ============================================================================
# 初始化 / 节流
# ============================================================================

mcp = FastMCP("caifeng-bili-mcp")


async def _throttle():
    """每个读工具动手之前先睡一下（0.6–1.6s）—— 一轮里连着调十几次，太密会被风控。"""
    try:
        await asyncio.sleep(random.uniform(0.6, 1.6))
    except Exception:
        pass


def _j(obj) -> str:
    return json.dumps(obj, ensure_ascii=False)


# ============================================================================
# 闸门 ①：工具白名单
# ============================================================================
# 宿主通过 overlay 的 env 下发 CAIFENG_BILI_TOOLS（逗号分隔）。
#   · 不给这个变量 ⇒ **全放**（手工跑、或老配置）
#   · 给了 ⇒ 只注册名单里的；名字不在名单里的工具连 list_tools 里都看不到，
#     模型那边等于根本不存在 —— 这才是真的闸门（光靠提示词说"别用"不算）
_ALLOWED = {
    t.strip()
    for t in os.environ.get("CAIFENG_BILI_TOOLS", "").split(",")
    if t.strip()
}


def tool():
    """@tool() 的替身：白名单里没有这个函数名，就原样返回、**不注册**。"""

    def deco(fn):
        if _ALLOWED and fn.__name__ not in _ALLOWED:
            return fn
        return mcp.tool()(fn)

    return deco


def _guard(name: str) -> str:
    """没开这个工具就返回一句提示；开着返回空串。

    白名单只挡"注册"不挡"直接调用"—— agent 手里要是有 python 能 import 这个文件，
    闸门就形同虚设。所以每个**会往 B站 写东西**的函数入口都再过一遍这里。
    """
    if _ALLOWED and name not in _ALLOWED:
        print(f"[caifeng-bili] 拒绝调用 {name}（不在 CAIFENG_BILI_TOOLS 白名单里）", file=sys.stderr)
        return f"这个工具没开：{name}"
    return ""


# ============================================================================
# 闸门 ②：语感闸门（只给 caifeng_bili_reply 用）
# ============================================================================
# 背景：章程里写"要有具体细节、别客套"，模型照样写"这条我认""值得一看"——
#       禁令没有范例有效、自觉没有拦截可靠 ⇒ 在执行层做最后一道检查。
# 三道检查（便宜、纯本地 / 一次轻请求）：
#   ① 开头八股黑名单（正则）
#   ② 跟**自己以前发过的评论**太像（bigram 相似度 ≥0.55）—— 治"每条一个味"
#   ③ 跟**这条视频现有热评**太像（≥0.5）—— 治"跟别人撞车"
# ⚠️ 撞了就**不发**，把原因和改法返回给模型，让它重写一句。
# ⚠️ 关掉：`CAIFENG_STYLE_OFF=1`。
_STYLE_OFF = os.environ.get("CAIFENG_STYLE_OFF", "") in ("1", "true", "yes")
_STYLE_LEAD = re.compile(
    r"^\s*(?:"
    r"这条(?:我认|我记下了|值得)|我记下了|值得一看|确实值得|不得不说|"
    r"好家伙|这个(?:必须|真的要)|强烈推荐|感谢分享|学到了|受教了|"
    r"作为一个|总之|综上"
    r")"
)


def _bigrams(s: str) -> set:
    t = re.sub(r"[^\w\u4e00-\u9fff]", "", "".join(ch for ch in str(s or "") if not ch.isspace()))
    if len(t) < 2:
        return set(t)
    return {t[i:i + 2] for i in range(len(t) - 1)}


def _sim(a: str, b: str) -> float:
    """bigram Jaccard —— 够用、够快、零依赖"""
    x, y = _bigrams(a), _bigrams(b)
    if not x or not y:
        return 0.0
    return len(x & y) / max(1, len(x | y))


def _ledger_recent(n: int = 30) -> list:
    """最近 n 条"自己发过的评论"正文（台账一行：`- 日期 BVID rpid=… · 正文`）"""
    try:
        if not COMMENTS_FILE.exists():
            return []
        out = []
        for ln in COMMENTS_FILE.read_text(encoding="utf-8", errors="replace").splitlines():
            ln = ln.strip()
            if not ln.startswith("- "):
                continue
            body = ln.split("·", 1)[1].strip() if "·" in ln else ln[2:].strip()
            if body:
                out.append(body)
        return out[-n:]
    except Exception:
        return []


def _ledger_append(text: str, bvid: str, rpid=None):
    """往台账记一行：`- YYYY-MM-DD HH:MM {bvid} rpid={n} · {正文}`"""
    try:
        COMMENTS_FILE.parent.mkdir(parents=True, exist_ok=True)
        stamp = _dt.datetime.now().strftime("%Y-%m-%d %H:%M")
        body = " ".join(str(text).split())
        with open(COMMENTS_FILE, "a", encoding="utf-8", newline="\n") as f:
            f.write(f"- {stamp} {bvid} rpid={rpid or 0} · {body}\n")
    except Exception:
        pass


async def _style_reason(text: str, bvid: str, cred) -> str:
    """返回"为什么这句不能发"；空串 = 可以发"""
    if _STYLE_OFF:
        return ""
    body = " ".join(str(text or "").split())
    if not body:
        return "评论是空的。"

    m = _STYLE_LEAD.match(body)
    if m:
        return (
            f"开头「{m.group(0).strip()}」是八股。直接说这条视频里的具体东西："
            "「这期讲了什么 + 一个只有看了才说得出的细节」，开头别用套话。"
        )

    for old in _ledger_recent(30):
        s = _sim(body, old)
        if s >= 0.55:
            return (
                f"这句跟你以前发过的「{old[:18]}…」太像了（相似度 {s:.2f}）。"
                "换开头、换关注点，别套同一个句式。"
            )

    try:
        v = video.Video(bvid=bvid, credential=cred)
        info = await v.get_info()
        aid = info["aid"]
        resp = await comment.get_comments(
            oid=aid,
            type_=comment.CommentResourceType.VIDEO,
            page_index=1,
            order=comment.OrderType.LIKE,
            credential=cred,
        )
        for c in (resp.get("replies") or [])[:20]:
            other = " ".join(str((c.get("content") or {}).get("message", "")).split())
            if not other:
                continue
            s = _sim(body, other)
            if s >= 0.5:
                return (
                    f"这条视频底下已经有一句很像的（相似度 {s:.2f}）：{other[:24]}… "
                    "撞车了 —— 换个角度写，或者这一轮不发。"
                )
    except Exception:
        pass  # 读不到热评就不做这道检查（不能因为读不到就不让发）
    return ""


# ============================================================================
# 闸门 ③：凭证（读不了 / 写坏了都退化成"没登录"，绝不崩）
# ============================================================================


def load_credential():
    """从 <家目录>/creds/bili-credential.json 加载凭证；没有 / 读不了 → None"""
    if not CRED_FILE.exists():
        return None
    try:
        with open(CRED_FILE, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        # ⚠️ 文件写坏一次（上一次写被打断）会让**所有**工具一起 JSONDecodeError：
        #    这里退化成「没登录」，重新扫一次码就能恢复。
        print(
            f"[caifeng-bili] 凭证读不了（{type(e).__name__}: {e}）：{CRED_FILE}",
            file=sys.stderr,
        )
        return None
    if not isinstance(data, dict):
        print(f"[caifeng-bili] 凭证不是对象：{type(data).__name__}，当作没登录", file=sys.stderr)
        return None
    return Credential(
        sessdata=data.get("sessdata", ""),
        bili_jct=data.get("bili_jct", ""),
        buvid3=data.get("buvid3") or "",
        dedeuserid=data.get("dedeuserid", ""),
    )


def get_cred():
    """要登录才能用的工具走这里；没登录就抛一句人话。"""
    cred = load_credential()
    if not cred:
        raise Exception(
            "未登录 B站：拿不到凭证（<家目录>/creds/bili-credential.json）。"
            "让使用者在设置页里扫码登录一次。"
        )
    return cred


def _my_uid(cred) -> int:
    try:
        return int(str(getattr(cred, "dedeuserid", "") or "0"))
    except Exception:
        return 0


# ============================================================================
# 图片 / 画面帧的常量与辅助（frames 用；不解码视频、不用 ffmpeg）
# ============================================================================

_WEB_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
_HTTP_TIMEOUT = 25               # 图床 / 快照下载统一超时（秒）
# 单帧防御性上限：实测帧 2.6–29KB，正常走不到这一行
_MAX_IMAGE_BYTES = 1_500_000
_FRAME_MAX = 6
_TILE_W_DEFAULT = 480
_TILE_H_DEFAULT = 270


def _https(url: str) -> str:
    """把 B站的图片/资源地址统一成 https。

    故事板给的地址没有协议头（`//…`），而 http 不会跳转 https；图床请求再带上
    SESSDATA 就等于把登录凭据明文发出去。
    """
    u = str(url or "")
    if u.startswith("//"):
        return "https:" + u
    if u.startswith("http://"):
        return "https://" + u[len("http://"):]
    return u


def _image_headers() -> dict:
    """图床请求头：只给 UA + Referer，**不带 Cookie**（图床不需要登录态）。"""
    return {"User-Agent": _WEB_UA, "Referer": "https://www.bilibili.com/"}


def _text_only(payload: dict) -> list:
    return [TextContent(type="text", text=_j(payload))]


def _snapshot_entries(data: dict, duration: float = 0.0) -> list:
    """把 videoshot 的 index 归一成 [(秒, 块序号), ...]。

    时间单位实测两种都出现过（秒 / 毫秒），只能靠和时长比较来判断：
    超过时长 1.5 倍才当毫秒。⚠️ 别再加"绝对值大于某个数就当毫秒"这类判据 ——
    6 小时视频的秒数（22163）会被误判成毫秒，三帧全塌到同一块、时间缩小 1000 倍。
    """
    raws = []
    for i, item in enumerate(data.get("index") or []):
        ts = item.get("timestamp") if isinstance(item, dict) else item
        try:
            raws.append((float(ts), i))
        except (TypeError, ValueError):
            continue
    if not raws:
        return []

    biggest = max(v for v, _ in raws)
    looks_ms = duration > 0 and biggest > duration * 1.5
    scale = 1000.0 if looks_ms else 1.0
    return [(v / scale, i) for v, i in raws]


async def _entries_from_pvdata(data: dict) -> list:
    """index 为空时的兜底：pvdata 指向一个大端 uint16 秒数数组，与 index 逐项相同。"""
    url = _https(data.get("pvdata") or "")
    if not url:
        return []
    try:
        raw = await _fetch_bytes(url, _image_headers())
    except Exception:
        return []
    if not raw or len(raw) % 2:
        return []
    count = len(raw) // 2
    if count > 20000:            # 明显不对，别乱解
        return []
    return [(float(sec), i) for i, sec in enumerate(struct.unpack(f">{count}H", raw))]


async def _fetch_bytes(url: str, headers: dict) -> bytes:
    import aiohttp

    timeout = aiohttp.ClientTimeout(total=_HTTP_TIMEOUT)
    async with aiohttp.ClientSession(timeout=timeout) as s:
        async with s.get(_https(url), headers=headers) as resp:
            if resp.status != 200:
                raise RuntimeError(f"HTTP {resp.status}")
            return await resp.read()


def _crop_tile(sheet: bytes, tile_index: int, tw: int, th: int) -> bytes:
    """从拼图里裁出第 tile_index 块，返回 jpeg 字节。"""
    import io

    from PIL import Image

    img = Image.open(io.BytesIO(sheet))
    cols = max(1, img.width // tw)
    rows = max(1, img.height // th)
    if tile_index >= cols * rows:
        raise RuntimeError(f"第 {tile_index} 块超出拼图（只有 {cols}×{rows}）")
    col, row = tile_index % cols, tile_index // cols
    tile = img.crop((col * tw, row * th, (col + 1) * tw, (row + 1) * th)).convert("RGB")
    buf = io.BytesIO()
    tile.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


# ============================================================================
# 本地小工具：日期 / 单元格 / 读写
# ============================================================================

_DATE_RE = re.compile(r"^(?:(\d{4})[-/.])?(\d{1,2})[-/.](\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$")


def _today() -> str:
    return _dt.date.today().isoformat()


def _norm_date(raw: str) -> str:
    """模型给的日期 → YYYY-MM-DD；认不出来就用今天。

    没写年份按今年补，补出来比今天晚就算去年 —— 跟宿主 lib/seen.mjs 的 seenDay 同一套规则。
    """
    today = _dt.date.today()
    m = _DATE_RE.match(str(raw or "").strip())
    if not m:
        return today.isoformat()
    y = int(m.group(1)) if m.group(1) else today.year
    try:
        d = _dt.date(y, int(m.group(2)), int(m.group(3)))
        if not m.group(1) and d > today:
            d = d.replace(year=y - 1)
    except ValueError:
        return today.isoformat()
    return d.isoformat()


def _seen_day(raw: str) -> str:
    """表格里那一格能不能认出日期；认不出返回空串（**不**拿今天顶）。"""
    s = str(raw or "").strip()
    if not _DATE_RE.match(s):
        return ""
    today = _dt.date.today()
    m = _DATE_RE.match(s)
    y = int(m.group(1)) if m.group(1) else today.year
    try:
        d = _dt.date(y, int(m.group(2)), int(m.group(3)))
        if not m.group(1) and d > today:
            d = d.replace(year=y - 1)
    except ValueError:
        return ""
    return d.isoformat()


def _cell(s, limit: int = 60) -> str:
    """表格单元格：压空白、转义竖线、截断。"""
    t = " ".join(str(s or "").split())
    return t.replace("|", "\\|")[:limit]


def _read_text(path: Path) -> str:
    try:
        if path.exists():
            return path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n")
    except Exception:
        pass
    return ""


def _write_text(path: Path, text: str) -> str:
    """落盘：UTF-8 + LF + **末尾只有一个换行**。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    body = text.replace("\r\n", "\n").rstrip("\n") + "\n"
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(body)
    return str(path)


# ============================================================================
# Tool 1: 搜索
# ============================================================================


@tool()
async def caifeng_bili_search(
    keyword: str, num: int = 10, order: str = "totalrank", page: int = 1
) -> str:
    """
    搜B站视频

    Args:
        keyword: 搜索关键词，如"AI Agent"、"大模型教程"
        num: 返回几条，默认 10，最多 50
        order: 排序 totalrank=综合 click=播放量 pubdate=最新 dm=弹幕
        page: 第几页，从 1 开始（一页约 20 条）

    Returns:
        JSON：{keyword, count, videos:[{bvid,aid,title,author,play,review,danmaku,duration,pubdate,description}]}
    """
    await _throttle()
    order_map = {
        "totalrank": search.OrderVideo.TOTALRANK,
        "click": search.OrderVideo.CLICK,
        "pubdate": search.OrderVideo.PUBDATE,
        "dm": search.OrderVideo.DM,
    }
    order_enum = order_map.get(str(order or "").strip(), search.OrderVideo.TOTALRANK)
    want = max(1, min(int(num or 10), 50))

    try:
        cred = load_credential()      # 搜索是公开的，没登录也搜得动
        result = await search.search_by_type(
            keyword=keyword,
            search_type=search.SearchObjectType.VIDEO,
            page=max(1, int(page or 1)),
            order_type=order_enum,
            credential=cred,
        )
    except Exception as e:
        return _j({"keyword": keyword, "count": 0, "videos": [], "error": f"{type(e).__name__}: {e}"})

    videos = []
    for item in (result.get("result") or [])[:want]:
        title = str(item.get("title", ""))
        title = title.replace('<em class="keyword">', "").replace("</em>", "")
        videos.append({
            "bvid": item.get("bvid", ""),
            "aid": item.get("aid", 0),
            "title": title,
            "author": item.get("author", ""),
            "play": item.get("play", 0),
            "review": item.get("review", 0),
            "danmaku": item.get("video_review", 0),
            "duration": item.get("duration", ""),
            "pubdate": item.get("pubdate", 0),
            "description": str(item.get("description", ""))[:200],
        })

    return _j({"keyword": keyword, "count": len(videos), "videos": videos})


# ============================================================================
# Tool 2: 字幕
# ============================================================================


@tool()
async def caifeng_bili_subtitle(bvid: str) -> str:
    """
    取一个视频的 AI 字幕全文（判断内容就靠它）

    Args:
        bvid: 视频BV号，如"BV1uNk1YxEJQ"

    Returns:
        有字幕：{bvid,title,language,segments,text}
        没字幕：{ok:false, reason:"no-subtitle"}
        没有 cid：{ok:false, reason:"no-cid"}
    """
    await _throttle()
    try:
        cred = load_credential()
        v = video.Video(bvid=bvid, credential=cred)
        info = await v.get_info()
    except Exception as e:
        return _j({"bvid": bvid, "ok": False, "reason": "error", "error": f"取视频信息失败：{e}"})

    cid = info.get("cid", 0)
    if not cid and info.get("pages"):
        cid = (info["pages"][0] or {}).get("cid", 0)
    if not cid:
        return _j({"bvid": bvid, "ok": False, "reason": "no-cid"})

    try:
        subtitle_list = await v.get_subtitle(cid=cid) or {}
        subtitles = subtitle_list.get("subtitles") or []
    except Exception as e:
        return _j({"bvid": bvid, "ok": False, "reason": "error", "error": f"取字幕列表失败：{e}"})

    if not subtitles:
        return _j({"bvid": bvid, "ok": False, "reason": "no-subtitle"})

    # 优先中文 AI 字幕，没有就第一条
    target = None
    for s in subtitles:
        if s.get("lan") in ("ai-zh", "zh-CN", "zh"):
            target = s
            break
    if not target:
        target = subtitles[0]

    sub_url = str(target.get("subtitle_url", ""))
    if sub_url.startswith("//"):
        sub_url = "https:" + sub_url
    if not sub_url:
        return _j({"bvid": bvid, "ok": False, "reason": "no-subtitle"})

    try:
        import aiohttp

        timeout = aiohttp.ClientTimeout(total=_HTTP_TIMEOUT)
        async with aiohttp.ClientSession(timeout=timeout) as sess:
            async with sess.get(_https(sub_url), headers=_image_headers()) as resp:
                if resp.status != 200:
                    raise RuntimeError(f"HTTP {resp.status}")
                sub_data = await resp.json(content_type=None)
    except Exception as e:
        return _j({"bvid": bvid, "ok": False, "reason": "error", "error": f"下载字幕失败：{e}"})

    texts = [str(item.get("content", "")) for item in (sub_data.get("body") or [])]
    if not texts:
        return _j({"bvid": bvid, "ok": False, "reason": "no-subtitle"})

    return _j({
        "bvid": bvid,
        "title": info.get("title", ""),
        "language": target.get("lan_doc", "") or target.get("lan", ""),
        "segments": len(texts),
        "text": "\n".join(texts),
    })


# ============================================================================
# Tool 3: 热评
# ============================================================================


@tool()
async def caifeng_bili_comments(bvid: str, num: int = 30) -> str:
    """
    取一个视频的热门评论

    Args:
        bvid: 视频BV号，如"BV1uNk1YxEJQ"
        num: 取几条，默认 30

    Returns:
        {bvid,count,comments:[{rpid,user,content,like,reply_count,time,top_replies?}]}
        ⚠️ 抓取失败时返回里带 `error` —— **别把带 error 的 0 条当"真没评论"**。
    """
    await _throttle()
    want = max(1, min(int(num or 30), 100))
    try:
        cred = get_cred()
        v = video.Video(bvid=bvid, credential=cred)
        aid = (await v.get_info())["aid"]
    except Exception as e:
        return _j({"bvid": bvid, "count": 0, "comments": [], "error": f"{type(e).__name__}: {e}"})

    comments = []
    page = 1
    fetch_error = None
    while len(comments) < want:
        try:
            resp = await comment.get_comments(
                oid=aid,
                type_=comment.CommentResourceType.VIDEO,
                page_index=page,
                order=comment.OrderType.LIKE,
                credential=cred,
            )
            replies = resp.get("replies") or []
            if not replies:
                break
            for r in replies:
                member = r.get("member", {}) or {}
                content = r.get("content", {}) or {}
                c = {
                    "rpid": r.get("rpid", 0),
                    "user": member.get("uname", ""),
                    "content": content.get("message", ""),
                    "like": r.get("like", 0),
                    "reply_count": r.get("rcount", 0),
                    "time": r.get("ctime", 0),
                }
                sub_replies = []
                for sub in (r.get("replies") or [])[:2]:
                    sub_replies.append({
                        "user": (sub.get("member", {}) or {}).get("uname", ""),
                        "content": (sub.get("content", {}) or {}).get("message", ""),
                        "like": sub.get("like", 0),
                    })
                if sub_replies:
                    c["top_replies"] = sub_replies
                comments.append(c)
            if len(comments) >= want:
                break
            page += 1
            await asyncio.sleep(0.5)
        except Exception as e:
            # ⚠️ 抓取失败（风控 -412 / 网络错）不能吞成「这条视频 0 条评论」：
            #    调用方必须能分辨「真没评论」和「没抓到」，否则日报静默失真。
            fetch_error = f"{type(e).__name__}: {e}"
            break

    out = {"bvid": bvid, "count": len(comments[:want]), "comments": comments[:want]}
    if fetch_error:
        out["error"] = fetch_error
    return _j(out)


# ============================================================================
# Tool 4: 画面帧（从 B站 自带故事板里裁，不解码视频）
# ============================================================================


@tool()
async def caifeng_bili_frames(bvid: str, num: int = 3, at: list | None = None) -> list:
    """
    看这个视频里的画面（从 B站 自带的故事板里裁几帧）

    想知道"它到底拍了什么"就用它。默认按时长均匀取 3 帧；
    想盯某个时刻（比如字幕里提到的那一段）就传 at（单位：秒），会取**最接近的那一块**。

    Args:
        bvid: 视频BV号，如"BV1uNk1YxEJQ"
        num: 取几帧，1-6，默认 3
        at: 指定时间点（秒）的列表；传了就以它为准，忽略 num

    Returns:
        若干张 480×270 的画面 + 一句说明（时长、实际取到的那一刻、哪几帧失败）。
        失败会写进 failed。**多P 视频的故事板通常只覆盖第 1P**，返回里会用
        covered_sec / pages 标明实际覆盖范围。图能否被看见取决于模型是否支持图片输入。
    """
    await _throttle()
    cred = load_credential()          # 故事板不登录也能取
    try:
        v = video.Video(bvid=bvid, credential=cred)
        info = await v.get_info()
    except Exception as e:
        return _text_only({"bvid": bvid, "ok": False, "error": f"取视频信息失败：{e}"})

    duration = float(info.get("duration") or 0)
    pages = info.get("pages") or []
    cid = info.get("cid") or ((pages or [{}])[0].get("cid") or 0)
    if not cid:
        return _text_only({"bvid": bvid, "ok": False, "error": "拿不到 cid"})

    # 故事板只覆盖第 1P：目标时间点按"实际覆盖的长度"算，别落到没采样的 P2 上
    covered = float(pages[0].get("duration") or duration) if pages else duration
    covered = covered or duration

    # index 会偶发返回空（实测约 25%）：先用 pvdata 兜底，两个都空才重试
    snap = {}
    entries = []
    last_err = None
    for attempt in range(2):
        try:
            snap = await v.get_video_snapshot(cid=cid, json_index=True, pvideo=False) or {}
            last_err = None
        except Exception as e:
            snap, last_err = {}, e
        entries = _snapshot_entries(snap, covered)
        if not entries:
            entries = await _entries_from_pvdata(snap)
        if entries and (snap.get("image") or []):
            break
        if attempt < 1:
            await asyncio.sleep(1.0)

    sheets = snap.get("image") or []
    if not entries or not sheets:
        err = f"（最后一次错误：{last_err}）" if last_err is not None else ""
        return _text_only({
            "bvid": bvid,
            "ok": False,
            "error": f"取不到画面快照（试了 2 次）{err}",
        })

    # 覆盖长度以**故事板实测到的那一刻**为准（比 P1 的标称时长保守，通常短 1–10%）
    story_max = max((e[0] for e in entries), default=0.0)
    if story_max > 0:
        covered = min(covered, story_max)

    # 目标时间点：传了 at 就用它；否则按"覆盖长度"均分
    if at:
        targets = [min(max(0.0, float(t)), max(0.0, covered - 0.1)) for t in at][:_FRAME_MAX]
    else:
        n = max(1, min(int(num or 3), _FRAME_MAX))
        targets = [covered * (i + 1) / (n + 1) for i in range(n)]

    picked = []
    for t in targets:
        ts, tile = min(entries, key=lambda e: abs(e[0] - t))
        picked.append((round(t, 1), round(ts, 1), tile))

    tw = int(snap.get("img_x_size") or _TILE_W_DEFAULT)
    th = int(snap.get("img_y_size") or _TILE_H_DEFAULT)
    headers = _image_headers()

    cache = {}

    async def get_sheet(no: int) -> bytes:
        if no not in cache:
            if no >= len(sheets):
                raise RuntimeError(f"拼图 {no} 不存在（共 {len(sheets)} 张）")
            cache[no] = await _fetch_bytes(str(sheets[no]), headers)
        return cache[no]

    # 每张拼图装几块要等第一张下来才知道（列数 = 宽 // 块宽）
    blocks, frames, failed = [], [], []
    cap = None
    for i, (want, got, tile) in enumerate(picked):
        try:
            if cap is None:
                first = await get_sheet(0)
                import io

                from PIL import Image

                im = Image.open(io.BytesIO(first))
                cap = max(1, (im.width // tw) * (im.height // th))
            sheet_no, pos = tile // cap, tile % cap
            raw = _crop_tile(await get_sheet(sheet_no), pos, tw, th)
            if len(raw) > _MAX_IMAGE_BYTES:
                raise RuntimeError(f"这一帧太大（{len(raw) // 1024}KB）")
            blocks.append(ImageContent(
                type="image",
                data=base64.b64encode(raw).decode("ascii"),
                mimeType="image/jpeg",
            ))
            frames.append({
                "index": i,
                "want_sec": want,
                "got_sec": got,
                "kb": round(len(raw) / 1024, 1),
            })
        except Exception as e:
            failed.append({"index": i, "want_sec": want, "got_sec": got, "reason": str(e)})

    if not blocks:
        return _text_only({
            "bvid": bvid,
            "ok": False,
            "error": "一帧都没取到",
            "failed": failed,
        })

    return [
        TextContent(type="text", text=_j({
            "bvid": bvid,
            "ok": True,
            "title": info.get("title"),
            "duration": duration,
            "covered_sec": round(covered, 1),
            "pages": max(1, len(pages)),
            "tile": f"{tw}x{th}",
            "frames": frames,
            "failed": failed,        # 空列表 = 全成
            "note": "want_sec 是想要的时刻，got_sec 是实际取到的那一块（故事板按固定间隔切）；"
                    "多P 视频只覆盖第 1P，看 covered_sec",
        })),
        *blocks,
    ]


# ============================================================================
# Tool 5: 收藏夹
# ============================================================================


@tool()
async def caifeng_bili_favorites(folder: str = "", days: int = 7) -> str:
    """
    看自己的收藏夹最近收了什么（默认最近 7 天）

    Args:
        folder: 只看某个收藏夹（标题包含即可，也可以直接给 id）；留空 = 看全部
        days: 只看最近几天收的，默认 7

    Returns:
        {folders:[{id,title,count}], items:[{bvid,title,author,faved_at,folder}]}
    """
    await _throttle()
    try:
        cred = get_cred()
    except Exception as e:
        return _j({"folders": [], "items": [], "error": str(e)})

    uid = _my_uid(cred)
    if not uid:
        return _j({
            "folders": [],
            "items": [],
            "error": "凭证里没有 dedeuserid，取不到自己的收藏夹（让使用者在设置页重新扫码登录）",
        })

    try:
        res = await favorite_list.get_video_favorite_list(uid=uid, credential=cred)
    except Exception as e:
        return _j({"folders": [], "items": [], "error": f"取收藏夹列表失败：{type(e).__name__}: {e}"})

    folders = []
    for it in (res.get("list") or []):
        folders.append({
            "id": it.get("id", 0),
            "title": it.get("title", ""),
            "count": it.get("media_count", 0),
        })

    want = str(folder or "").strip()
    chosen = folders
    if want:
        chosen = [
            f for f in folders
            if want == str(f.get("id")) or want in str(f.get("title") or "")
        ]
        if not chosen:
            return _j({"folders": folders, "items": [], "error": f"没找到收藏夹「{want}」"})

    span = max(1, min(int(days or 7), 365))
    cutoff_ts = (_dt.datetime.now() - _dt.timedelta(days=span)).timestamp()

    items = []
    err = None
    for f in chosen:
        for page in range(1, 4):
            try:
                cont = await favorite_list.get_video_favorite_list_content(
                    media_id=f["id"], page=page, credential=cred
                )
            except Exception as e:
                err = f"{type(e).__name__}: {e}"
                break
            medias = cont.get("medias") or []
            if not medias:
                break
            oldest = None
            for m in medias:
                ts = m.get("fav_time") or 0
                try:
                    ts = int(ts)
                except (TypeError, ValueError):
                    ts = 0
                if ts:
                    oldest = ts if oldest is None else min(oldest, ts)
                if ts and ts < cutoff_ts:
                    continue          # 太老的不算
                faved_at = ""
                if ts:
                    try:
                        faved_at = _dt.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")
                    except Exception:
                        faved_at = ""
                items.append({
                    "bvid": m.get("bvid", ""),
                    "title": m.get("title", ""),
                    "author": (m.get("upper") or {}).get("name", ""),
                    "faved_at": faved_at,
                    "folder": f.get("title", ""),
                })
            if not cont.get("has_more"):
                break
            if oldest is not None and oldest < cutoff_ts:
                break             # 按时间倒序，翻到界外就不用再翻
            if len(items) >= 60:
                break
            await asyncio.sleep(0.5)
        if len(items) >= 60:
            break

    out = {"folders": folders, "items": items[:60]}
    if err:
        out["error"] = err
    return _j(out)


# ============================================================================
# Tool 6: 发评论（带语感闸门）
# ============================================================================


@tool()
async def caifeng_bili_reply(bvid: str, text: str, rpid: int = 0, root: int = 0) -> str:
    """
    在视频下发一条评论，或回复某条评论

    Args:
        bvid: 视频BV号
        text: 评论正文
        rpid: 要回复的目标评论 id（0 = 发新评论）
        root: 楼层根评论 id（回复一级评论不用填，回复楼中楼时填根评论 id）

    Returns:
        成功：{success:true, rpid?, rpid_str?, root?, parent?}
        被语感闸门拦下：{ok:false, sent:false, blocked_by:"style", error:"原因+改法"}
        异常：{success:false, error}
    """
    deny = _guard("caifeng_bili_reply")
    if deny:
        return _j({"ok": False, "sent": False, "error": deny})

    try:
        cred = get_cred()
    except Exception as e:
        return _j({"success": False, "error": str(e)})

    # ⭐ 语感闸门：撞八股 / 撞自己以前的 / 撞这条视频的热评 ⇒ 不发，把改法告诉模型
    style = await _style_reason(text, bvid, cred)
    if style:
        return _j({"ok": False, "sent": False, "blocked_by": "style", "error": style})

    try:
        v = video.Video(bvid=bvid, credential=cred)
        info = await v.get_info()
        aid = info["aid"]

        if int(rpid or 0) == 0:
            result = await comment.send_comment(
                text=text,
                oid=aid,
                type_=comment.CommentResourceType.VIDEO,
                credential=cred,
            )
        else:
            # root=0 表示回复一级评论（root=rpid）；root!=0 表示回复楼中楼
            actual_root = int(root) if int(root or 0) != 0 else int(rpid)
            result = await comment.send_comment(
                text=text,
                oid=aid,
                type_=comment.CommentResourceType.VIDEO,
                root=actual_root,
                parent=int(rpid),
                credential=cred,
            )

        rpid_sent = result.get("rpid") if isinstance(result, dict) else None
        _ledger_append(text, bvid, rpid_sent)

        out = {"success": True, "message": "评论发送成功"}
        if isinstance(result, dict):
            for key in ("rpid", "rpid_str", "root", "parent"):
                val = result.get(key)
                if isinstance(val, (int, str)) and str(val).strip() and str(val) != "0":
                    out[key] = val
        return _j(out)
    except Exception as e:
        return _j({"success": False, "error": str(e)})


# ============================================================================
# Tool 7: 私信（list / read / reply）
# ============================================================================

_DM_TEXT = 1
_DM_PICTURE = 2
_DM_WITHDRAW = 5
_DM_GROUPS_PICTURE = 6
_DM_SHARE_VIDEO = 7
_DM_NOTICE = 10
_DM_PUSHED_VIDEO = 11

# 会话列表里没有昵称，要另查；一轮里同一个人别查两遍
_DM_NAME_CACHE = {}


def _dm_text(msg_type, content) -> str:
    """把一条消息的 content（JSON 字符串）摊平成一行字。"""
    raw = content
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", "replace")
    data = None
    if isinstance(raw, str):
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            data = None
    elif isinstance(raw, dict):
        data = raw

    mt = msg_type
    try:
        mt = int(msg_type)
    except (TypeError, ValueError):
        pass

    if mt == _DM_TEXT:
        if isinstance(data, dict):
            return str(data.get("content") or "")
        return str(raw or "")
    if mt in (_DM_PICTURE, _DM_GROUPS_PICTURE):
        return "[图片]"
    if mt == _DM_WITHDRAW:
        return "[撤回了一条消息]"
    if mt in (_DM_SHARE_VIDEO, _DM_PUSHED_VIDEO):
        bv = (data or {}).get("bvid") if isinstance(data, dict) else ""
        return f"[视频] {bv}".strip()
    if mt == _DM_NOTICE:
        if isinstance(data, dict):
            return " ".join(str(data.get(k) or "") for k in ("title", "text")).strip()
        return "[通知]"
    if isinstance(data, dict):
        return str(data.get("content") or data.get("url") or "")
    return str(raw or "")


def _ts_str(ts) -> str:
    try:
        ts = int(ts or 0)
    except (TypeError, ValueError):
        return ""
    if not ts:
        return ""
    return _dt.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


async def _dm_name(uid: int, cred) -> str:
    if uid <= 0:
        return ""
    if uid in _DM_NAME_CACHE:
        return _DM_NAME_CACHE[uid]
    try:
        u = bili_user.User(uid, credential=cred)
        info = await u.get_user_info() or {}
        name = str(info.get("name") or "")
    except Exception:
        name = ""
    if name:
        _DM_NAME_CACHE[uid] = name
    return name


async def _dm_list(cred) -> dict:
    try:
        res = await session.get_sessions(credential=cred, session_type=1)   # 1 = 私聊
    except Exception as e:
        return {"conversations": [], "error": f"{type(e).__name__}: {e}"}

    convs = []
    lookups = 0
    for it in (res.get("session_list") or []):
        try:
            uid = int(it.get("talker_id") or 0)
        except (TypeError, ValueError):
            uid = 0
        if uid <= 0:
            continue
        last = it.get("last_msg") or {}
        name = ""
        if lookups < 12:          # 查昵称是有代价的：一轮最多查 12 个，剩下的给空
            name = await _dm_name(uid, cred)
            lookups += 1
        convs.append({
            "uid": uid,
            "name": name,
            "last_msg": _dm_text(last.get("msg_type"), last.get("content")),
            "time": _ts_str(last.get("timestamp") or it.get("session_ts")),
            "unread": it.get("unread_count", 0),
        })
    return {"conversations": convs}


async def _dm_read(uid: int, cred) -> dict:
    try:
        res = await session.fetch_session_msgs(talker_id=uid, credential=cred, session_type=1)
    except Exception as e:
        return {"uid": uid, "messages": [], "error": f"{type(e).__name__}: {e}"}

    self_uid = _my_uid(cred)
    if not self_uid:
        try:
            info = await bili_user.get_self_info(cred) or {}
            self_uid = int(info.get("mid") or 0)
        except Exception:
            self_uid = 0

    msgs = []
    for m in reversed(res.get("messages") or []):     # 接口是倒序给的，翻回来
        sender = m.get("sender_uid")
        try:
            sender = int(sender or 0)
        except (TypeError, ValueError):
            sender = 0
        msgs.append({
            "time": _ts_str(m.get("timestamp")),
            "from_me": bool(self_uid and sender == self_uid),
            "text": _dm_text(m.get("msg_type"), m.get("content")),
        })
    return {"uid": uid, "messages": msgs}


async def _dm_reply(uid: int, text: str, cred) -> dict:
    body = str(text or "").strip()
    if not body:
        return {"ok": False, "error": "text 是空的"}
    try:
        res = await session.send_msg(
            credential=cred,
            receiver_id=uid,
            msg_type=session.EventType.TEXT,
            content=body,
        )
    except Exception as e:
        # 超长（>500 字符）时接口回 code 21007 —— 如实带回去，别自己编个原因
        code = getattr(e, "code", None)
        out = {"ok": False, "error": str(e)}
        if code is not None:
            out["code"] = code
        return out

    data = res if isinstance(res, dict) else {}
    code = data.get("code", 0)
    inner = data.get("data")
    msg_key = data.get("msg_key") or (inner.get("msg_key") if isinstance(inner, dict) else None)

    if code not in (0, None):
        return {
            "ok": False,
            "code": code,
            "error": f"接口拒绝（code={code}）：{data.get('message') or data.get('msg') or '未知原因'}",
        }
    if not msg_key:
        # 接口回成功但没有投递回执 ⇒ 可能没真送到（对方不收陌生人私信 / 被风控）
        return {"ok": False, "code": code, "error": "接口回了成功，但没有投递回执（msg_key）"}
    return {"ok": True, "code": 0, "msg_key": str(msg_key)[:24]}


@tool()
async def caifeng_bili_dm(action: str, uid: int = 0, text: str = "") -> str:
    """
    看 B站 私信，或在授权下回一条

    Args:
        action: list = 会话列表；read = 某个会话的消息；reply = 回一条
        uid: 会话对方的 UID（read / reply 必填）
        text: 回复正文（reply 必填；超过 500 字符接口会回 code 21007）

    Returns:
        list  → {conversations:[{uid,name,last_msg,time,unread}]}
        read  → {uid, messages:[{time,from_me,text}]}
        reply → {ok, code?, error?}
    """
    act = str(action or "").strip().lower()

    if act == "list":
        await _throttle()
        try:
            cred = get_cred()
        except Exception as e:
            return _j({"conversations": [], "error": str(e)})
        return _j(await _dm_list(cred))

    if act == "read":
        await _throttle()
        target = int(uid or 0)
        if target <= 0:
            return _j({"uid": 0, "messages": [], "error": "read 需要 uid"})
        try:
            cred = get_cred()
        except Exception as e:
            return _j({"uid": target, "messages": [], "error": str(e)})
        return _j(await _dm_read(target, cred))

    if act == "reply":
        # ⭐ 会往 B站 写东西 ⇒ 入口再过一道闸
        deny = _guard("caifeng_bili_dm")
        if deny:
            return _j({"ok": False, "error": deny})
        target = int(uid or 0)
        if target <= 0:
            return _j({"ok": False, "error": "reply 需要 uid"})
        try:
            cred = get_cred()
        except Exception as e:
            return _j({"ok": False, "error": str(e)})
        return _j(await _dm_reply(target, text, cred))

    return _j({"ok": False, "error": f"action 只能是 list / read / reply，收到的是「{action}」"})


# ============================================================================
# Tool 8: 写日报（同一天按 id 合并，不覆盖）
# ============================================================================
#
# 一天只有一份 `<家目录>/out/<日期>.md`。同一轮里重复写、或者同一天再跑一轮，
# 都要**按 id 合并**：同 id 整条替换，不同 id 追加。
# 小节顺序固定：今天挑的（无标题，紧跟 `# 日期`）→ 扫过没收的 → 因缺证据跳过
#               → 私信 → 判重 → 总结。

_TIERS = ("值得看", "可以看", "不值当")
_ID_RE = re.compile(r"(BV[0-9A-Za-z]{10}|\b\d{15,25}\b)")
_REPORT_SECTIONS = ("扫过没收的", "因缺证据跳过", "私信", "判重", "总结")


def _src_tag(source) -> str:
    s = str(source or "").strip().lower()
    if s in ("douyin", "抖音", "dy"):
        return "[抖音]"
    return "[B站]"


def _id_in(line: str) -> str:
    m = _ID_RE.search(str(line or ""))
    return m.group(1) if m else ""


def _parse_report(text: str):
    """拆成 (日期, 前言行, [节标题按出现顺序], {节标题: 行列表})"""
    day = ""
    preamble = []
    sections = {}
    order = []
    cur = None
    for line in (text or "").split("\n"):
        if not day and line.startswith("# "):
            day = line[2:].strip()
            continue
        m = re.match(r"^##\s+(.+?)\s*$", line)
        if m:
            cur = m.group(1).strip()
            if cur not in sections:
                sections[cur] = []
                order.append(cur)
            continue
        if cur is None:
            preamble.append(line)
        else:
            sections[cur].append(line)
    return day, preamble, order, sections


def _entry_blocks(lines: list):
    """前言里的行 → (散行, [(标题行, [正文行])])"""
    loose, blocks = [], []
    head, buf = None, []
    for line in lines:
        if line.startswith("### "):
            if head is not None:
                blocks.append((head, buf))
            head, buf = line, []
            continue
        if head is None:
            loose.append(line)
        else:
            buf.append(line)
    if head is not None:
        blocks.append((head, buf))
    return loose, blocks


def _render_entry(e: dict) -> tuple:
    tag = _src_tag(e.get("source"))
    vid = str(e.get("id") or "").strip()
    title = " ".join(str(e.get("title") or "").split()) or vid
    head = f"### {tag} {vid} / {title}"
    body = [""]
    verdict = str(e.get("verdict") or "").strip()
    if verdict:
        body.append(f"**档位**：{verdict}")
    why = str(e.get("why") or "").strip()
    if why:
        body.append(f"**为什么值得**：{why}")
    cmt = str(e.get("comment") or "").strip()
    if cmt:
        body.append(f"**我的一句话**：{cmt}")
    return head, body


def _render_skip(item: dict, titles: dict) -> str:
    tag = _src_tag(item.get("source"))
    vid = str(item.get("id") or "").strip()
    title = " ".join(str(item.get("title") or "").split())
    if not title:
        title = titles.get(vid, "")
    reason = " ".join(str(item.get("reason") or "").split())
    head = f"{tag} {vid} / {title}" if title else f"{tag} {vid}"
    return f"- {head}：{reason}" if reason else f"- {head}"


def _load_json_arg(raw, name: str):
    """MCP 参数只能给字符串 ⇒ 这里 json.loads。空串当"没给"。"""
    s = str(raw or "").strip()
    if not s:
        return None, ""
    try:
        return json.loads(s), ""
    except (ValueError, TypeError) as e:
        return None, f"{name} 不是合法 JSON（{type(e).__name__}: {e}）。形状见工具说明。"


@tool()
def caifeng_report_write(date: str = "", entries: str = "", skipped: str = "", note: str = "") -> str:
    """
    把条目写进今天的日报（按 id 合并，不覆盖）

    Args:
        date: 日期 YYYY-MM-DD，留空 = 今天
        entries: JSON **字符串**，形如
                 [{"source":"bili","id":"BV1xx411c7mD","title":"…","verdict":"值得看",
                   "why":"…","comment":"…","detail":"可选，写长了会另存成单片笔记"}]
        skipped: JSON **字符串**，形如 [{"source":"bili","id":"BV…","reason":"…"}]
        note: 一两句总结（非空就进「总结」节）

    Returns:
        {ok, path, added:[id], replaced:[id], notes:[单片笔记路径]}
        （added / replaced 只数「挑的」那部分条目；skipped 一起合并但不进这两个数组）
    """
    day = _norm_date(date)
    new_entries, e1 = _load_json_arg(entries, "entries")
    if e1:
        return _j({"ok": False, "error": e1})
    new_skipped, e2 = _load_json_arg(skipped, "skipped")
    if e2:
        return _j({"ok": False, "error": e2})
    if new_entries is not None and not isinstance(new_entries, list):
        return _j({"ok": False, "error": "entries 必须是 JSON 数组"})
    if new_skipped is not None and not isinstance(new_skipped, list):
        return _j({"ok": False, "error": "skipped 必须是 JSON 数组"})

    path = OUT_DIR / f"{day}.md"
    existing = _read_text(path)
    _, preamble, order, sections = _parse_report(existing)

    loose, prev_blocks = _entry_blocks(preamble)
    picks = {}          # key(id 或标题行) -> (标题行, 正文行)
    titles = {}

    def _harvest(head: str, body: list):
        """把一条 `### ` 条目收进索引（同 id 后来者覆盖早先的）。"""
        vid = _id_in(head)
        key = f"id:{vid}" if vid else f"raw:{head}"
        picks.pop(key, None)               # 覆盖时挪到末尾，位置跟着最新那次
        picks[key] = (head, body)
        if vid:
            m = re.search(r"/\s*(.+)$", head)
            if m:
                titles[vid] = m.group(1).strip()

    for head, body in prev_blocks:
        _harvest(head, body)

    # ⚠️ 条目可能被模型塞进了别的小节（`## 私信` 下面挂一条 `### [B站] …`）：
    #    那种也得收进索引、从原小节里摘走，否则写完会出现同一条的两份。
    for title in list(sections.keys()):
        loose_s, blocks_s = _entry_blocks(sections[title])
        if not blocks_s:
            continue
        sections[title] = loose_s
        for head, body in blocks_s:
            _harvest(head, body)

    # 已有的「扫过没收的」按 id（或整行）建索引，好同 id 替换
    skip_lines = list(sections.get("扫过没收的") or [])
    prev_skips = {}
    for line in skip_lines:
        s = line.strip()
        if not s.startswith("- "):
            continue
        vid = _id_in(s)
        prev_skips[f"id:{vid}" if vid else f"raw:{s}"] = s

    added, replaced, notes = [], [], []

    for item in (new_entries or []):
        if not isinstance(item, dict):
            continue
        vid = str(item.get("id") or "").strip()
        head, body = _render_entry(item)
        key = f"id:{vid}" if vid else f"raw:{head}"
        if key in picks:
            picks[key] = (head, body)
            if vid:
                titles[vid] = " ".join(str(item.get("title") or "").split())
                if vid not in replaced:
                    replaced.append(vid)
        else:
            picks[key] = (head, body)
            if vid:
                titles[vid] = " ".join(str(item.get("title") or "").split())
                if vid not in added:
                    added.append(vid)

        detail = str(item.get("detail") or "").strip()
        if vid and detail:
            ttl = " ".join(str(item.get("title") or "").split()) or vid
            note_path = REPORTS_DIR / f"{vid}.md"
            _write_text(note_path, f"# {vid} {ttl}\n\n{detail}\n")
            notes.append(str(note_path))

    for item in (new_skipped or []):
        if not isinstance(item, dict):
            continue
        vid = str(item.get("id") or "").strip()
        line = _render_skip(item, titles)
        key = f"id:{vid}" if vid else f"raw:{line}"
        prev_skips[key] = line

    summary_lines = [l for l in (sections.get("总结") or []) if l.strip()]
    note_body = " ".join(str(note or "").split())
    if note_body:
        summary_lines.append(note_body)

    # ── 渲染（顺序固定）────────────────────────────────────────────────────
    out = [f"# {day}", ""]
    for line in loose:
        if line.strip():
            out.append(line)
    if any(l.strip() for l in loose):
        out.append("")

    for head, body in picks.values():
        out.append(head)
        out.extend(body)
        out.append("")

    def _emit(title: str, lines: list):
        kept = [l for l in lines if str(l).strip()]
        if not kept:
            return
        out.append(f"## {title}")
        out.append("")
        out.extend(kept)
        out.append("")

    _emit("扫过没收的", list(prev_skips.values()))
    _emit("因缺证据跳过", [l for l in (sections.get("因缺证据跳过") or []) if l.strip()])
    _emit("私信", [l for l in (sections.get("私信") or []) if l.strip()])
    _emit("判重", [l for l in (sections.get("判重") or []) if l.strip()])
    _emit("总结", summary_lines)

    for title in order:                     # 认不出的节原样留在末尾，不丢
        if title in _REPORT_SECTIONS:
            continue
        _emit(title, [l for l in (sections.get(title) or []) if str(l).strip()])

    text = "\n".join(out)
    text = re.sub(r"\n{3,}", "\n\n", text).strip("\n")
    written = _write_text(path, text + "\n")

    return _j({
        "ok": True,
        "path": written,
        "added": added,
        "replaced": replaced,
        "notes": notes,
    })


# ============================================================================
# Tool 9: 判重表
# ============================================================================
#
#   # 见闻录
#
#   ## B站
#
#   | 日期 | id | 标题 | UP | 状态 |
#   | ---- | -- | ---- | -- | ---- |
#   | 2026-11-02 | BV1xx411c7mD | 标题 | UP名 | 收 |
#
#   ## 抖音
#   ...
#
# ⚠️ 解析**不认列位**：人可能手改表格、模型可能把列写反 ⇒ 一律扫一遍找 id 落在哪一格。

_SEEN_TABLE_HEAD = [
    "| 日期 | id | 标题 | UP | 状态 |",
    "| ---- | -- | ---- | -- | ---- |",
]
_BV_RE = re.compile(r"^BV[0-9A-Za-z]{10}$")
_DY_RE = re.compile(r"^\d{15,25}$")


def _seen_empty() -> str:
    return "\n".join([
        "# 见闻录",
        "",
        "## B站",
        "",
        *_SEEN_TABLE_HEAD,
        "",
        "## 抖音",
        "",
        *_SEEN_TABLE_HEAD,
        "",
    ])


def _sec_title(section: str) -> str:
    return "抖音" if section == "douyin" else "B站"


def _split_cells(line: str) -> list:
    body = str(line).strip()
    if body.startswith("|"):
        body = body[1:]
    if body.endswith("|"):
        body = body[:-1]
    cells, cur, i = [], "", 0
    while i < len(body):
        ch = body[i]
        if ch == "\\" and i + 1 < len(body) and body[i + 1] == "|":
            cur += "|"
            i += 2
            continue
        if ch == "|":
            cells.append(cur)
            cur = ""
            i += 1
            continue
        cur += ch
        i += 1
    cells.append(cur)
    return [c.strip() for c in cells]


def _row_of(line: str):
    """一行表格 → {section, id, day, status, title, up}；认不出 id 返回 None"""
    cells = _split_cells(line)
    id_index = -1
    section = ""
    for i, c in enumerate(cells):
        if _BV_RE.match(c):
            id_index, section = i, "bili"
            break
        if _DY_RE.match(c):
            id_index, section = i, "douyin"
            break
    if id_index < 0:
        return None

    day_index = -1
    day = ""
    for i, c in enumerate(cells):        # 先看 id 左边，再看右边
        d = _seen_day(c)
        if d:
            day_index, day = i, d
            break

    status_index = -1
    status = ""
    for i in range(len(cells) - 1, -1, -1):
        if cells[i] in ("收", "弃"):
            status_index, status = i, cells[i]
            break

    used = {id_index, day_index, status_index}
    rest = [c for i, c in enumerate(cells) if i not in used]
    return {
        "section": section,
        "id": cells[id_index],
        "day": day,
        "status": status,
        "title": rest[0] if rest else "",
        "up": rest[1] if len(rest) > 1 else "",
    }


def _parse_seen_rows(text: str) -> list:
    rows = []
    for line in (text or "").split("\n"):
        s = line.strip()
        if not s.startswith("|"):
            continue
        if re.match(r"^\|[\s:|-]+\|?$", s):
            continue
        row = _row_of(s)
        if row:
            rows.append(row)
    return rows


def _format_seen_row(day: str, vid: str, title: str, up: str, status: str) -> str:
    return f"| {_cell(day, 10)} | {_cell(vid, 24)} | {_cell(title, 60)} | {_cell(up, 30)} | {_cell(status, 4)} |"


def _section_range(lines: list, section: str):
    """返回 (节标题行号, 节结束行号)；没有这一节返回 (None, None)"""
    head = None
    for i, line in enumerate(lines):
        m = re.match(r"^##\s+(.+?)\s*$", line)
        if not m:
            continue
        t = m.group(1)
        sec = "douyin" if "抖音" in t else ("bili" if "B站" in t else "")
        if head is None:
            if sec == section:
                head = i
            continue
        return head, i
    return (head, len(lines)) if head is not None else (None, None)


def _mark_row(lines: list, section: str, vid: str, new_line: str, day: str) -> str:
    """把一行写进对应小节：同日同 id 已存在就替换那一行，否则追加。返回 added/replaced。"""
    head, end = _section_range(lines, section)
    if head is None:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append(f"## {_sec_title(section)}")
        lines.append("")
        lines.extend(_SEEN_TABLE_HEAD)
        lines.append(new_line)
        return "added"

    for i in range(head + 1, end):
        if not lines[i].strip().startswith("|"):
            continue
        row = _row_of(lines[i])
        if not row or row["id"] != vid:
            continue
        if row["day"] == day:
            # 同一天同一条：整行替换（状态可以从「弃」升级成「收」）
            lines[i] = new_line
            return "replaced"

    last = None
    for i in range(head + 1, end):
        if lines[i].strip().startswith("|"):
            last = i
    if last is None:
        lines[head + 1:head + 1] = ["", *_SEEN_TABLE_HEAD, new_line]
        return "added"
    lines.insert(last + 1, new_line)
    return "added"


@tool()
def caifeng_seen(check: str = "", mark: str = "") -> str:
    """
    查判重表 / 往判重表里记一条

    Args:
        check: JSON **字符串** 数组，如 ["BV1xx411c7mD"]；返回哪些见过、哪些没记录过
        mark: JSON **字符串** 数组，如
              [{"source":"bili","id":"BV1xx411c7mD","title":"…","up":"…","verdict":"收"}]
              verdict 只认「收」/「弃」（其它值当「弃」）；同日同 id 已存在就替换那一行

    Returns:
        只 check → {seen:[…], unknown:[…]}
        有 mark → {ok:true, seen:[…], marked:n, total:总行数}
        两个都给 → 先查后写，{ok, seen（查到的）, unknown, marked, total}
    """
    ids, e1 = _load_json_arg(check, "check")
    if e1:
        return _j({"ok": False, "error": e1})
    marks, e2 = _load_json_arg(mark, "mark")
    if e2:
        return _j({"ok": False, "error": e2})
    if ids is not None and not isinstance(ids, list):
        return _j({"ok": False, "error": "check 必须是 JSON 数组"})
    if marks is not None and not isinstance(marks, list):
        return _j({"ok": False, "error": "mark 必须是 JSON 数组"})

    raw = _read_text(SEEN_FILE)
    if not raw.strip():
        raw = _seen_empty()
    lines = raw.split("\n")
    while lines and lines[-1] == "":
        lines.pop()

    known = {r["id"] for r in _parse_seen_rows("\n".join(lines))}

    hits, unknown = [], []
    for x in (ids or []):
        vid = str(x or "").strip()
        if not vid:
            continue
        if vid in known:
            hits.append(vid)
        else:
            unknown.append(vid)

    if marks is None:
        return _j({"seen": hits, "unknown": unknown})

    day = _today()
    marked_ids, marked = [], 0
    for item in marks:
        if not isinstance(item, dict):
            continue
        vid = str(item.get("id") or "").strip()
        if not vid:
            continue
        src = str(item.get("source") or "").strip().lower()
        section = "douyin" if src in ("douyin", "抖音", "dy") else ("bili" if src in ("bili", "b站") else "")
        if not section:
            section = "bili" if _BV_RE.match(vid) else ("douyin" if _DY_RE.match(vid) else "bili")
        status = str(item.get("verdict") or "").strip()
        if status not in ("收", "弃"):
            status = "弃"
        new_line = _format_seen_row(
            day, vid, str(item.get("title") or ""), str(item.get("up") or ""), status
        )
        _mark_row(lines, section, vid, new_line, day)
        marked += 1
        if vid not in marked_ids:
            marked_ids.append(vid)

    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text).strip("\n")
    written = _write_text(SEEN_FILE, text + "\n")
    total = len(_parse_seen_rows(_read_text(SEEN_FILE)))

    out = {
        "ok": True,
        "seen": hits,
        "marked": marked,
        "total": total,
        "path": written,
    }
    if ids is not None:
        out["unknown"] = unknown
    else:
        out["seen"] = marked_ids
    return _j(out)


# ============================================================================
# 启动（stdio）
# ============================================================================

if __name__ == "__main__":
    mcp.run()
