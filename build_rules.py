#!/usr/bin/env python3
"""記者ガイド（munakata-desk/guide/）の表と overrides.tsv・rules_extra.tsv から
rules.json・表記ルール.md・index.html を作る。

使い方: python3 build_rules.py        （ガイドを更新したら実行して push する）
        python3 build_rules.py --list （判定に迷った行の一覧も出す）
"""
import csv
import json
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
GUIDE = HERE.parent / "munakata-desk" / "guide"
sys.path.insert(0, str(GUIDE))
import build_guide as bg  # noqa: E402

# 読む表（キー＝ファイル名:1列目の見出し）。これ以外の表は読まない
FIX_TABLES = {
    "90_appendix.md:誤",
    "ch05_names.md:Before",
    "ch08_notation.md:漢字（NG）",
    "ch08_notation.md:ひらがな・別表記（NG）",
    "ch08_notation.md:使わない（NG）",
    "ch08_notation.md:誤り",
    "ch08_notation.md:NG 文字",
    "ch08_notation.md:登録商標（NG）",
}
CHECK_TABLES = {
    "ch06_numbers.md:書かない",
    "ch07_expression.md:NG（受動態）",
    "ch07_expression.md:本部が置き換えた語",
    "ch07_expression.md:NG",
    "ch07_expression.md:NG（地の文）",
    "ch07_expression.md:NG ワード",
    "ch07_expression.md:元の表現",
    "ch08_notation.md:表記",
}
# 2列目が「直した後」の列か（ラベルを「NG→OK」にする）
OK_COL_RE = re.compile(r"OK|置き換え|^正|After|使う|言い換え|一般名|正しい")
HIRA = "ぁ-ゖ"
KANA_ONLY_RE = re.compile(r"^[ぁ-ゖァ-ヺー]+$")
PAREN_RE = re.compile(r"（[^（）]*）")
JS_SPECIAL = re.compile(r"([\\^$.*+?()\[\]{}|/])")

# engine.js に組み込みの形の点検（rules.json には説明だけを載せる）
BUILTIN = [
    dict(builtin="title_len", kind="form", level=1, area="title",
         label="タイトルは35字以内", why="36字目から先を削る。タイトルは35字以内に収める",
         ch=3, sec="3-1 タイトルの基本", r="", stat="TOP20 #13", n=0),
    dict(builtin="title_space", kind="check", level=1, area="title",
         label="タイトルの地域名の後のスペース", why="タイトルは「地域名＋全角スペース」で始める（例：宗像の…→宗像　…）",
         ch=3, sec="3-1 タイトルの基本", r="", stat="", n=0),
    dict(builtin="lead_len", kind="form", level=1, area="lead",
         label="リードは90字以内", why="91字目から先を削る。リードは90字以内",
         ch=4, sec="4-2 リードの字数", r="", stat="", n=0),
    dict(builtin="body_len", kind="form", level=1, area="text",
         label="リード＋本文は600〜1000字が目安", why="空白を除いた字数。目安から外れたら長さを見直す",
         ch=1, sec="1-2 入稿仕様", r="", stat="", n=0),
    dict(builtin="indent", kind="form", level=1, area="text",
         label="段落の先頭は全角スペース1文字", why="リード・本文の各段落は全角スペース1文字で始める（半角・タブ・2文字以上は直す）",
         ch=1, sec="1-2 入稿仕様", r="", stat="TOP20 #0", n=0),
    dict(builtin="blank_space", kind="form", level=2, area="all",
         label="段落の間の空行に空白を入れない", why="空行は何も入れずに改行だけにする（全角スペースだけの行は消す）",
         ch=1, sec="1-2 記事の構成要素と入稿仕様", r="", stat="", n=0),
    dict(builtin="nested_quote", kind="fix", level=1, area="all",
         label="「」の中の「」は『』", why="かぎかっこの中でさらに引用するときは二重かぎかっこにする",
         ch=8, sec="8-5 その他の表記ルール", r="", stat="本部修正13本", n=13),
]

warnings = []


def warn(msg):
    warnings.append(msg)


def js_escape(s):
    return JS_SPECIAL.sub(r"\\\1", s)


