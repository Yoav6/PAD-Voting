'use strict';

const MAX_OPTIONS = 8;
const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sum = a => a.reduce((x, y) => x + y, 0);
const pad2 = n => String(n).padStart(2, '0');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
let uid = 1;
const newId = () => 'id' + uid++;

const DEFAULT_SETUP = {
  o: [['Riverside Park', 0], ['New Library', 1], ['Bike Lanes', 2], ['Community Pool', 3]],
  b: [
    [[1, 2, 0, 0], 30],
    [[0, 1, 1, 0], 25],
    [[0, 0, 2, 2], 20],
    [[0, 0, 0, 1], 15],
    [[2, 0, 1, 0], 10],
  ],
  m: 'count',
  n: 1000,
};

const S = { options: [], ballots: [], mode: 'count', total: 1000 };

/* ---------------- state & persistence ---------------- */

function fromPlain(p) {
  const used = new Set();
  S.options = (p.o || []).slice(0, MAX_OPTIONS).map(([name, color]) => {
    let c = Number.isInteger(color) && color >= 0 && color < MAX_OPTIONS && !used.has(color) ? color : -1;
    if (c < 0) c = [...Array(MAX_OPTIONS).keys()].find(i => !used.has(i));
    used.add(c);
    return { id: newId(), name: String(name || '').slice(0, 40), color: c };
  });
  S.ballots = (p.b || []).map(([marks, copies]) => ({
    id: newId(),
    marks: Object.fromEntries(S.options.map((o, i) => [o.id, [0, 1, 2].includes(marks?.[i]) ? marks[i] : 0])),
    copies: Math.max(0, +copies || 0),
  }));
  S.mode = p.m === 'percent' ? 'percent' : 'count';
  S.total = Math.min(100000, Math.max(1, Math.floor(+p.n) || 1000));
}

function toPlain() {
  return {
    o: S.options.map(o => [o.name, o.color]),
    b: S.ballots.map(b => [marksOf(b), b.copies]),
    m: S.mode,
    n: S.total,
  };
}

function save() {
  history.replaceState(null, '', '#s=' + encodeURIComponent(JSON.stringify(toPlain())));
}

function load() {
  const m = location.hash.match(/^#s=(.*)$/);
  if (m) {
    try { fromPlain(JSON.parse(decodeURIComponent(m[1]))); if (S.options.length) return; } catch (e) { /* fall through */ }
  }
  fromPlain(DEFAULT_SETUP);
}

const marksOf = b => S.options.map(o => b.marks[o.id] || 0);
const isBlank = b => !S.options.some(o => b.marks[o.id]);
const optName = i => S.options[i].name || `Option ${i + 1}`;
const sw = i => `--sw: var(--c${S.options[i].color})`;

// How many voters cast each ballot. Percentages are turned into whole voters by largest remainder.
function ballotCounts() {
  if (S.mode === 'count') return S.ballots.map(b => Math.max(0, Math.floor(b.copies || 0)));
  const pcts = S.ballots.map(b => Math.max(0, +b.copies || 0));
  const total = sum(pcts);
  if (!total) return pcts.map(() => 0);
  const raw = pcts.map(p => (p / total) * S.total);
  const counts = raw.map(Math.floor);
  let left = S.total - sum(counts);
  raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { counts[i]++; left--; } });
  return counts;
}

/* ---------------- odds (in a worker when possible) ---------------- */

let worker = null;
const pending = new Map();
let reqSeq = 0;
try {
  worker = new Worker('engine.js');
  worker.onmessage = e => {
    const p = pending.get(e.data.id);
    pending.delete(e.data.id);
    if (p) p.cb(e.data.res);
  };
  worker.onerror = () => {
    // e.g. opened from file:// — fall back to computing on the page
    worker = null;
    for (const [id, { req, cb }] of [...pending]) { pending.delete(id); cb(PAD.computeOdds(req)); }
  };
} catch (e) { worker = null; }

function runOdds(req, cb) {
  const id = ++reqSeq;
  if (worker) {
    pending.set(id, { req, cb });
    worker.postMessage({ id, req });
  } else {
    setTimeout(() => cb(PAD.computeOdds(req)), 0);
  }
}

