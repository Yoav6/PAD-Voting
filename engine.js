/* PAD voting engine.
 * Loaded by the page as a normal script, and again as a Web Worker that computes the odds.
 * A ballot is an array of marks, one per option: 0 = not approved, 1 = approved, 2 = approved with Defer.
 */
(function (global) {
  'use strict';

  // Index of the option with the most OVs, or -1 when the top is tied.
  function leaderOf(ov) {
    let best = -1, max = -Infinity, tie = false;
    for (let i = 0; i < ov.length; i++) {
      if (ov[i] > max) { max = ov[i]; best = i; tie = false; }
      else if (ov[i] === max) tie = true;
    }
    return tie ? -1 : best;
  }

  // Draw one ballot: OVs first, then the leader, then EVs (at most one per option).
  function applyBallot(ov, ev, marks) {
    const k = ov.length;
    const res = {
      ov: ov.slice(), ev: ev.slice(), leader: -1, tie: false, blank: true,
      direct: [], deferred: [], deferTo: -1, gains: [], winner: -1, tiedAtTop: [],
    };
    for (let i = 0; i < k; i++) if (marks[i]) { res.ov[i]++; res.blank = false; }
    res.leader = leaderOf(res.ov);
    if (res.blank) return res;
    res.tie = res.leader < 0;

    const gain = new Uint8Array(k);
    for (let i = 0; i < k; i++) {
      if (!marks[i]) continue;
      if (marks[i] === 2 && !res.tie) res.deferred.push(i);
      else { gain[i] = 1; res.direct.push(i); }
    }
    if (res.deferred.length) { res.deferTo = res.leader; gain[res.leader] = 1; }
    for (let i = 0; i < k; i++) {
      if (!gain[i]) continue;
      res.ev[i]++;
      res.gains.push(i);
    }
    // An option wins once it holds the most EVs alone, with at least 3. A tie at the top keeps the draw going.
    const top = Math.max(...res.ev);
    if (top >= 3 && res.gains.some(i => res.ev[i] === top)) {
      const atTop = res.ev.map((v, i) => (v === top ? i : -1)).filter(i => i >= 0);
      if (atTop.length === 1) res.winner = atTop[0];
      else res.tiedAtTop = atTop;
    }
    return res;
  }

  // The box ran out with no clear winner: most EVs, then most OVs. Returns every option still tied.
  function fallbackWinners(ov, ev) {
    let cand = ov.map((_, i) => i);
    const topEv = Math.max(...cand.map(i => ev[i]));
    cand = cand.filter(i => ev[i] === topEv);
    const topOv = Math.max(...cand.map(i => ov[i]));
    return cand.filter(i => ov[i] === topOv);
  }

  function credit(out, winners, p) {
    const share = p / winners.length;
    for (const w of winners) out[w] += share;
  }

  // Exact win probabilities over every possible draw order (ballots drawn without replacement).
  // Blank ballots never change anything, so they are left out of `types` by the caller.
  // OVs are fully determined by which ballots are out of the box, so the memo key is remaining counts + EVs.
  function solveExact(types, rem, ov, ev, budget) {
    const k = ov.length;
    const memo = new Map();
    let nodes = 0;
    const OVER = {};

    function rec(total, ov, ev) {
      if (total === 0) {
        const out = new Float64Array(k);
        credit(out, fallbackWinners(ov, ev), 1);
        return out;
      }
      const key = rem.join(',') + '|' + ev.join(',');
      const hit = memo.get(key);
      if (hit) return hit;
      if (++nodes > budget) throw OVER;

      const out = new Float64Array(k);
      for (let t = 0; t < types.length; t++) {
        if (!rem[t]) continue;
        const p = rem[t] / total;
        const r = applyBallot(ov, ev, types[t]);
        if (r.winner >= 0) { out[r.winner] += p; continue; }
        rem[t]--;
        const sub = rec(total - 1, r.ov, r.ev);
        rem[t]++;
        for (let i = 0; i < k; i++) out[i] += p * sub[i];
      }
      memo.set(key, out);
      return out;
    }

    try {
      return Array.from(rec(rem.reduce((a, b) => a + b, 0), ov, ev));
    } catch (e) {
      if (e === OVER) return null;
      throw e;
    }
  }

  // Fallback when there are too many paths to enumerate: simulate lots of draws.
  function monteCarlo(types, rem, ov, ev, maxSims, maxMs) {
    const k = ov.length;
    const out = new Float64Array(k);
    const start = Date.now();
    const total0 = rem.reduce((a, b) => a + b, 0);
    let sims = 0;
    while (sims < maxSims && (sims % 2000 || Date.now() - start < maxMs)) {
      const r = rem.slice();
      let total = total0, o = ov, e = ev;
      for (;;) {
        if (total === 0) { credit(out, fallbackWinners(o, e), 1); break; }
        let x = Math.random() * total, t = 0;
        while (x >= r[t]) { x -= r[t]; t++; }
        r[t]--; total--;
        const res = applyBallot(o, e, types[t]);
        if (res.winner >= 0) { out[res.winner]++; break; }
        o = res.ov; e = res.ev;
      }
      sims++;
    }
    return { probs: Array.from(out, v => v / sims), sims };
  }

  function computeOdds(req) {
    const { types, rem, ov, ev } = req;
    const probs = solveExact(types, rem.slice(), ov, ev, 300000);
    if (probs) return { probs, method: 'exact' };
    const mc = monteCarlo(types, rem, ov, ev, 400000, 1500);
    return { probs: mc.probs, method: 'montecarlo', sims: mc.sims };
  }

  const PAD = { leaderOf, applyBallot, fallbackWinners, solveExact, monteCarlo, computeOdds };
  global.PAD = PAD;

  if (typeof importScripts === 'function' && typeof document === 'undefined') {
    global.onmessage = e => {
      const { id, req } = e.data;
      global.postMessage({ id, res: computeOdds(req) });
    };
  }
})(typeof self !== 'undefined' ? self : this);