def read_tsv(path, ncol):
    rows = []
    with open(path, encoding="utf-8", newline="") as fp:
        for i, row in enumerate(csv.reader(fp, delimiter="\t", quoting=csv.QUOTE_NONE)):
            if i == 0:
                continue
            if not any(c.strip() for c in row):
                continue
            row = row + [""] * (ncol - len(row))
            rows.append(row[:ncol])
    return rows


def first_tag(s, marked_only):
    for m in bg.TAG_RE.finditer(s):
        if m.group(2) or not marked_only:
            return f"R{m.group(1)}"
    return ""


def iter_tables():
    """読む表を、節・小見出し・R とともに返す。"""
    for fname in bg.ORDER:
        lines = (GUIDE / fname).read_text(encoding="utf-8").split("\n")
        sec = sub = r_sec = r_sub = ""
        i = 0
        while i < len(lines):
            line = lines[i]
            hm = re.match(r"^(#{3,4})\s+(.*)", line)
            if hm:
                if len(hm.group(1)) == 3:
                    sec, sub, r_sec, r_sub = bg.strip_md(hm.group(2)), "", first_tag(line, True), ""
                else:
                    sub, r_sub = bg.strip_md(hm.group(2)), first_tag(line, True)
                i += 1
                continue
            is_table = (line.strip().startswith("|") and i + 1 < len(lines)
                        and re.match(r"^\s*\|[\s:\-|]+\|\s*$", lines[i + 1]))
            if not is_table:
                tag = first_tag(line, True)
                if tag:
                    if sub and not r_sub:
                        r_sub = tag
                    elif not sub and not r_sec:
                        r_sec = tag
                i += 1
                continue
            hdr = [c.strip() for c in line.strip().strip("|").split("|")]
            key = f"{fname}:{hdr[0]}"
            j = i + 2
            rows = []
            while j < len(lines) and lines[j].strip().startswith("|"):
                rows.append([c.strip() for c in lines[j].strip().strip("|").split("|")])
                j += 1
            if key in FIX_TABLES or key in CHECK_TABLES:
                yield dict(file=fname, key=key, hdr=hdr, sec=sec, sub=sub,
                           r=r_sub or r_sec, rows=rows, line=i + 1)
            i = j


def get_stat(cells, hdr):
    """行のセルから本部に直された回数を拾う。(表示用の文字列, 並べ替え用の数)"""
    t = " ".join(cells)
    out, n = [], 0
    for m in re.finditer(r"本部修正(\d+)本", t):
        out.append(m.group(0))
        n = max(n, int(m.group(1)))
    for m in re.finditer(r"本部添削(?:「[^」]*」|で[^\d、。）]*)?(\d+)件", t):
        out.append(f"本部添削{m.group(1)}件")
        n = max(n, int(m.group(1)))
    for m in re.finditer(r"(\d+)本・(\d+(?:\.\d+)?)%", t):
        out.append(m.group(0))
        n = max(n, int(m.group(1)))
    for k, h in enumerate(hdr):
        if h == "件数" and k < len(cells):
            v = cells[k].strip()
            nums = [int(x) for x in re.findall(r"\d+", v)]
            if nums:
                out.append("本部の置き換え" + "／".join(f"{x}件" for x in nums))
                n = max(n, max(nums))
            elif v:
                out.append("本部が毎回置き換える")
                n = max(n, 20)
    return "、".join(dict.fromkeys(out)), n


HQ_QUOTE_RE = re.compile(r"本部(?:コメント)?(?:「[^」]*」)+")
DATE_RE = re.compile(r"（\d{4}-\d{2}[^（）]*）|\d{4}-\d{2}(?:[・、]\d+本)?")


def clean_why(s):
    """理由の文から本部の言葉（引用）と日付を消す。"""
    s = bg.strip_md(s)
    had_quote = bool(HQ_QUOTE_RE.search(s))
    s = HQ_QUOTE_RE.sub("", s)
    if had_quote:
        s = DATE_RE.sub("", s)
    for _ in range(3):
        s = re.sub(r"（\s*[、。・]?\s*）", "", s)
        s = re.sub(r"（[、。・]\s*", "（", s)
        s = re.sub(r"\s*[、。・]）", "）", s)
        s = re.sub(r"([、。])\s*[、。]", r"\1", s)
        s = re.sub(r"^[、。・\s]+", "", s)
        s = re.sub(r"[、・\s]+$", "", s)
    s = re.sub(r"\s{2,}", " ", s).strip()
    return s