// Only ballots that approve something matter for the odds; blank ones never change the state.
function oddsRequest(counts, ov, ev) {
  const types = [], rem = [];
  S.ballots.forEach((b, i) => {
    if (!isBlank(b) && counts[i] > 0) { types.push(marksOf(b)); rem.push(counts[i]); }
  });
  return { types, rem, ov, ev };
}

// The full count of approvals, made before the draw.
const fullCount = () => PAD.countOvs(S.ballots.map(marksOf), ballotCounts());

const odds = { prior: null, now: null, version: 0, loading: false };
let oddsTimer = null;

function schedulePriorOdds() {
  const v = ++odds.version;
  odds.prior = null;
  odds.loading = true;
  clearTimeout(oddsTimer);
  oddsTimer = setTimeout(() => {
    const k = S.options.length;
    const req = oddsRequest(ballotCounts(), fullCount(), Array(k).fill(0));
    if (!req.types.length) { odds.loading = false; renderOdds(); return; }
    runOdds(req, res => {
      if (v !== odds.version) return;
      odds.prior = res;
      odds.loading = false;
      renderOdds();
    });
  }, 220);
  renderOdds();
}

function requestNowOdds() {
  if (!draw) return;
  if (draw.done) {
    odds.now = { probs: S.options.map((_, i) => (i === draw.winner ? 1 : 0)), method: 'final' };
    renderOdds();
    return;
  }
  const d = draw, entry = d.last;
  if (entry?.odds) { odds.now = entry.odds; odds.loading = false; renderOdds(); return; }
  odds.loading = true;
  runOdds(oddsRequest(d.rem, d.ov, d.ev), res => {
    if (entry) entry.odds = res;
    if (draw !== d || d.last !== entry) return;
    odds.now = res;
    odds.loading = false;
    renderOdds();
  });
  renderOdds();
}

/* ---------------- the live draw ---------------- */

let draw = null;
let autoTimer = null;

function randInt(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return buf[0] % n;
}

function newDraw() {
  const counts = ballotCounts();
  const k = S.options.length;
  const start = {
    rem: counts.slice(),
    total: sum(counts),
    nonBlank: sum(counts.filter((_, i) => !isBlank(S.ballots[i]))),
    ov: fullCount(),
    ev: Array(k).fill(0),
  };
  return {
    ...start,
    rem: counts.slice(),
    start,
    step: 0,
    log: [],
    last: null,
    done: false,
    winner: -1,
  };
}

function canDraw() {
  if (draw) return !draw.done;
  const counts = ballotCounts();
  return S.ballots.some((b, i) => !isBlank(b) && counts[i] > 0);
}

function drawOne(quiet = false) {
  if (!canDraw()) return;
  if (!draw) draw = newDraw();
  const d = draw;
  d.log.length = d.step; // drawing from the middle of the record forgets everything after it
  let x = randInt(d.total), b = 0;
  while (x >= d.rem[b]) { x -= d.rem[b]; b++; }
  d.rem[b]--;
  d.total--;
  const marks = marksOf(S.ballots[b]);
  const res = PAD.applyBallot(d.ov, d.ev, marks);
  if (!res.blank) d.nonBlank--;
  d.ev = res.ev;
  d.step++;
  const entry = { step: d.step, ballot: b, marks, res, outcome: null };

  if (res.winner >= 0) {
    entry.outcome = { kind: 'ev', winner: res.winner, among: [res.winner] };
  } else if (d.nonBlank === 0) {
    const c = PAD.fallbackWinners(d.ov, d.ev);
    entry.outcome = { kind: 'exhausted', winner: c.length === 1 ? c[0] : c[randInt(c.length)], among: c };
  }
  if (entry.outcome) { d.done = true; d.winner = entry.outcome.winner; stopAuto(); }
  entry.after = { rem: d.rem.slice(), total: d.total, nonBlank: d.nonBlank, ov: d.ov, ev: d.ev };
  d.log.push(entry);
  d.last = entry;
  if (quiet) return;
  renderDraw(true);
  requestNowOdds();
}

