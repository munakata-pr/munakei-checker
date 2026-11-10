// 表記チェッカーの点検テスト
//   node test_engine.mjs            サンプル原稿・規則ごとの例文・返却版の精度
//   node test_engine.mjs --detail   返却版で光った語と、拾えなかった直しの一覧も出す（_test/ の原稿の中身が出るので公開しない）
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { createEngine, FUNCS } = require(join(HERE, 'engine.js'));
const rules = JSON.parse(readFileSync(join(HERE, 'rules.json'), 'utf8'));
const eng = createEngine(rules);
const detail = process.argv.includes('--detail');
let failures = 0;
const fail = (msg) => { failures++; console.log('  NG ' + msg); };
const count = (fs, kind) => fs.filter((f) => f.rule.kind === kind).length;

// (1) サンプル原稿：直すを全部反映 → もう一度点検で fix 0件
console.log('(1) サンプル原稿');
const sample = readFileSync(join(HERE, 'sample.txt'), 'utf8');
for (const level of [1, 2]) {
  const r1 = eng.check(sample, { level });
  const fixed = eng.applyAll(sample, r1.findings);
  const r2 = eng.check(fixed, { level });
  const f2 = r2.findings.filter((f) => f.rule.kind === 'fix');
  const fm2 = r2.findings.filter((f) => f.rule.kind === 'form' && f.edits);
  console.log(`  level${level}: 1回目 直す${count(r1.findings, 'fix')}・確かめる${count(r1.findings, 'check')}・形${count(r1.findings, 'form')} → 反映後 直す${f2.length}・置換できる形${fm2.length}`);
  if (f2.length) fail('反映後に直すが残る: ' + f2.map((f) => `${f.rule.label}「${f.text}」`).join('、'));
  if (fm2.length) fail('反映後に置換できる形が残る: ' + fm2.map((f) => `${f.rule.label}「${f.text}」`).join('、'));
  if (level === 1) {
    const ids = new Set(r1.findings.map((f) => f.rule.builtin || f.rule.label));
    for (const b of ['title_len', 'indent', 'nested_quote', 'blank_space']) if (!ids.has(b)) fail(`サンプルで組み込みの点検 ${b} が出ない`);
    if (detail) for (const f of r1.findings) console.log(`    ${f.rule.kind} ${f.area} 「${f.text}」→${f.to === null ? '-' : '「' + f.to + '」'} ${f.rule.label}${f.info ? ' / ' + f.info : ''}`);
    console.log('  反映後の原稿（先頭120字）: ' + JSON.stringify(fixed.slice(0, 120)));
  }
}

// (2) 規則ごとの例文：ラベルの「直す前」に当てて置き換え、直した後に同じ規則が当たらない
console.log('(2) 規則ごとの例文');
const expand = (to, m) => (to.charAt(0) === '@' ? FUNCS[to.slice(1)](m) : to.replace(/\$(\d)/g, (_, d) => m[+d] ?? ''));
let tried = 0, hit = 0, dbl = 0, okHit = 0;
const noHit = [];
for (const r of rules) {
  if (r.builtin || !r.re || r.kind === 'check' || r.to === null) continue;
  const [ngRaw, okRaw] = r.label.split('→');
  if (!okRaw) continue;
  const ng = ngRaw.replace(/（[^（）]*）/g, '').trim();
  const ok = okRaw.replace(/（[^（）]*）/g, '').split(/[／・、]/)[0].trim();
  tried++;
  const ex = `${ng}。`;
  const rx = new RegExp(r.re, 'gm');
  if (!rx.test(ex)) { noHit.push(r.label); continue; }
  hit++;
  rx.lastIndex = 0;
  const out = ex.replace(rx, (...a) => { const m = a.slice(0, -2); m.index = a[a.length - 2]; return expand(r.to, m); });
  rx.lastIndex = 0;
  if (rx.test(out)) { dbl++; fail(`二重に当たる ${r.id} ${r.label}: 「${ex}」→「${out}」`); }
  rx.lastIndex = 0;
  if (ok && !/[$@]/.test(r.to) && rx.test(ok)) { okHit++; fail(`直した後に当たる ${r.id} ${r.label}: 「${ok}」`); }
}
console.log(`  直す・形 ${tried}件で試し、例文に当たった ${hit}件・二重 ${dbl}件・直した後に当たる ${okHit}件・例文に当たらない ${noHit.length}件（前後の字が要る規則）`);
if (detail && noHit.length) console.log('    当たらない: ' + noHit.join('、'));