STAT_TEXT_RE = re.compile(r"本部修正\d+本|本部添削(?:「[^」]*」|で[^\d、。）]*)?\d+件(?:など)?|\d+本・\d+(?:\.\d+)?%")


def strip_stat(s):
    """回数は stat に別に出すので、理由・ラベルからは外す。"""
    s = STAT_TEXT_RE.sub("", s)
    for _ in range(3):
        s = re.sub(r"（\s*[、。・]?\s*）", "", s)
        s = re.sub(r"[、。]\s*）", "）", s)
        s = re.sub(r"（\s*[、。]", "（", s)
        s = re.sub(r"^[、。・\s]+|[、・\s]+$", "", s)
    return s.strip()


def has_words(s):
    """矢印・数字・記号だけでなく、言葉が残っているか。"""
    return bool(re.search(r"[ぁ-ゖァ-ヺ一-龯A-Za-z]", re.sub(r"→?\d+-\d+", "", s)))


def split_parts(s, seps="／、"):
    return [p.strip() for p in re.split(f"[{seps}]", s) if p.strip()]


def common_hira_suffix(a, b):
    k = 0
    while k < min(len(a), len(b)) and a[-1 - k] == b[-1 - k] and re.match(f"[{HIRA}]", a[-1 - k]):
        k += 1
    return a[len(a) - k:] if k else ""


def py_like(re_src):
    """Python で近似的に試す（JS 固有の書き方は使っていない前提）。"""
    try:
        return re.compile(re_src)
    except re.error:
        return None


def fix_regex(ng, ok):
    """直す前→直した後 の正規表現と置換文字列を作る。"""
    if ng in ok:
        # 直した後が直す前を含む（コミュニティ→コミュニティー）→二重に光らないよう前後を否定
        i = ok.index(ng)
        pre, post = ok[:i], ok[i + len(ng):]
        src = (f"(?<!{js_escape(pre)})" if pre else "") + js_escape(ng) + (f"(?!{js_escape(post)})" if post else "")
        return src, ok
    suf = common_hira_suffix(ng, ok)
    if suf and suf != ng and suf != ok:
        stem_ng, stem_ok = ng[: -len(suf)], ok[: -len(suf)]
        if not KANA_ONLY_RE.match(stem_ng):
            if suf.endswith("しい") and ng.endswith("しい"):
                look = "(?=し)"
            elif suf == "い":
                look = "(?=[いくかけさ])"
            else:
                look = f"(?=[{HIRA}])"
            src = js_escape(stem_ng) + look
            rx = py_like(src)
            # 直した後に当たらないこと・直す前には当たること
            if rx and rx.search(ng) and not rx.search(ok):
                return src, stem_ok
    return js_escape(ng), ok


def check_regex(cell):
    """確かめる語の正規表現（語の並び）。"""
    s = PAREN_RE.sub("", cell).strip()
    quoted = re.findall(r"「([^「」]+)」", s)
    parts = quoted if quoted else split_parts(s, "／、・")
    alts = []
    for p in parts:
        p = re.sub(r"^[○〇●〜～]+|[○〇●〜～]+$", "", p).strip()
        if not p:
            continue
        pieces = re.split(r"[○〇●]+|[〜～]+", p)
        alts.append(r"[^。、「」\n]{1,12}?".join(js_escape(x) for x in pieces if x))
    alts = sorted(dict.fromkeys(a for a in alts if a), key=len, reverse=True)
    return "|".join(alts)


def make_rule(**kw):
    base = dict(kind="", level=1, area="all", ji=0, re="", to=None, label="", why="",
                ch=0, sec="", r="", stat="", n=0, src="guide")
    base.update(kw)
    return base