// Draw silently until someone wins, then show the final ballot.
function finishInstantly() {
  if (!canDraw()) return;
  stopAuto();
  while (canDraw()) drawOne(true);
  renderDraw(true);
  requestNowOdds();
}

// Step through the record: show the state right after draw #pos (0 = before any draw).
function goTo(pos) {
  const d = draw;
  if (!d || pos < 0 || pos > d.log.length || pos === d.step) return;
  stopAuto();
  const s = pos ? d.log[pos - 1].after : d.start;
  Object.assign(d, { rem: s.rem.slice(), total: s.total, nonBlank: s.nonBlank, ov: s.ov, ev: s.ev, step: pos });
  d.last = pos ? d.log[pos - 1] : null;
  d.done = !!d.last?.outcome;
  d.winner = d.done ? d.last.outcome.winner : -1;
  if (!pos) odds.now = null;
  renderDraw(false);
  if (pos) requestNowOdds(); else renderOdds();
}

function resetDraw() {
  stopAuto();
  draw = null;
  odds.now = null;
  renderDraw(false);
  renderOdds();
}

function startAuto() {
  if (!canDraw()) return;
  drawOne();
  if (draw && !draw.done) autoTimer = setInterval(() => (draw && !draw.done ? drawOne() : stopAuto()), +$('#speed').value);
  renderControls();
}
function stopAuto() {
  clearInterval(autoTimer);
  autoTimer = null;
  renderControls();
}

/* ---------------- rendering: options ---------------- */

function renderOptions() {
  $('#options').innerHTML = S.options.map((o, i) => `
    <li class="option" data-id="${o.id}">
      <span class="letter" style="${sw(i)}" aria-hidden="true"></span>
      <input type="text" value="${esc(o.name)}" maxlength="40" aria-label="Option ${i + 1} name" placeholder="Option ${i + 1}">
      <button class="icon-btn" type="button" data-act="remove-option" title="Remove option" aria-label="Remove ${esc(optName(i))}" ${S.options.length <= 1 ? 'disabled' : ''}>✕</button>
    </li>`).join('');
  const full = S.options.length >= MAX_OPTIONS;
  $('#addOption button').disabled = full;
  $('#newOptionName').disabled = full;
  $('#optionHint').textContent = full ? `That's the maximum of ${MAX_OPTIONS} options.` : '';
}

/* ---------------- rendering: ballots ---------------- */

function renderBallots() {
  const opts = S.options;
  const cards = S.ballots.map((b, bi) => `
    <article class="ballot ${isBlank(b) ? 'is-blank' : ''}" data-id="${b.id}">
      <div class="stub"><span class="serial">№ ${pad2(bi + 1)}</span><span class="stub-label">Ballot</span></div>
      <div class="ballot-body">
        <div class="ballot-head">
          <span class="title">Ballot ${pad2(bi + 1)}</span>
          <span class="actions">
            <button class="icon-btn" type="button" data-act="dup" title="Duplicate ballot" aria-label="Duplicate ballot ${bi + 1}">⧉</button>
            <button class="icon-btn" type="button" data-act="del" title="Delete ballot" aria-label="Delete ballot ${bi + 1}">✕</button>
          </span>
        </div>
        <div class="col-heads"><span>Vote</span><span>Option</span><span>Defer</span></div>
        <ul class="ballot-rows">
          ${opts.map((o, i) => {
            const m = b.marks[o.id] || 0;
            return `<li data-opt="${o.id}">
              <button class="oval" type="button" data-act="approve" aria-pressed="${m > 0}" aria-label="Approve ${esc(optName(i))}"></button>
              <span class="opt-name"><i class="swatch" style="${sw(i)}"></i><span>${esc(optName(i))}</span></span>
              <button class="tick" type="button" data-act="defer" aria-pressed="${m === 2}" aria-label="Defer ${esc(optName(i))} to the leader" title="Defer this approval to the current leader"></button>
            </li>`;
          }).join('')}
        </ul>
        <div class="copies">
          <label>${S.mode === 'count' ? 'Cast by' : 'Share'}
            <input type="number" data-act="copies" min="0" ${S.mode === 'count' ? 'step="1"' : 'step="0.1" max="100"'} value="${b.copies}" aria-label="${S.mode === 'count' ? 'Number of voters' : 'Percent of voters'} for ballot ${bi + 1}">
            ${S.mode === 'count' ? 'voters' : '%'}
          </label>
          <span class="share" data-share></span>
        </div>
      </div>
    </article>`).join('');
  $('#ballots').innerHTML = cards + `
    <button class="ballot add-card" type="button" data-act="add-ballot"><span class="plus">+</span>Add a ballot</button>`;
  renderShares();
}

