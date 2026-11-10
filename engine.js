/* 宗像経済新聞 表記チェッカー 点検エンジン（ブラウザと Node の両方で動く）
 * createEngine(rules) → { check(text, {level}), applyAll(text, findings), applyOne(text, finding), parseSections(text) }
 * 原稿はどこにも送らない。正規表現と組み込みの形の点検だけで光らせる（AI は使わない）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MunakeiEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KIND_PRI = { fix: 0, form: 1, check: 2 };
  const AREAS = {
    all: ['title', 'lead', 'body', 'caption'],
    text: ['lead', 'body'],
    body: ['body'],
    title: ['title'],
    lead: ['lead'],
    caption: ['caption'],
  };
  const LIMIT = { title: 35, lead: 90, bodyMin: 600, bodyMax: 1000 };
  const SPACE_RE = /[\s　]/;

  // ---- 原稿の欄 ----
  function markName(line) {
    const m = /^[ \t　]*[▽▼][ \t　]*([^\s　＊*※（(：:]*)/.exec(line);
    return m ? m[1] : null;
  }
  function areaOfMark(name) {
    if (/写真タイトル|関連画像/.test(name)) return 'caption'; // 写真のタイトル（11/10：本部が1年で234か所直していた）
    if (/外部リンク|リンク|住所|地図|URL|ＵＲＬ|メモ|備考/.test(name)) return 'skip';
    if (/キャプション/.test(name)) return 'caption';
    if (/タイトル|見出し/.test(name)) return 'title';
    if (/リード/.test(name)) return 'lead';
    if (/本文/.test(name)) return 'body';
    return 'skip';
  }

  function trimRange(text, s, e) {
    while (s < e && SPACE_RE.test(text[s])) s++;
    while (e > s && SPACE_RE.test(text[e - 1])) e--;
    return [s, e];
  }
  function cpLen(str) {
    let n = 0;
    for (const _ of str) n++; // eslint-disable-line no-unused-vars
    return n;
  }
  // 先頭から n 文字目（コードポイント）の UTF-16 位置
  function cpOffset(str, n) {
    let i = 0;
    let k = 0;
    for (const ch of str) {
      if (k === n) return i;
      i += ch.length;
      k++;
    }
    return i;
  }

  function parseSections(text) {
    const lines = [];
    let pos = 0;
    for (const t of text.split('\n')) {
      lines.push({ start: pos, end: pos + t.length, text: t });
      pos += t.length + 1;
    }
    const paras = [];
    const blanks = []; // リード・本文の中の、空白だけの行
    const push = (area, start, end, lineStart) => {
      if (end > start) paras.push({ area, start, end, lineStart });
    };
    const splitLead = (l) => {
      const i = l.text.indexOf('。');
      if (i >= 0 && l.text.slice(i + 1).trim()) {
        push('lead', l.start, l.start + i + 1, true);
        push('body', l.start + i + 1, l.end, false);
      } else push('lead', l.start, l.end, true);
    };
    const marks = lines.map((l) => markName(l.text));
    const hasMarks = marks.some((m) => m !== null);
    if (hasMarks) {
      const hasLeadMark = marks.some((m) => m !== null && areaOfMark(m) === 'lead');
      let cur = 'skip';
      let leadDone = false;
      lines.forEach((l, i) => {
        if (marks[i] !== null) {
          cur = areaOfMark(marks[i]);
          return;
        }
        if (!l.text.trim()) {
          if (l.text && cur !== 'skip') blanks.push({ start: l.start, end: l.end, area: cur });
          return;
        }
        if (cur === 'skip') return;
        if (cur === 'body' && !hasLeadMark && !leadDone) {
          leadDone = true;
          splitLead(l);
          return;
        }
        push(cur, l.start, l.end, true);
      });
    } else {
      let state = 0;
      for (const l of lines) {
        if (!l.text.trim()) {
          if (l.text && state === 2) blanks.push({ start: l.start, end: l.end, area: 'body' });
          continue;
        }
        if (state === 0) {
          push('title', l.start, l.end, true);
          state = 1;
        } else if (state === 1) {
          splitLead(l);
          state = 2;
        } else push('body', l.start, l.end, true);
      }
    }
    // 文字ごとの欄の番号と、かぎかっこの中か
    const paraIdx = new Int16Array(text.length + 1).fill(-1);
    paras.forEach((p, k) => {
      for (let i = p.start; i < p.end; i++) paraIdx[i] = k;
    });
    const inQuote = new Uint8Array(text.length + 1);
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '\n') {
        depth = 0;
        continue;
      }
      if (c === '「' || c === '『') {
        depth++;
        inQuote[i] = 1;
      } else if (c === '」' || c === '』') {
        inQuote[i] = depth > 0 ? 1 : 0;
        depth = Math.max(0, depth - 1);
      } else inQuote[i] = depth > 0 ? 1 : 0;
    }
    // 字数
    const stats = { title: [], lead: null, body: 0, hasMarks };
    let leadLen = 0;
    let anyLead = false;
    for (const p of paras) {
      const [s, e] = trimRange(text, p.start, p.end);
      const seg = text.slice(s, e);
      if (p.area === 'title') stats.title.push(cpLen(seg));
      if (p.area === 'lead') {
        leadLen += cpLen(seg);
        anyLead = true;
      }
      if (p.area === 'lead' || p.area === 'body') stats.body += cpLen(seg.replace(/[\s　]/g, ''));
    }
    stats.lead = anyLead ? leadLen : null;
    return { paras, blanks, paraIdx, inQuote, stats };
  }

  // ---- 置換の関数 ----
  function comma(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function yenText(n) {
    if (n < 10000) return comma(n);
    const oku = Math.floor(n / 1e8);
    const man = Math.floor((n % 1e8) / 1e4);
    const rest = n % 1e4;
    return (oku ? comma(oku) + '億' : '') + (man ? comma(man) + '万' : '') + (rest ? comma(rest) : '');
  }
  const FUNCS = {
    circled: (m) => '（' + (m[0].codePointAt(0) - 0x245f) + '）',
    zen2han: (m) => m[0].replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)),
    nocomma: (m) => m[0].replace(/,/g, ''),
    yen: (m) => yenText(Number(m[0].replace(/[,円]/g, ''))) + '円',
    reiwa: (m) => (m[1] === '元' ? 2019 : 2018 + Number(m[1])) + '年',
  };
  function expand(to, m) {
    if (to.charAt(0) === '@') {
      const f = FUNCS[to.slice(1)];
      return f ? f(m) : null;
    }
    return to.replace(/\$(\d)/g, (_, d) => (m[+d] === undefined ? '' : m[+d]));
  }

  // ---- 組み込みの形の点検 ----
  function builtinFindings(text, sec, rule) {
    const out = [];
    const add = (o) => out.push(Object.assign({ rule, to: null, edits: null, wide: false }, o));
    const name = rule.builtin;
    for (const p of sec.paras) {
      const [s, e] = trimRange(text, p.start, p.end);
      const seg = text.slice(s, e);
      if (name === 'title_len' && p.area === 'title') {
        const n = cpLen(seg);
        if (n > LIMIT.title) {
          const off = s + cpOffset(seg, LIMIT.title);
          add({ start: off, end: e, text: text.slice(off, e), info: `タイトル ${n}字（${LIMIT.title}字以内）`, wide: true, area: 'title' });
        }
      }
      if (name === 'title_space' && p.area === 'title' && seg && !/[ 　]/.test(seg)) {
        add({ start: s, end: e, text: seg, info: 'タイトルにスペースがない', wide: true, area: 'title' });
      }
      if (name === 'indent' && p.lineStart && (p.area === 'lead' || p.area === 'body')) {
        const line = text.slice(p.start, p.end);
        const ws = /^[ \t　]*/.exec(line)[0];
        if (ws === '　') continue;
        if (ws === '') {
          const ch = String.fromCodePoint(line.codePointAt(0));
          add({ start: p.start, end: p.start + ch.length, text: ch, to: '　' + ch, info: '段落の先頭に全角スペースがない',
            edits: [{ start: p.start, end: p.start, to: '　' }], wide: true, area: p.area });
        } else {
          add({ start: p.start, end: p.start + ws.length, text: ws, to: '　',
            info: ws.indexOf('\t') >= 0 ? '字下げにタブ' : /^　+$/.test(ws) ? '字下げが全角スペース2つ以上' : '字下げに半角スペース',
            edits: [{ start: p.start, end: p.start + ws.length, to: '　' }], area: p.area });
        }
      }
    }
    if (name === 'blank_space') {
      for (const b of sec.blanks) {
        add({ start: b.start, end: b.end, text: text.slice(b.start, b.end), to: '', info: '空行に空白が入っている',
          edits: [{ start: b.start, end: b.end, to: '' }], area: b.area });
      }
    }
    if (name === 'lead_len' || name === 'body_len') {
      const leads = sec.paras.filter((p) => p.area === 'lead');
      if (name === 'lead_len' && leads.length) {
        const [s0] = trimRange(text, leads[0].start, leads[0].end);
        const [, e1] = trimRange(text, leads[leads.length - 1].start, leads[leads.length - 1].end);
        const n = sec.stats.lead;
        if (n > LIMIT.lead) {
          // 91字目からを光らせる（複数行のリードは行をまたいで数える）
          let left = LIMIT.lead;
          let off = e1;
          for (const p of leads) {
            const [s, e] = trimRange(text, p.start, p.end);
            const len = cpLen(text.slice(s, e));
            if (left < len) {
              off = s + cpOffset(text.slice(s, e), left);
              break;
            }
            left -= len;
          }
          add({ start: off, end: e1, text: text.slice(off, e1), info: `リード ${n}字（${LIMIT.lead}字以内）`, wide: true, area: 'lead' });
        }
        void s0;
      }
      if (name === 'body_len') {
        const n = sec.stats.body;
        const first = sec.paras.find((p) => p.area === 'lead' || p.area === 'body');
        if (first && (n < LIMIT.bodyMin || n > LIMIT.bodyMax)) {
          add({ start: first.start, end: first.start, text: '', info: `リード＋本文 ${n}字（目安 ${LIMIT.bodyMin}〜${LIMIT.bodyMax}字）`, wide: true, area: 'body' });
        }
      }
    }
    if (name === 'nested_quote') {
      const lines = text.split('\n');
      let pos = 0;
      for (const line of lines) {
        const stack = [];
        for (let i = 0; i < line.length; i++) {
          const c = line[i];
          if (c === '「') stack.push(i);
          else if (c === '」' && stack.length) {
            const o = stack.pop();
            if (stack.length === 1) {
              const s = pos + o;
              const k = sec.paraIdx[s];
              if (k >= 0) {
                add({ start: s, end: s + 1, text: '「', to: '『', info: '「」の中の「」',
                  edits: [{ start: s, end: s + 1, to: '『' }, { start: pos + i, end: pos + i + 1, to: '』' }], area: sec.paras[k].area });
              }
            }
          }
        }
        pos += line.length + 1;
      }
    }
    return out;
  }

  function overlaps(a, b) {
    return a.start < b.end && b.start < a.end;
  }

  function createEngine(rules) {
    const compiled = [];
    const builtins = [];
    rules.forEach((r, order) => {
      if (r.builtin) builtins.push({ r, order });
      else if (r.re) compiled.push({ r, order, rx: new RegExp(r.re, 'gm') });
    });

    function check(text, opts) {
      const level = (opts && opts.level) || 1;
      const sec = parseSections(text);
      const tokens = [];
      const wides = [];
      for (const { r, order, rx } of compiled) {
        if (r.level > level) continue;
        const allowed = AREAS[r.area] || AREAS.all;
        rx.lastIndex = 0;
        let m;
        while ((m = rx.exec(text)) !== null) {
          if (m[0].length === 0) {
            rx.lastIndex++;
            continue;
          }
          const s = m.index;
          const e = s + m[0].length;
          const k = sec.paraIdx[s];
          if (k < 0 || sec.paraIdx[e - 1] !== k || allowed.indexOf(sec.paras[k].area) < 0) continue;
          if (r.ji) {
            let q = false;
            for (let i = s; i < e; i++) if (sec.inQuote[i]) { q = true; break; }
            if (q) continue;
          }
          let to = null;
          let edits = null;
          if (r.kind !== 'check' && r.to !== null && r.to !== undefined) {
            to = expand(r.to, m);
            if (to === null || to === m[0]) continue;
            edits = [{ start: s, end: e, to }];
          }
          tokens.push({ rule: r, order, start: s, end: e, text: m[0], to, edits, area: sec.paras[k].area, wide: false });
        }
      }
      for (const { r, order } of builtins) {
        if (r.level > level) continue;
        for (const f of builtinFindings(text, sec, r)) {
          f.order = order;
          (f.wide ? wides : tokens).push(f);
        }
      }
      // 重なり：直す ＞ 形 ＞ 確かめる、同じなら長い方、同じなら規則の並びの早い方
      tokens.sort((a, b) => KIND_PRI[a.rule.kind] - KIND_PRI[b.rule.kind] || (b.end - b.start) - (a.end - a.start) || a.order - b.order);
      const kept = [];
      for (const f of tokens) {
        if (kept.some((g) => overlaps(f, g))) continue;
        kept.push(f);
      }
      const findings = kept.concat(wides).sort((a, b) => a.start - b.start || a.end - b.end || a.order - b.order);
      const seen = {};
      for (const f of findings) {
        const base = f.rule.id + ':' + f.text;
        seen[base] = (seen[base] || 0) + 1;
        f.key = base + ':' + seen[base];
      }
      return { findings, stats: sec.stats, paras: sec.paras };
    }

    function applyEdits(text, edits) {
      edits.sort((a, b) => b.start - a.start || b.end - a.end);
      let out = text;
      let floor = Infinity;
      for (const ed of edits) {
        if (ed.end > floor) continue; // 念のため：重なる置き換えは飛ばす
        out = out.slice(0, ed.start) + ed.to + out.slice(ed.end);
        floor = ed.start;
      }
      return out;
    }
    function applyAll(text, findings) {
      const edits = [];
      for (const f of findings) {
        if (f.edits && (f.rule.kind === 'fix' || f.rule.kind === 'form')) edits.push(...f.edits);
      }
      return applyEdits(text, edits);
    }
    function applyOne(text, f) {
      return f.edits ? applyEdits(text, f.edits.slice()) : text;
    }

    return { check, applyAll, applyOne, applyEdits, parseSections, rules };
  }

  return { createEngine, parseSections, LIMIT, FUNCS, yenText };
});