def table_rules(ov):
    rules, skipped, used = [], 0, set()
    stats = dict(rows=0, auto=0, override=0)
    for t in iter_tables():
        ch = bg.chapter_no(t["file"]) or 0
        sec = t["sec"]
        default_kind = "fix" if t["key"] in FIX_TABLES else "check"
        ok_col = len(t["hdr"]) > 1 and bool(OK_COL_RE.search(t["hdr"][1]))
        why_col = 2 if ok_col else 1
        ji_table = t["key"] == "ch07_expression.md:NG（地の文）" or sec.startswith("7-11")
        prev_why = ""
        for cells in t["rows"]:
            stats["rows"] += 1
            ng = bg.strip_md(cells[0])
            ok = bg.strip_md(cells[1]) if len(cells) > 1 else ""
            r = first_tag(" ".join(cells), True) or first_tag(cells[0], False) or t["r"]
            stat, n = get_stat(cells, t["hdr"])
            raw_why = cells[why_col] if len(cells) > why_col and t["hdr"][why_col] != "件数" else ""
            why = strip_stat(clean_why(raw_why))
            if why == "同上":
                why = prev_why
            if not has_words(why) or why == "NG":
                why = t["sub"] or re.sub(r"^(?:\d+-\d+|[A-Z])\.\s*", "", sec)
            prev_why = why
            label = strip_stat(f"{ng}→{ok}" if ok_col and ok else ng)
            common = dict(ch=ch, sec=sec.replace(". ", " ", 1), r=r, stat=stat, n=n, label=label)
            k = (t["file"], ng)
            if k in ov:
                used.add(k)
                stats["override"] += 1
                for o in ov[k]:
                    _, _, kind, level, area, ji, re_src, to, owhy, _ = o
                    if kind == "skip":
                        skipped += 1
                        continue
                    c2 = dict(common)
                    if kind == "fix" and "→" not in c2["label"] and to and not re.search(r"[@$]", to):
                        c2["label"] = f"{c2['label']}→{to}"
                    rules.append(make_rule(
                        kind=kind, level=int(level or 1), area=area or "all", ji=int(ji or 0),
                        re=re_src, to=(to if kind != "check" else None),
                        why=strip_stat(clean_why(owhy)) or why, **c2))
                continue
            stats["auto"] += 1
            if default_kind == "check":
                src = check_regex(cells[0])
                if not src:
                    warn(f"未処理（語を取り出せない）: {t['file']} {ng}")
                    continue
                rules.append(make_rule(kind="check", ji=1 if ji_table else 0, re=src, why=why, **common))
                continue
            # 自動 fix
            ngc = PAREN_RE.sub("", ng).strip()
            okc = PAREN_RE.sub("", ok).strip()
            ng_parts, ok_parts = split_parts(ngc), split_parts(okc)
            if len(ng_parts) == 1 and "・" in ngc:
                ng_parts = split_parts(ngc, "・")
                if "・" in okc and len(split_parts(okc, "・")) == len(ng_parts):
                    ok_parts = split_parts(okc, "・")
            if any(re.search(r"[○〇●〜～「]", p) for p in ng_parts):
                warn(f"未処理（記号が残る）: {t['file']} {ng}")
                continue
            if len(ok_parts) == 1:
                ok_parts = ok_parts * len(ng_parts)
            if len(ng_parts) != len(ok_parts):
                # 直した後が複数で決まらない → 確かめる
                src = "|".join(sorted((js_escape(p) for p in ng_parts), key=len, reverse=True))
                opts = "、".join(f"「{p}」" for p in ok_parts)
                rules.append(make_rule(kind="check", ji=1, re=src,
                                       why=f"{opts}のどれかに言い換える" + (f"（{why}）" if why else ""),
                                       **common))
                continue
            for a, b in zip(ng_parts, ok_parts):
                src, to = fix_regex(a, b)
                c2 = dict(common, label=f"{a}→{b}")
                rules.append(make_rule(kind="fix", ji=1, re=src, to=to, why=why, **c2))
    for k in ov:
        if k not in used:
            warn(f"overrides の行が表に見つからない: {k[0]} {k[1]}")
    return rules, skipped, stats


def extra_rules():
    rules = []
    for row in read_tsv(HERE / "rules_extra.tsv", 13):
        kind, level, area, ji, re_src, to, label, why, ch, sec, r, stat, src = row
        n = max([int(x) for x in re.findall(r"(\d+)[本件]", re.sub(r"\d+本中", "", stat))] or [0])
        rules.append(make_rule(
            kind=kind, level=int(level or 1), area=area or "all", ji=int(ji or 0),
            re=re_src, to=(to if kind != "check" else None), label=label, why=clean_why(why),
            ch=int(ch) if ch.isdigit() else 0, sec=sec, r=r, stat=stat, n=n, src=src or "guide"))
    return rules