// The small numbers that depend on all ballots at once: per-ballot share and the totals line.
function renderShares() {
  const counts = ballotCounts();
  const total = sum(counts);
  document.querySelectorAll('#ballots .ballot[data-id]').forEach((el, i) => {
    const s = el.querySelector('[data-share]');
    if (S.mode === 'count') s.textContent = total ? `${((counts[i] / total) * 100).toFixed(1)}% of voters` : '';
    else s.textContent = `≈ ${counts[i].toLocaleString()} voter${counts[i] === 1 ? '' : 's'}`;
  });
  const t = $('#totals');
  if (!S.ballots.length) { t.innerHTML = 'No ballots yet. Add one to get started.'; return; }
  const types = `${S.ballots.length} ballot type${S.ballots.length === 1 ? '' : 's'}`;
  if (S.mode === 'count') {
    t.innerHTML = `<b>${total.toLocaleString()}</b> voter${total === 1 ? '' : 's'} in total, across ${types}.`;
  } else {
    const pct = sum(S.ballots.map(b => Math.max(0, +b.copies || 0)));
    const off = Math.abs(pct - 100) > 0.05;
    t.innerHTML = `Shares add up to <b>${+pct.toFixed(1)}%</b> of ${S.total.toLocaleString()} voters, across ${types}.` +
      (off && pct > 0 ? ` <span class="warn">Not 100%, so the shares are scaled to fill all ${S.total.toLocaleString()} voters.</span>` : '');
  }
}

/* ---------------- rendering: the draw ---------------- */

function nameTag(i) {
  return `<span class="name-tag"><i class="swatch" style="${sw(i)}"></i>${esc(optName(i))}</span>`;
}
const listNames = idx => idx.map(nameTag).join(', ');

const CHECK = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7.5l3 3 6-7"/></svg>';

function renderTally(animate) {
  const k = S.options.length;
  const ov = draw ? draw.ov : fullCount();
  const ev = draw ? draw.ev : Array(k).fill(0);
  const leader = sum(ov) ? PAD.leaderOf(ov) : -1;
  const gains = animate && draw?.last ? draw.last.res.gains : [];
  const rows = S.options.map((o, i) => {
    const isWin = draw?.done && draw.winner === i;
    return `<div class="tally-row ${isWin ? 'is-winner' : ''} ${gains.includes(i) ? 'gained' : ''}">
      <div class="tally-name"><i class="swatch" style="${sw(i)}"></i><span class="n">${esc(optName(i))}</span>${leader === i && !draw?.done ? '<span class="leads">Leads</span>' : ''}${isWin ? '<span class="stamp">Elected</span>' : ''}</div>
      <div class="ov" title="${ov[i]} original vote${ov[i] === 1 ? '' : 's'}"><span class="num">${ov[i]}</span></div>
      <div class="evs" title="${ev[i]} effective vote${ev[i] === 1 ? '' : 's'}">
        ${[0, 1].map(j => `<span class="evbox ${ev[i] > j ? 'on' : ''} ${gains.includes(i) && ev[i] === j + 1 ? 'new' : ''}" style="${sw(i)}">${CHECK}</span>`).join('')}${ev[i] > 2 ? `<span class="evmore">+${ev[i] - 2}</span>` : ''}
      </div>
    </div>`;
  }).join('');
  let note = '';
  if (sum(ov) && leader < 0 && !draw?.done) note = '<p class="tally-note">No leader: the full count is tied at the top, so Defer marks will be ignored.</p>';
  $('#tally').innerHTML = `<div class="tally-row head"><span>Option</span><span>OV</span><span>EV</span></div>${rows}${note}`;
}

