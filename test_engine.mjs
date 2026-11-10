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
  const fixed = eng.applyAll(sample, r1.findings, { level });
  const r2 = eng.check(fixed, { level });
  const f2 = r2.findings.filter((f) => f.rule.kind === 'fix');
  const fm2 = r2.findings.filter((f) => f.rule.kind === 'form' && f.edits);
  console.log(`  level${level}: 1回目 直す${count(r1.findings, 'fix')}・確かめる${count(r1.findings, 'check')}・形${count(r1.findings, 'form')} → 反映後 直す${f2.length}・置換できる形${fm2.length}`);
  if (f2.length) fail('反映後に直すが残る: ' + f2.map((f) => `${f.rule.label}「${f.text}」`).join('、'));
  if (fm2.length) fail('反映後に置換できる形が残る: ' + fm2.map((f) => `${f.rule.label}「${f.text}」`).join('、'));
  {
    const ids = new Set(r1.findings.map((f) => f.rule.builtin || f.rule.label));
    // blank_space は 11/10 からデスク向け（level 2）だけ
    for (const b of level === 1 ? ['title_len', 'indent', 'nested_quote'] : ['blank_space']) if (!ids.has(b)) fail(`サンプルで組み込みの点検 ${b} が出ない（level${level}）`);
    if (level === 1 && ids.has('blank_space')) fail('blank_space が記者向け（level1）に出ている');
  }
  if (level === 1) {
    if (detail) for (const f of r1.findings) console.log(`    ${f.rule.kind} ${f.area} 「${f.text}」→${f.to === null ? '-' : '「' + f.to + '」'} ${f.rule.label}${f.info ? ' / ' + f.info : ''}`);
    console.log('  反映後の原稿（先頭120字）: ' + JSON.stringify(fixed.slice(0, 120)));
  }
}