def dedupe(rules):
    out, by_re = [], {}
    dropped = 0
    for rl in rules:
        k = (rl["re"], rl["area"])
        if k in by_re:
            keep = by_re[k]
            if rl["stat"] and rl["stat"] not in keep["stat"]:
                keep["stat"] = "、".join(x for x in (keep["stat"], rl["stat"]) if x)
            keep["n"] = max(keep["n"], rl["n"])
            dropped += 1
            continue
        by_re[k] = rl
        out.append(rl)
    return out, dropped


def node_check(rules):
    """Node で全正規表現をコンパイルし、空文字に当たらないことを確かめる。"""
    js = r"""
const rs = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const bad = [];
rs.forEach((r, i) => {
  try { const x = new RegExp(r, 'gm'); if (x.exec('') !== null) bad.push([i, 'empty match']); }
  catch (e) { bad.push([i, String(e.message)]); }
});
process.stdout.write(JSON.stringify(bad));
"""
    res = subprocess.run(["node", "-e", js], input=json.dumps([r["re"] for r in rules]),
                         capture_output=True, text=True, check=True)
    for i, msg in json.loads(res.stdout):
        warn(f"正規表現エラー {rules[i]['id']} {rules[i]['label']}: {msg}")


def ai_rules():
    """付録 D の索引から、機械では見つけにくい規則（🧠）を拾う。"""
    out = []
    lines = (GUIDE / "90_appendix.md").read_text(encoding="utf-8").split("\n")
    for line in lines:
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) >= 4 and re.match(r"^R\d+$", cells[0]) and "🧠" in cells[2]:
            out.append((cells[0], clean_why(cells[1]), bg.strip_md(cells[3])))
    return out


CH_NAME = {0: "付録"}


def ch_label(ch):
    return CH_NAME.get(ch, f"第{ch}章")


def build_md(rules):
    kinds = [("fix", "直す（答えが一つの語）"), ("check", "確かめる（文脈で答えが変わる語）"), ("form", "形（字数・数字・記号など）")]
    out = [
        "# 宗像経済新聞 表記ルール（表記チェッカーと同じ表）",
        "",
        "記者ガイド（正本）の表から作った一覧です。自分の AI に原稿と一緒に渡し、「このルールに沿っているか確かめて」と頼んでください。",
        "表記チェッカーは下の「直す」「確かめる」「形」を機械で光らせます。最後の「機械では見つけにくい規則」は AI か人の目で確かめてください。",
        "",
        "- 直す：直す前→直した後。答えが一つに決まる",
        "- 確かめる：文脈で答えが変わる。理由を読んで判断する",
        "- 形：タイトル・リードの字数、全角数字、記号など",
        "- 地の文だけ：かぎかっこ「」の中（発言の引用）は対象外",
        "",
    ]
    for kind, title in kinds:
        rs = [r for r in rules if r["kind"] == kind]
        out.append(f"## {title}（{len(rs)}件）")
        out.append("")
        chs = sorted({r["ch"] for r in rs}, key=lambda c: (c == 0, c))
        for ch in chs:
            out.append(f"### {ch_label(ch)}")
            out.append("")
            for r in sorted((r for r in rs if r["ch"] == ch), key=lambda r: -r["n"]):
                notes = []
                if r["ji"]:
                    notes.append("地の文だけ")
                if r["area"] not in ("all",):
                    notes.append({"text": "リード・本文", "body": "本文", "title": "タイトル",
                                  "lead": "リード", "caption": "写真キャプション"}.get(r["area"], r["area"]))
                if r["level"] == 2:
                    notes.append("デスク向け")
                if r["stat"]:
                    notes.append(r["stat"])
                src = "・".join(x for x in (r["sec"], r["r"]) if x)
                line = f"- {r['label']}：{r['why']}"
                if src:
                    line += f"（{src}）"
                if notes:
                    line += f" ［{'／'.join(notes)}］"
                out.append(line)
            out.append("")
    ai = ai_rules()
    out.append(f"## 機械では見つけにくい規則（AI・人の目で確かめる）（{len(ai)}件）")
    out.append("")
    for r, name, where in ai:
        out.append(f"- {r} {name}（{where}）")
    out.append("")
    return "\n".join(out)