function slipHtml(entry) {
  const { marks, ballot, step } = entry;
  const blank = !marks.some(Boolean);
  return `<div class="slip rise">
    <div class="slip-head"><span class="title">Ballot ${pad2(ballot + 1)}</span><span class="serial">Draw #${step}</span></div>
    <ul>${S.options.map((o, i) => `<li>
      <span class="oval" aria-pressed="${marks[i] > 0}"></span>
      <span class="opt-name"><i class="swatch" style="${sw(i)}"></i><span>${esc(optName(i))}</span></span>
      ${marks[i] === 2 ? '<span class="defer-ref"><i class="tick on" aria-hidden="true"></i>Defer</span>' : '<span></span>'}
    </li>`).join('')}</ul>
    ${blank ? '<p class="blank-note">Blank ballot: approves nothing.</p>' : ''}
  </div>`;
}

function explainHtml(entry) {
  const { res, marks } = entry;
  const lines = [];
  if (res.blank) {
    lines.push(['Result', 'A blank ballot. It approves nothing, so nothing changes.']);
  } else {
    const anyDefer = marks.some(m => m === 2);
    if (anyDefer) {
      if (res.leader >= 0) lines.push(['Leader', `${nameTag(res.leader)}, with ${plural(res.ov[res.leader], 'OV')} in the full count.`]);
      else {
        const top = Math.max(...res.ov);
        lines.push(['Leader', `None. ${listNames(res.ov.map((v, i) => (v === top ? i : -1)).filter(i => i >= 0))} are tied at ${plural(top, 'OV')} in the full count.`]);
      }
    }
    if (res.tie && anyDefer) lines.push(['EVs', `With no leader, the Defer marks are ignored: +1 to ${listNames(res.direct)}.`]);
    else {
      const parts = [];
      if (res.direct.length) parts.push(`+1 to ${listNames(res.direct)} (approved directly).`);
      if (res.deferred.length) {
        const already = res.direct.includes(res.deferTo);
        parts.push(`${listNames(res.deferred)} marked Defer, so ${already
          ? `the support defers to the leader ${nameTag(res.deferTo)}, which already got its EV from this ballot. Nothing extra.`
          : `the support defers to the leader: +1 to ${nameTag(res.deferTo)}.`}`);
      }
      lines.push(['EVs', parts.join(' ')]);
    }
  }
  const o = entry.outcome;
  if (!o && res.tiedAtTop.length) {
    lines.push(['Result', `${listNames(res.tiedAtTop)} are tied at ${plural(res.ev[res.tiedAtTop[0]], 'EV')}, so there's no clear winner yet. The draw goes on until one of them is ahead.`, true]);
  }
  if (o) {
    let text;
    if (o.kind === 'ev') text = res.ev[o.winner] === 3
      ? `${nameTag(o.winner)} reaches 3 EVs and wins.`
      : `${nameTag(o.winner)} pulls ahead with ${plural(res.ev[o.winner], 'EV')} and wins.`;
    else {
      const tiedOnEv = res.ev.filter(v => v === res.ev[o.winner]).length > 1;
      text = 'No ballots that approve anything are left. ' + (o.among.length > 1
        ? `${listNames(o.among)} are tied on EVs and OVs. Drawn by lot: ${nameTag(o.winner)} wins.`
        : `${nameTag(o.winner)} wins on ${tiedOnEv ? 'OVs, after a tie on EVs' : 'EVs'}.`);
    }
    lines.push(['Result', text, true]);
  }
  return `<h4>Draw #${entry.step}: ballot ${pad2(entry.ballot + 1)}</h4>
    <ol>${lines.map(([tag, html, out]) => `<li class="${out ? 'outcome' : ''}"><span class="tag">${tag}</span><span>${html}</span></li>`).join('')}</ol>`;
}

function renderControls() {
  const can = canDraw();
  $('#btnDraw').disabled = !can || !!autoTimer;
  $('#btnFinish').disabled = !can;
  $('#btnAuto').disabled = !can && !autoTimer;
  $('#btnAuto').textContent = autoTimer ? '❚❚ Pause' : '▶ Auto-draw';
  $('#btnReset').disabled = !draw;
  $('#logPrev').disabled = !draw || draw.step === 0;
  $('#logNext').disabled = !draw || draw.step >= draw.log.length;
}

