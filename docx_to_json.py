#!/usr/bin/env python3
"""本部の返却版 docx（変更履歴つき）を精度テスト用の JSON にする。

使い方: python3 docx_to_json.py <返却版.docx> <出力.json> [Drive のファイルID]
出力は _test/ に置く（公開リポジトリには入れない）。

段落ごとに [["keep"|"ins"|"del", 文字列], ...] を文書順に並べる。
Google ドキュメント経由の docx は変更履歴（w:ins / w:del）が w:sdt / w:sdtContent に包まれているので、
入れ子を順にたどって読む（extract_changes.py の paragraph_segments は段落の直下しか見ない）。
"""
import json
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
SKIP = {f"{W}pPr", f"{W}rPr", f"{W}sdtPr", f"{W}sdtEndPr", f"{W}bookmarkStart", f"{W}bookmarkEnd"}


def segments(p):
    segs = []

    def add(kind, text):
        if not text:
            return
        if segs and segs[-1][0] == kind:
            segs[-1][1] += text
        else:
            segs.append([kind, text])

    def walk(el, state):
        for ch in el:
            tag = ch.tag
            if tag in SKIP:
                continue
            if tag in (f"{W}ins", f"{W}moveTo"):
                walk(ch, "ins")
            elif tag in (f"{W}del", f"{W}moveFrom"):
                walk(ch, "del")
            elif tag == f"{W}r":
                for t in ch:
                    if t.tag == f"{W}t":
                        add(state, t.text or "")
                    elif t.tag == f"{W}delText":
                        add("del", t.text or "")
                    elif t.tag == f"{W}tab":
                        add(state, "\t")
            elif tag == f"{W}p":
                continue  # 入れ子の段落（表など）は別に数える
            else:
                walk(ch, state)  # w:sdt / w:sdtContent / w:hyperlink / w:smartTag / w:customXml など

    walk(p, "keep")
    return segs


def convert(src, out, fid=""):
    with zipfile.ZipFile(src) as z:
        doc = ET.fromstring(z.read("word/document.xml"))
    paras = [segments(p) for p in doc.iter(f"{W}p")]
    d = {"id": fid, "title": Path(src).name, "bytes": Path(src).stat().st_size, "paragraphs": paras}
    Path(out).write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    tot = {k: sum(len(t) for p in paras for kk, t in p if kk == k) for k in ("keep", "ins", "del")}
    return len(paras), tot


if __name__ == "__main__":
    n, tot = convert(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "")
    print(f"{sys.argv[2]} 段落 {n} keep {tot['keep']}字・ins {tot['ins']}字・del {tot['del']}字")