def build_html(rules, md):
    tpl_p, eng_p = HERE / "template.html", HERE / "engine.js"
    if not tpl_p.exists() or not eng_p.exists():
        return None
    tpl = tpl_p.read_text(encoding="utf-8")
    eng = eng_p.read_text(encoding="utf-8")

    def safe(s):
        return s.replace("</", "<\\/")
    sample = (HERE / "sample.txt").read_text(encoding="utf-8") if (HERE / "sample.txt").exists() else ""
    built = max((GUIDE / f).stat().st_mtime for f in bg.ORDER)
    meta = {"built": time.strftime("%Y-%m-%d", time.localtime(built)), "count": len(rules)}
    html = (tpl.replace("/*RULES_JSON*/null", safe(json.dumps(rules, ensure_ascii=False)))
               .replace("/*RULES_MD*/\"\"", safe(json.dumps(md, ensure_ascii=False)))
               .replace("/*SAMPLE*/\"\"", safe(json.dumps(sample, ensure_ascii=False)))
               .replace("/*META*/{}", safe(json.dumps(meta, ensure_ascii=False)))
               .replace("/*ENGINE_JS*/", safe(eng)))
    for ph in ("/*RULES_JSON*/", "/*RULES_MD*/", "/*SAMPLE*/", "/*META*/", "/*ENGINE_JS*/"):
        if ph in html:
            warn(f"template.html の差し込み口が残っている: {ph}")
    (HERE / "index.html").write_text(html, encoding="utf-8")
    return len(html.encode("utf-8"))


def main():
    ov = {}
    for row in read_tsv(HERE / "overrides.tsv", 10):
        ov.setdefault((row[0], row[1]), []).append(row)
    trules, skipped, stats = table_rules(ov)
    erules = extra_rules()
    rules, dropped = dedupe(trules + erules)
    for b in BUILTIN:
        rules.append(make_rule(re="", **b))
    for i, r in enumerate(rules, 1):
        r["id"] = f"k{i:03d}"
    node_check([r for r in rules if r["re"]])
    for r in rules:
        for f in ("why", "label", "stat"):
            if re.search(r"本部「|本部コメント", r[f] or ""):
                warn(f"本部の言葉が残っている {r['id']} {f}: {r[f]}")
        if r["kind"] in ("fix",) and r["to"] is None and not r.get("builtin"):
            warn(f"直すのに置換先がない {r['id']} {r['label']}")
    md = build_md(rules)
    if re.search(r"本部「|本部コメント", md):
        warn("表記ルール.md に本部の言葉が残っている")
    keyorder = ["id", "kind", "level", "area", "ji", "re", "to", "label", "why", "ch", "sec", "r", "stat", "n", "src", "builtin"]
    rules = [{k: r[k] for k in keyorder if k in r} for r in rules]
    (HERE / "rules.json").write_text(json.dumps(rules, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    (HERE / "表記ルール.md").write_text(md, encoding="utf-8")
    size = build_html(rules, md)

    # 報告
    print(f"表の行 {stats['rows']}（上書きあり {stats['override']}・自動 {stats['auto']}）・skip {skipped}・同じ正規表現をまとめた {dropped}")
    print(f"rules.json {len(rules)}件（組み込みの形 {len(BUILTIN)} を含む）")
    for kind in ("fix", "check", "form"):
        l1 = sum(1 for r in rules if r["kind"] == kind and r["level"] == 1)
        l2 = sum(1 for r in rules if r["kind"] == kind and r["level"] == 2)
        print(f"  {kind:5s} level1 {l1:3d} / level2 {l2:3d}")
    mayoi = [(row[0], row[1], row[9]) for rows in ov.values() for row in rows if row[9].strip()]
    print(f"判定に迷った行（mayoi）{len(mayoi)}行")
    if "--list" in sys.argv:
        for f, ng, m in mayoi:
            print(f"  {f} {ng}：{m}")
    print("index.html " + (f"{size:,}B" if size else "（template.html か engine.js が無いので作らず）"))
    print(f"警告 {len(warnings)}件")
    for w in warnings:
        print("  " + w)
    return 1 if warnings else 0


if __name__ == "__main__":
    sys.exit(main())