function renderDraw(animate) {
  const counts = ballotCounts();
  const inBox = draw ? draw.total : sum(counts);
  $('#boxCount').innerHTML = `<b>${inBox.toLocaleString()}</b><br>ballot${inBox === 1 ? '' : 's'} in the box`;

  const drawn = $('#drawn'), explain = $('#explain');
  if (draw?.last) {
    drawn.innerHTML = slipHtml(draw.last);
    if (!animate) drawn.querySelector('.slip').classList.remove('rise');
    explain.innerHTML = explainHtml(draw.last);
    if (animate) {
      const box = $('.box');
      box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake');
    }
  } else {
    drawn.innerHTML = canDraw()
      ? `<p class="placeholder"><span class="big">The box is sealed</span>Press <b>Draw a ballot</b> to pull the first one out at random.</p>`
      : `<p class="placeholder"><span class="big">Nothing to count</span>Fill in at least one ballot and give it some voters.</p>`;
    explain.innerHTML = `<p class="hint">Each draw is explained here, step by step.</p>`;
  }

  renderTally(animate);
  renderLog();
  renderControls();
}

function renderLog() {
  const log = $('#log');
  if (!draw || !draw.log.length) {
    log.innerHTML = '<li class="log-empty">No ballots drawn yet.</li>';
    $('#logCount').textContent = '';
    return;
  }
  log.innerHTML = draw.log.map((e, i) => {
    const r = e.res;
    let what;
    if (r.blank) what = '<span class="muted">blank, no effect</span>';
    else {
      what = `<span>Approves ${e.marks.map((m, i) => (m ? i : -1)).filter(i => i >= 0).map(nameTag).join(' ')}</span>`;
      what += `<span class="ev-gain">EV ${r.gains.map(i => nameTag(i) + (i === r.deferTo && !r.direct.includes(i) ? ' <span class="muted">(deferred)</span>' : '')).join(' ')}</span>`;
    }
    const cls = i + 1 === draw.step ? 'current' : i >= draw.step ? 'future' : '';
    const final = e.outcome ? `<li class="final ${cls}"><span class="step"></span><span class="which">Result</span><span class="what">${nameTag(e.outcome.winner)} elected${e.outcome.kind === 'exhausted' ? ' (box ran out)' : ''}</span></li>` : '';
    return `<li class="${cls}" data-pos="${e.step}" title="Go to draw #${e.step}"><span class="step">#${e.step}</span><span class="which">№ ${pad2(e.ballot + 1)}</span><span class="what">${what}</span></li>${final}`;
  }).join('');
  const cur = log.querySelector('li.current');
  if (!cur || draw.step === draw.log.length) log.scrollTop = draw.step ? log.scrollHeight : 0;
  else if (cur.offsetTop < log.scrollTop) log.scrollTop = cur.offsetTop;
  else if (cur.offsetTop + cur.offsetHeight > log.scrollTop + log.clientHeight) log.scrollTop = cur.offsetTop + cur.offsetHeight - log.clientHeight;
  $('#logCount').textContent = draw.step === draw.log.length ? `${draw.step} drawn` : `at #${draw.step} of ${draw.log.length}`;
}

/* ---------------- rendering: odds chart ---------------- */

function fmtPct(p) {
  if (p == null) return '–';
  const v = p * 100;
  if (v === 0) return '0%';
  if (v < 0.1) return '<0.1%';
  if (v > 99.9 && v < 100) return '>99.9%';
  return v.toFixed(1) + '%';
}