// (1b) 決まった例文（自作）で、かっこ・体言止め・足した規則・全部反映・key を確かめる
console.log('(1b) 決まった例文');
{
  const body = (t) => '▽本文\n　' + t;
  const fs = (t, level = 1) => eng.check(t, { level }).findings;
  const byLabel = (list, label) => list.filter((f) => (f.rule.builtin || f.rule.label) === label);
  const expect = (cond, msg) => { if (!cond) fail(msg); };
  let n = 0;
  const ok = (cond, msg) => { n++; expect(cond, msg); };

  // かっこ：発言の中は直す・名前のかっこの中は確かめる（edits なし）・ji=1 は黙る・ji=2 は発言の中で確かめる
  const q = body('店主は「味噌を使ったスープです。体験を実施する」と話す。店では「味噌ラーメン」を出す。会場は「市民ホールにて」に決めた。');
  const qf = fs(q);
  const miso = byLabel(qf, '味噌→みそ');
  ok(miso.length === 2, `かっこ：味噌の指摘が2件でない（${miso.length}件）`);
  const mUtter = miso.find((f) => q.slice(f.start - 1, f.start) === '「' && q.slice(f.end, f.end + 3) === 'を使っ');
  const mName = miso.find((f) => q.slice(f.end, f.end + 4) === 'ラーメン');
  ok(mUtter && mUtter.rule.kind === 'fix' && mUtter.edits && !mUtter.down, 'かっこ：発言の中の表記が「直す」で出ない');
  ok(mName && mName.rule.kind === 'check' && !mName.edits && mName.to === null && mName.down === 'name', 'かっこ：名前のかっこの中が「確かめる」（edits なし・down=name）に下がらない');
  ok(mName && mName.rule.why.startsWith('店名・商品名などのかっこの中です。'), 'かっこ：名前の理由の頭が違う');
  ok(rules.find((r) => r.label === '味噌→みそ').kind === 'fix', 'かっこ：元の規則オブジェクトが書き換わった');
  const jisshi = qf.find((f) => f.text === '実施する');
  ok(jisshi && jisshi.rule.kind === 'check' && jisshi.down === 'utter' && !jisshi.edits && jisshi.rule.why.startsWith('発言の中です。'), 'かっこ：ji=2（言い換え）が発言の中で「確かめる」に下がらない');
  ok(!qf.some((f) => f.text === 'にて'), 'かっこ：ji=1（地の文だけ）がかっこの中で光る');
  ok(fs(body('会場にて行う。')).some((f) => f.text === 'にて' && f.rule.kind === 'fix'), 'かっこ：ji=1 が地の文で光らない');
  const qa = eng.applyAll(q, qf, { level: 1 });
  ok(qa.includes('「味噌ラーメン」') && qa.includes('「みそを使った'), 'かっこ：全部反映で名前のかっこの中が変わる、または発言の中が直らない');
  // 閉じ忘れ
  const qb = byLabel(fs(body('店主は「おいしいと話す。')), 'quote_balance');
  ok(qb.length === 1 && qb[0].text === '「' && !qb[0].edits && qb[0].rule.kind === 'form', 'かっこ：閉じ忘れが quote_balance で出ない');
  ok(!byLabel(fs(body('店主は「おいしい」と話す。（写真左）')), 'quote_balance').length, 'かっこ：閉じているのに quote_balance が出る');

  // 体言止め
  const taigen = (t) => byLabel(fs(body(t)), '体言止め');
  for (const [t, w] of [['新しい分野に挑戦。', '挑戦'], ['地元の工場で製造。', '製造'], ['価格は1,000円。', '1,000円'], ['ランチの定食（1,100円）。', '（1,100円）'], ['話すのは店主の見本さん。', '見本さん'], ['看板は新メニュー。', '新メニュー']]) {
    const hit = taigen(t);
    ok(hit.length === 1 && hit[0].text === w, `体言止め：「${t}」で「${w}」が出ない（${hit.map((f) => f.text).join('・') || 'なし'}）`);
  }
  for (const t of ['木曜定休。', '営業時間は21時～翌2時（状況により変動あり）。', '今年オープンした同店。', '所在地は赤間1丁目。', '先着順で進呈する（なくなり次第終了）。', '入場無料。']) {
    const hit = taigen(t);
    ok(!hit.length, `体言止め：「${t}」で出る（${hit.map((f) => f.text).join('・')}）`);
  }

  // タイトルの半角スペース
  const th = byLabel(fs('▽タイトル\n宗像・赤間に新店 地元の小麦でパン\n▽本文\n　パンを売る。'), 'title_halfspace');
  ok(th.length === 1 && th[0].edits && th[0].edits[0].to === '　', 'タイトルの半角スペースが出ない、または全角に置き換えない');
  ok(!byLabel(fs('▽タイトル\n宗像に「Cafe Bar」　開店\n▽本文\n　パンを売る。'), 'title_halfspace').length, 'タイトルの英字の間の半角スペースが光る');
  // のもと→の下
  const nm = byLabel(fs(body('専門家の指導のもと、作った。')), 'のもと→の下');
  ok(nm.length === 1 && nm[0].to === 'の下', 'のもと→の下 が出ない');
  ok(!byLabel(fs(body('親のもとを離れた。')), 'のもと→の下').length, '「親のもと」に のもと→の下 が出る');
  // すべて→全て（確かめる・「すべての」は対象外）
  const sb = byLabel(fs(body('商品はすべて手作りする。')), 'すべて→全て');
  ok(sb.length === 1 && sb[0].rule.kind === 'check' && sb[0].rule.level === 1, 'すべて→全て が記者向けの「確かめる」で出ない');
  ok(!byLabel(fs(body('すべての商品を手作りする。')), 'すべて→全て').length, '「すべての」に すべて→全て が出る');
  // 時→とき（デスク向け）
  ok(fs(body('店を開いた時から通う。'), 2).filter((f) => f.rule.label.startsWith('時→とき')).length === 1, '時→とき がデスク向けで出ない');
  ok(!fs(body('店を開いた時から通う。'), 1).filter((f) => f.rule.label.startsWith('時→とき')).length, '時→とき が記者向けで出る');
  ok(!fs(body('開店の時間から通う。'), 2).filter((f) => f.rule.label.startsWith('時→とき')).length, '「時間」に 時→とき が出る');
  // 名→人の除外・N対N・ぜひとも
  const nin = (t) => byLabel(fs(body(t)), '人数は「人」');
  ok(!nin('100名山を巡る。').length && !nin('3名様まで受け付ける。').length, '名→人 が「100名山」「3名様」に出る');
  ok(nin('定員は10名。').length === 1, '名→人 が「10名」に出ない');
  const tai = byLabel(fs(body('1対1で教える。')), 'スコアはハイフン');
  ok(tai.length === 1 && tai[0].rule.kind === 'check' && !tai[0].edits, 'N対N が「確かめる」でない');
  const zehi = (t) => fs(body(t)).filter((f) => /ぜひ\|是非/.test(f.rule.re || ''));
  ok(!zehi('ぜひとも来てほしい。').length, '「ぜひとも」に ぜひ の規則が出る');
  ok(zehi('ぜひ来てほしい。').length === 1, '「ぜひ」に ぜひ の規則が出ない');

  // 全部反映が収束する
  const cv = body('価格は１０００円、定員は１０名。');
  const cvOut = eng.applyAll(cv, fs(cv), { level: 1 });
  const cvLeft = fs(cvOut).filter((f) => f.edits && (f.rule.kind === 'fix' || f.rule.kind === 'form'));
  ok(cvOut.includes('1,000円') && cvOut.includes('10人') && !cvLeft.length, `全部反映が1回で収束しない: ${JSON.stringify(cvOut)}／残り${cvLeft.length}件`);
  ok(eng.applyAll(cv, fs(cv)).includes('1000円'), '第3引数なしの applyAll が1回分だけ動かない');

  // key：同じ語が3か所ある文で1か所目を直しても、残り2か所の key が変わらない
  const kt = body('最初に味噌を使う。そのあと鍋で煮てから味噌を混ぜる。最後に仕上げとして味噌を足す。');
  const k1 = byLabel(fs(kt), '味噌→みそ');
  const kt2 = eng.applyOne(kt, k1[0]);
  const k2 = byLabel(fs(kt2), '味噌→みそ');
  ok(k1.length === 3 && k2.length === 2 && k2[0].key === k1[1].key && k2[1].key === k1[2].key, 'key：1か所目を直すと残りの key が変わる');
  ok(fs(sample, 2).every((f) => !/\s/.test(f.key)), 'key に空白が入っている');
  const dup = fs(body('味噌。味噌。味噌。味噌。'), 1).filter((f) => f.rule.label === '味噌→みそ').map((f) => f.key);
  ok(new Set(dup).size === dup.length, 'key が重複している');
  console.log(`  ${n}項目`);
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
const hqFile = join(testDir, 'hq', 'hq_1y_20261110.json');
const sets = existsSync(hqFile)
  ? [['1年分（_test/hq）', JSON.parse(readFileSync(hqFile, 'utf8')).docs]]
  : (existsSync(testDir) ? readdirSync(testDir).filter((f) => /_v2\.json$/.test(f)) : []).map((f) => [f, [JSON.parse(readFileSync(join(testDir, f), 'utf8'))]]);
const files = sets;
if (!files.length) console.log('  _test/hq/*.json も _test/*_v2.json もない（公開リポジトリには入れないので、手元でだけ測る）');
const total = { edits: 0, caught: 0, caughtFix: 0, findings: 0, extra: 0, byKind: {} };
function buildDoc(d) {
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
  return { text: lines.join('\n'), edits };
}
const touches = (f, e) => (e.end > e.start ? f.start < e.end && e.start < f.end : f.start <= e.start && e.start <= f.end);
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
for (const [name, docs] of files) {
  for (const level of [1, 2]) {
    const t = { edits: 0, caught: 0, caughtFix: 0, fs: 0, extra: 0 };
    for (const d of docs) {
      const { text, edits } = buildDoc(d);
      const fs = eng.check(text, { level }).findings.filter((f) => f.end > f.start);
      const caught = edits.filter((e) => fs.some((f) => touches(f, e)));
      t.edits += edits.length; t.caught += caught.length; t.fs += fs.length;
      t.caughtFix += edits.filter((e) => fs.some((f) => f.rule.kind !== 'check' && touches(f, e))).length;
      t.extra += fs.filter((f) => !edits.some((e) => touches(f, e))).length;
      if (detail && level === 2 && docs.length <= 5) {
        for (const f of fs) console.log(`    ${edits.some((e) => touches(f, e)) ? '○' : '×'} ${f.rule.kind} ${f.area} 「${f.text.slice(0, 20)}」 ${f.rule.label}${f.info ? ' / ' + f.info : ''}`);
        for (const e of edits.filter((x) => !caught.includes(x))) console.log(`    未 「${e.del.slice(0, 20)}」→「${e.ins.slice(0, 20)}」`);
      }
    }
    console.log(`  ${name} ${docs.length}本 level${level}: 本部の直し ${t.edits}か所・拾えた ${t.caught}（${pct(t.caught, t.edits)}%、直す・形だけで ${t.caughtFix}）・光った ${t.fs}・余計な指摘 ${t.extra}（${pct(t.extra, t.fs)}%）`);
    if (level === 2) Object.assign(total, { edits: total.edits + t.edits, caught: total.caught + t.caught, caughtFix: total.caughtFix + t.caughtFix, findings: total.findings + t.fs, extra: total.extra + t.extra });
  }
}
if (files.length > 1) console.log(`  合計（level2）: 本部の直し ${total.edits}・拾えた ${total.caught}（直す・形だけで ${total.caughtFix}）・光った ${total.findings}・余計な指摘 ${total.extra}`);

// (4) 実原稿（_test/real/*.json。{title, orig:[段落], desk:[段落]}。公開しないので手元にあるときだけ）
console.log('(4) 実原稿');
const realDir = join(testDir, 'real');
const reals = existsSync(realDir) ? readdirSync(realDir).filter((f) => f.endsWith('.json')) : [];
if (!reals.length) console.log('  _test/real/*.json がない（飛ばす）');
for (const f of reals) {
  const d = JSON.parse(readFileSync(join(realDir, f), 'utf8'));
  const text = d.orig.join('\n');
  for (const level of [1, 2]) {
    const list = eng.check(text, { level }).findings;
    console.log(`  ${d.title} level${level}: ${list.length}件（直す${count(list, 'fix')}・確かめる${count(list, 'check')}・形${count(list, 'form')}）`);
    console.log('    ' + list.map((x) => `${x.rule.kind}${x.down ? '(' + x.down + ')' : ''} ${x.rule.builtin || x.rule.label}「${x.text.slice(0, 12)}」`).join('、'));
  }
}

console.log(failures ? `失敗 ${failures}件` : '失敗 0件');
process.exit(failures ? 1 : 0);