// (3) 返却版の精度
console.log('(3) 返却版の精度');
const testDir = join(HERE, '_test');
const files = existsSync(testDir) ? readdirSync(testDir).filter((f) => /_v2\.json$/.test(f)) : [];
if (!files.length) console.log('  _test/*_v2.json がない（公開リポジトリには入れないので、手元でだけ測る）');
const total = { edits: 0, caught: 0, caughtFix: 0, findings: 0, extra: 0, byKind: {} };
for (const fn of files) {
  const d = JSON.parse(readFileSync(join(testDir, fn), 'utf8'));
  const lines = [];
  const edits = [];
  let pos = 0;
  for (const segs of d.paragraphs) {
    const orig = segs.filter(([k]) => k !== 'ins').map(([, t]) => t).join('');
    const neu = segs.filter(([k]) => k !== 'del').map(([, t]) => t).join('');
    const star = neu.trim().startsWith('★');
    if (star && !orig.trim()) continue; // 本部の指摘だけの段落は除く
    if (!star) {
      let off = pos;
      let cur = null;
      for (const [k, t] of segs) {
        if (k === 'keep') { if (cur) { edits.push(cur); cur = null; } off += t.length; continue; }
        if (k === 'ins' && t.trim().startsWith('★')) continue;
        if (!cur) cur = { start: off, end: off, del: '', ins: '' };
        if (k === 'del') { cur.end += t.length; cur.del += t; off += t.length; } else cur.ins += t;
      }
      if (cur) edits.push(cur);
    }
    lines.push(orig);
    pos += orig.length + 1;
  }
  const text = lines.join('\n');
  const touches = (f, e) => (e.end > e.start ? f.start < e.end && e.start < f.end : f.start <= e.start && e.start <= f.end);
  for (const level of [1, 2]) {
    const fs = eng.check(text, { level }).findings.filter((f) => f.end > f.start);
    const caught = edits.filter((e) => fs.some((f) => touches(f, e)));
    const caughtFix = edits.filter((e) => fs.some((f) => f.rule.kind !== 'check' && touches(f, e)));
    const extra = fs.filter((f) => !edits.some((e) => touches(f, e)));
    const byKind = {};
    for (const f of fs) {
      const k = f.rule.kind;
      byKind[k] = byKind[k] || { n: 0, extra: 0 };
      byKind[k].n++;
      if (!edits.some((e) => touches(f, e))) byKind[k].extra++;
    }
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
    console.log(`  ${fn} level${level}: 本部の直し ${edits.length}か所・光った ${fs.length}（${Object.entries(byKind).map(([k, v]) => `${k} ${v.n}（余計 ${v.extra}）`).join('・')}）・拾えた ${caught.length}（${pct(caught.length, edits.length)}%、直す・形だけで ${caughtFix.length}）・余計な指摘 ${extra.length}`);
    if (level === 2) {
      total.edits += edits.length; total.caught += caught.length; total.caughtFix += caughtFix.length;
      total.findings += fs.length; total.extra += extra.length;
      if (detail) {
        for (const f of fs) console.log(`    ${edits.some((e) => touches(f, e)) ? '○' : '×'} ${f.rule.kind} ${f.area} 「${f.text.slice(0, 20)}」 ${f.rule.label}${f.info ? ' / ' + f.info : ''}`);
        for (const e of edits.filter((x) => !caught.includes(x))) console.log(`    未 「${e.del.slice(0, 20)}」→「${e.ins.slice(0, 20)}」`);
      }
    }
  }
}
if (files.length > 1) console.log(`  合計（level2）: 本部の直し ${total.edits}・拾えた ${total.caught}（直す・形だけで ${total.caughtFix}）・光った ${total.findings}・余計な指摘 ${total.extra}`);

console.log(failures ? `失敗 ${failures}件` : '失敗 0件');
process.exit(failures ? 1 : 0);