function renderOdds() {
  const el = $('#odds');
  const prior = odds.prior?.probs;
  const live = draw && draw.step > 0;
  const now = live ? odds.now?.probs : null;
  const shown = live ? (now || null) : prior;

  $('#oddsTitle').textContent = live ? (draw.done ? 'Chance of winning: result' : 'Chance of winning, as of now') : 'Chance of winning';
  $('#oddsLegend').innerHTML = live
    ? `<span class="k"><span class="k-bar"></span>given the draws so far</span><span class="k"><span class="k-tick"></span>before the draw</span>`
    : '';

  const hasBallots = oddsRequest(ballotCounts(), [], []).types.length > 0;
  if (!hasBallots && !live) {
    el.innerHTML = '<p class="odds-empty">Mark at least one ballot and give it voters to see the odds.</p>';
    $('#oddsMethod').textContent = '';
    return;
  }
  el.classList.toggle('loading', odds.loading);
  const rows = S.options.map((o, i) => {
    const p = shown ? shown[i] : null;
    const pr = prior ? prior[i] : null;
    return `<div class="odds-row" data-i="${i}">
      <div class="odds-label"><i class="swatch" style="${sw(i)}"></i><span class="n">${esc(optName(i))}</span></div>
      <div class="odds-track">
        <div class="odds-bar" style="${sw(i)}; width:${p == null ? 0 : (p * 100).toFixed(3)}%"></div>
        ${live && pr != null ? `<div class="odds-prior" style="left:${(pr * 100).toFixed(3)}%"></div>` : ''}
      </div>
      <div class="odds-val">${fmtPct(p)}</div>
    </div>`;
  }).join('');
  el.innerHTML = rows + `<div class="odds-axis"><span></span><div class="ticks"><span style="left:0">0</span><span style="left:25%">25</span><span style="left:50%">50</span><span style="left:75%">75</span><span style="left:100%">100%</span></div><span></span></div>`;

  const res = live ? odds.now : odds.prior;
  let method = '';
  if (odds.loading && !res) method = 'Calculating…';
  else if (res?.method === 'exact') method = live
    ? 'Exact: every possible order of the remaining ballots, weighted by its probability.'
    : 'Exact: every possible order the ballots could be drawn in, weighted by its probability.';
  else if (res?.method === 'montecarlo') {
    const worst = Math.max(...res.probs.map(p => Math.sqrt((p * (1 - p)) / res.sims)));
    method = `Estimated from ${res.sims.toLocaleString()} simulated draws, accurate to about ±${(worst * 196).toFixed(1)} points.`;
  } else if (res?.method === 'final') method = 'The draw is over.';
  $('#oddsMethod').textContent = method;
}

/* ---------------- tooltip ---------------- */

const tip = $('#tooltip');
$('#odds').addEventListener('mousemove', e => {
  const row = e.target.closest('.odds-row');
  if (!row) { tip.hidden = true; return; }
  const i = +row.dataset.i;
  const live = draw && draw.step > 0;
  const prior = odds.prior?.probs?.[i];
  const now = odds.now?.probs?.[i];
  tip.innerHTML = `<b>${esc(optName(i))}</b><br>` + (live
    ? `${fmtPct(now)} given the ${draw.step} draw${draw.step === 1 ? '' : 's'} so far<br>${fmtPct(prior)} before the draw`
    : `${fmtPct(prior)} chance of winning`);
  tip.hidden = false;
  const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = x + 'px';
  tip.style.top = e.clientY + 16 + 'px';
});
$('#odds').addEventListener('mouseleave', () => { tip.hidden = true; });

/* ---------------- events ---------------- */

function configChanged({ options = false, ballots = true } = {}) {
  if (options) renderOptions();
  if (ballots) renderBallots(); else renderShares();
  resetDraw();
  schedulePriorOdds();
  save();
}

$('#options').addEventListener('input', e => {
  const li = e.target.closest('.option');
  const o = S.options.find(o => o.id === li.dataset.id);
  o.name = e.target.value;
  configChanged();
});
$('#options').addEventListener('click', e => {
  const btn = e.target.closest('[data-act="remove-option"]');
  if (!btn) return;
  const id = btn.closest('.option').dataset.id;
  S.options = S.options.filter(o => o.id !== id);
  S.ballots.forEach(b => delete b.marks[id]);
  configChanged({ options: true });
});
$('#addOption').addEventListener('submit', e => {
  e.preventDefault();
  if (S.options.length >= MAX_OPTIONS) return;
  const input = $('#newOptionName');
  const used = new Set(S.options.map(o => o.color));
  const color = [...Array(MAX_OPTIONS).keys()].find(i => !used.has(i));
  S.options.push({ id: newId(), name: input.value.trim() || `Option ${S.options.length + 1}`, color });
  input.value = '';
  configChanged({ options: true });
  if (S.options.length < MAX_OPTIONS) input.focus();
});

$('#ballots').addEventListener('click', e => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'add-ballot') {
    S.ballots.push({ id: newId(), marks: {}, copies: 10 });
    configChanged();
    const cards = document.querySelectorAll('#ballots .ballot[data-id]');
    cards[cards.length - 1]?.querySelector('.oval')?.focus();
    return;
  }
  const card = btn.closest('.ballot');
  const bi = S.ballots.findIndex(b => b.id === card?.dataset.id);
  if (bi < 0) return;
  const b = S.ballots[bi];
  if (act === 'del') S.ballots.splice(bi, 1);
  else if (act === 'dup') S.ballots.splice(bi + 1, 0, { id: newId(), marks: { ...b.marks }, copies: b.copies });
  else if (act === 'approve' || act === 'defer') {
    const optId = btn.closest('li').dataset.opt;
    const m = b.marks[optId] || 0;
    b.marks[optId] = act === 'approve' ? (m ? 0 : 1) : (m === 2 ? 1 : 2);
    // re-render just this card's marks so focus stays put
    const row = btn.closest('li');
    row.querySelector('.oval').setAttribute('aria-pressed', b.marks[optId] > 0);
    row.querySelector('.tick').setAttribute('aria-pressed', b.marks[optId] === 2);
    card.classList.toggle('is-blank', isBlank(b));
    configChanged({ ballots: false });
    return;
  } else return;
  configChanged();
});
$('#ballots').addEventListener('input', e => {
  if (e.target.dataset.act !== 'copies') return;
  const b = S.ballots.find(b => b.id === e.target.closest('.ballot').dataset.id);
  b.copies = Math.max(0, +e.target.value || 0);
  configChanged({ ballots: false });
});

document.querySelectorAll('.seg button').forEach(btn => btn.addEventListener('click', () => {
  const mode = btn.dataset.mode;
  if (mode === S.mode) return;
  if (mode === 'percent') {
    const counts = ballotCounts(), total = sum(counts);
    S.total = total || 1000;
    S.ballots.forEach((b, i) => { b.copies = total ? Math.round((counts[i] / total) * 1000) / 10 : 0; });
  } else {
    const counts = ballotCounts();
    S.ballots.forEach((b, i) => { b.copies = counts[i]; });
  }
  S.mode = mode;
  renderMode();
  configChanged();
}));
$('#electorate').addEventListener('input', e => {
  S.total = Math.min(100000, Math.max(1, Math.floor(+e.target.value) || 1));
  configChanged({ ballots: false });
});
function renderMode() {
  document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === S.mode));
  $('#electorateWrap').hidden = S.mode !== 'percent';
  $('#electorate').value = S.total;
}

$('#btnDraw').addEventListener('click', () => drawOne());
$('#btnAuto').addEventListener('click', () => (autoTimer ? stopAuto() : startAuto()));
$('#btnFinish').addEventListener('click', finishInstantly);
$('#btnReset').addEventListener('click', resetDraw);
$('#logPrev').addEventListener('click', () => goTo(draw.step - 1));
$('#logNext').addEventListener('click', () => goTo(draw.step + 1));
$('#log').addEventListener('click', e => {
  const li = e.target.closest('li[data-pos]');
  if (li) goTo(+li.dataset.pos);
});
$('#speed').addEventListener('change', () => { if (autoTimer) { stopAuto(); startAuto(); } });

$('#btnShare').addEventListener('click', async () => {
  save();
  const btn = $('#btnShare');
  try { await navigator.clipboard.writeText(location.href); btn.textContent = 'Link copied ✓'; }
  catch (e) { btn.textContent = 'Copy the address bar'; }
  setTimeout(() => { btn.textContent = 'Copy link to this setup'; }, 1800);
});

$('#themeToggle').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('pad-theme', root.dataset.theme); } catch (e) { /* ignore */ }
});
try { const t = localStorage.getItem('pad-theme'); if (t) document.documentElement.dataset.theme = t; } catch (e) { /* ignore */ }

/* ---------------- boot ---------------- */

load();
renderOptions();
renderMode();
renderBallots();
renderDraw(false);
schedulePriorOdds();
