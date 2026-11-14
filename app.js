import { deriveKey, decryptWithKey, storeKey, loadStoredKey, forgetKey } from './crypto.js?v=20261114163740';

// ------------------------------------------------------------------ state & helpers
const S = { ds: null, demo: null, real: null, blob: null, charts: [], wFilter: 'all', temp: null };
const $ = (sel) => document.querySelector(sel);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const pace = (s) => (s == null || !isFinite(s) ? '–' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`.replace(/:60$/, ':59'));
const clock = (s) => {
  if (s == null) return '–';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
};
const km = (x) => (x == null ? '–' : x.toFixed(1));
const day = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const shortDay = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const weekday = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long' });
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

// ------------------------------------------------------------------ site-wide period
const RANGE_KEY = 'grun.range.v2'; // v2: default changed to 3 months (old choices reset once)
const loadRange = () => { try { return JSON.parse(localStorage.getItem(RANGE_KEY)) || null; } catch (e) { return null; } };
S.range = loadRange() || { kind: 'months', n: 3 };
const addMonths = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setMonth(d.getMonth() + n); return d.toISOString().slice(0, 10); };
function rangeStart() {
  const r = S.range, to = S.ds.meta.to;
  if (r.kind === 'from') return r.from;
  if (r.kind === 'all') return S.ds.meta.from || '2000-01-01';
  return addMonths(to, -r.n);
}
const inRange = (iso) => iso >= rangeStart();
const rangeLabel = () => (S.range.kind === 'from' ? `since ${day(S.range.from)}` : S.range.kind === 'all' ? 'all time' : `last ${S.range.n} months`);
const ts = (iso) => +new Date(iso + 'T00:00:00');
function syncRangeCtl() {
  const r = S.range;
  $('#rangeSel').value = r.kind === 'months' ? `m${r.n}` : r.kind;
  $('#rangeFrom').hidden = r.kind !== 'from';
  if (r.kind === 'from') $('#rangeFrom').value = r.from;
}
function setRange(r) {
  S.range = r;
  try { localStorage.setItem(RANGE_KEY, JSON.stringify(r)); } catch (e) { /* not persisted */ }
  syncRangeCtl();
  route();
}
$('#rangeSel').addEventListener('change', (e) => {
  const v = e.target.value;
  if (v === 'all') setRange({ kind: 'all' });
  else if (v === 'from') setRange({ kind: 'from', from: S.range.kind === 'from' ? S.range.from : rangeStart() });
  else setRange({ kind: 'months', n: +v.slice(1) });
});
$('#rangeFrom').addEventListener('change', (e) => { if (e.target.value) setRange({ kind: 'from', from: e.target.value }); });

const TYPES = { easy: 1, threshold: 2, long: 3, vo2: 4, tempo: 5, race: 6, hard: 7 };
const TYPE_LABEL = { easy: 'Easy', threshold: 'Threshold', long: 'Long', vo2: 'VO2 / 4x4', tempo: 'Tempo', race: 'Race', hard: 'Hard' };
const typeColor = (t) => css(`--s${TYPES[t] || 8}`);
const typeTag = (t) => `<span class="type"><span class="dot" style="background:${typeColor(t)}"></span>${TYPE_LABEL[t] || t || '–'}</span>`;

// ------------------------------------------------------------------ heat
// Model paces/HRs are for ref_temp (15°C). Above it, two effects:
//  * the same pace costs more HR: +c bpm per °C (fitted from your steady runs)
//  * the same effort gives a slower pace: speed drops heat_pace (0.4 %) per °C (typical value
//    from heat studies). The HR for that effort = HR at 15°C + heat cost − the HR saved by
//    running slower (your own bpm-per-m/s slope between the easy and L2 anchors), never lower
//    than at 15°C.
const heatH = (t = S.temp) => Math.max(0, (t ?? S.ds.meta.ref_temp) - S.ds.meta.ref_temp);
const heatPace = () => S.ds.meta.heat_pace ?? 0.004;
const speedFactor = (t) => 1 - heatPace() * heatH(t);
function bpmPerMs(e) {
  const b = (e.lt2.hr - e.easy.hr) / Math.max(0.05, 1000 / e.lt2.pace - 1000 / e.easy.pace);
  return Math.min(60, Math.max(8, b));
}
// One target (pace + HR at 15°C) as it applies at temperature t (default: the slider).
function atTemp(p, hr, e = S.ds.current, t = S.temp) {
  const h = heatH(t), v = 1000 / p, v2 = v * speedFactor(t);
  return { pace: 1000 / v2, hr: Math.round(Math.max(hr, hr + S.ds.meta.heat.c * h - (v - v2) * bpmPerMs(e))),
    samePaceHr: Math.round(hr + S.ds.meta.heat.c * h) };
}
const hrAt = (hr) => Math.round(hr + S.ds.meta.heat.c * heatH()); // same pace, hotter
const raceAt = (sec, t = S.temp) => sec / speedFactor(t);

// Live-updating pieces: the temperature slider rewrites these in place (no page re-render).
const hrSpan = (p, hr) => `<span data-adj="hr" data-p="${p}" data-hr="${hr}">${atTemp(p, hr).hr}</span>`;
const paceSpan = (p, hr) => `<span data-adj="pace" data-p="${p}" data-hr="${hr}">${pace(atTemp(p, hr).pace)}</span>`;
const raceSpan = (sec) => `<span data-adj="race" data-t="${sec}">${clock(raceAt(sec))}</span>`;
const tempSpan = () => `<span data-temp>${S.temp ?? S.ds.meta.ref_temp}</span>`;
function heatNote() {
  const c = S.ds.current;
  if (!c || heatH() === 0) return `Paces and HR at ${S.ds.meta.ref_temp}°C. Move the slider to see a hotter day.`;
  const a = atTemp(c.lt2.pace, c.lt2.hr);
  return `At ${S.temp}°C, L2 effort ≈ <b>${pace(a.pace)}</b> /km @ ${a.hr} bpm; holding ${pace(c.lt2.pace)} would take ≈ ${a.samePaceHr} bpm.`;
}
function liveTemp() {
  document.querySelectorAll('[data-adj]').forEach((e) => {
    const d = e.dataset;
    if (d.adj === 'race') e.textContent = clock(raceAt(+d.t));
    else { const a = atTemp(+d.p, +d.hr); e.textContent = d.adj === 'pace' ? pace(a.pace) : a.hr; }
  });
  document.querySelectorAll('[data-temp]').forEach((e) => { e.textContent = S.temp; });
  const n = $('#heatNote'); if (n) n.innerHTML = heatNote();
  S.charts.filter((x) => x.temp).forEach(({ c, build }) => c.setOption({ ...build(), animation: false }));
}

// ------------------------------------------------------------------ charts
function base() {
  const ink2 = css('--ink-2'), muted = css('--muted'), grid = css('--grid'), axis = css('--axis');
  const axisStyle = {
    axisLine: { lineStyle: { color: axis } }, axisTick: { show: false },
    axisLabel: { color: muted, fontSize: 11 }, splitLine: { lineStyle: { color: grid } },
  };
  return {
    opt: {
      backgroundColor: 'transparent', animationDuration: 350,
      textStyle: { fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif', color: ink2 },
      grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
      tooltip: {
        backgroundColor: css('--surface'), borderColor: css('--border'), borderWidth: 1,
        textStyle: { color: css('--ink'), fontSize: 13 }, extraCssText: 'border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.14);',
      },
      legend: { top: 0, left: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10, textStyle: { color: ink2, fontSize: 12 } },
    },
    axisStyle,
  };
}

function chart(el, build, { temp = false } = {}) {
  const c = echarts.init(el, null, { renderer: 'canvas' });
  c.setOption(build());
  S.charts.push({ c, build, temp });
  return c;
}

function disposeCharts() { S.charts.forEach(({ c }) => c.dispose()); S.charts = []; }
window.addEventListener('resize', () => S.charts.forEach(({ c }) => c.resize()));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => route());

const paceAxis = (b, extra = {}) => ({
  type: 'value', inverse: true, scale: true, ...b.axisStyle,
  axisLabel: { ...b.axisStyle.axisLabel, formatter: (v) => pace(v) }, ...extra,
});
const timeAxis = (b) => ({ type: 'time', min: ts(rangeStart()), max: ts(S.ds.meta.to), splitNumber: innerWidth < 700 ? 3 : 6, ...b.axisStyle,
  axisLabel: { ...b.axisStyle.axisLabel, hideOverlap: true }, splitLine: { show: false } });
const line = (name, data, color, extra = {}) => ({
  name, type: 'line', data, showSymbol: false, symbolSize: 8, lineStyle: { width: 2, color },
  itemStyle: { color }, emphasis: { focus: 'series' }, ...extra,
});

// ------------------------------------------------------------------ pages
function tile({ label, value, unit = '', meta = '', delta = '', cls = '', dot = null, tags = [], href = null }) {
  const [open, close] = href ? [`<a class="card tile link ${cls}" href="${href}" title="Show these workouts">`, '</a>'] : [`<div class="card tile ${cls}">`, '</div>'];
  return `${open}
    <div class="label">${dot ? `<span class="dot" style="background:${dot}"></span>` : ''}${label}
      ${tags.map((t) => `<span class="tag ${t.cls || ''}">${t.text}</span>`).join('')}</div>
    <div class="value num">${value}<span class="unit">${unit}</span></div>
    ${meta ? `<div class="meta">${meta}</div>` : ''}
    ${delta}
  ${close}`;
}

function paceDelta(now, then, label = 'vs 8 weeks ago') {
  if (now == null || then == null) return '';
  const d = Math.round(then - now); // positive = faster now
  if (Math.abs(d) < 2) return `<div class="delta flat">≈ same ${label}</div>`;
  return `<div class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d)} s/km ${d > 0 ? 'faster' : 'slower'} ${label}</div>`;
}

function tempControl() {
  const m = S.ds.meta;
  return `<div class="temp-ctl"><label for="temp">Temperature</label>
    <input id="temp" type="range" min="${m.ref_temp}" max="40" step="1" value="${S.temp ?? m.ref_temp}">
    <span class="num" id="tempVal">${S.temp ?? m.ref_temp}°C</span>
    <span id="heatNote">${heatNote()}</span>
    <span class="muted">Per °C above ${m.ref_temp}°C: the same pace costs +${m.heat.c} bpm${m.heat.fitted ? ' (fitted from your runs)' : ' (default)'}, the same effort runs ${(heatPace() * 100).toFixed(1)}% slower.</span></div>`;
}
function bindTemp() {
  const el = $('#temp');
  if (el) el.addEventListener('input', () => { S.temp = +el.value; $('#tempVal').textContent = `${el.value}°C`; liveTemp(); });
}

function zoneTable(est) {
  const rows = est.zones.map((z, i) => {
    const slow = paceSpan(z.pace_slow, z.lo), fast = paceSpan(z.pace_fast, z.hi);
    const p = z.zone === 'I1' ? `slower than ${fast}` : z.zone === 'I5' ? `${slow} → ${fast}` : `${slow} – ${fast}`;
    return `<tr><td><span class="type"><span class="dot" style="background:${css(`--z${i + 1}`)}"></span>${z.zone} · ${z.name}</span></td>
      <td class="n">${hrSpan(z.pace_slow, z.lo)}–${hrSpan(z.pace_fast, z.hi)}</td><td class="n">${p}</td></tr>`;
  }).join('');
  return `<div class="table-wrap"><table><thead><tr><th>Zone</th><th class="n">HR (bpm)</th><th class="n">Pace (/km)</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function rolling(points, days, key) {
  return points.map((p) => {
    const win = points.filter((q) => q.date <= p.date && q.date > addDays(p.date, -days));
    return [p.date, win.reduce((a, q) => a + q[key], 0) / win.length];
  });
}

function pagePerformance() {
  const { current: c, estimates: E, sessions } = S.ds;
  if (!c) return ['<p class="pad muted">Not enough data yet.</p>', null];
  const start = rangeStart();
  const ER = E.filter((e) => e.date >= start);
  const real = E.filter((e) => !e.gap);
  const past = [...real].reverse().find((e) => e.date <= addDays(c.date, -56) && e.date >= addDays(c.date, -84));
  const v = (e, f) => (e.gap ? [e.date, null] : [e.date, f(e)]);
  const thrAll = sessions.filter((s) => s.type === 'threshold' && s.norm).map((s) => ({ ...s.norm, date: s.date, s }));
  const thr = thrAll.filter((p) => p.date >= start);
  const vo2 = sessions.filter((s) => s.type === 'vo2' && s.norm && s.date >= start).map((s) => ({ ...s.norm, date: s.date, s }));
  const staleTag = (k) => (c.stale.includes(k) ? [{ text: 'no recent data', cls: 'warn' }] : []);
  const raceDelta = (now, then) => {
    if (then == null) return '';
    const d = then - now;
    return `<div class="delta ${d > 2 ? 'up' : d < -2 ? 'down' : 'flat'}">${Math.abs(d) < 3 ? '≈ same' : `${d > 0 ? '▲' : '▼'} ${clock(Math.abs(d))} ${d > 0 ? 'faster' : 'slower'}`}</div>`;
  };

  const html = `
    <h1>Performance</h1>
    <p class="sub">Estimated from the last 8 weeks of training (recent weeks count more) · updated ${day(c.date)}</p>
    <div class="grid g5">
      <div class="card tile hero">
        <div class="label"><span>Estimated race times · ${tempSpan()}°C</span></div>
        <div class="races">
          <div><div class="value num">${raceSpan(c.t5k)}</div><div class="meta">5k</div>${raceDelta(c.t5k, past?.t5k)}</div>
          <div><div class="value num">${raceSpan(c.t10k)}</div><div class="meta">10k</div>${raceDelta(c.t10k, past?.t10k)}</div>
        </div>
        <div class="meta">VDOT ${c.vdot}${c.t5k_vo2 ? ` · 5k from L2 ${clock(c.t5k_lt2)}, from 4x4 ${clock(c.t5k_vo2)}` : ''} · change vs 8 weeks ago</div>
      </div>
      ${tile({ label: 'VO2max · 4x4', href: '#/workouts?type=vo2', dot: css('--s4'), value: paceSpan(c.vo2.pace, c.vo2.hr), unit: '/km', meta: `@ ${hrSpan(c.vo2.pace, c.vo2.hr)} bpm`,
        delta: paceDelta(c.vo2.pace, past?.vo2.pace), tags: c.vo2.source.startsWith('derived') ? [{ text: 'estimated from L2' }] : [] })}
      ${tile({ label: 'L2 threshold', href: '#/workouts?type=threshold', dot: css('--s2'), value: paceSpan(c.lt2.pace, c.lt2.hr), unit: '/km', meta: `@ ${hrSpan(c.lt2.pace, c.lt2.hr)} bpm · ${c.lt2.sessions} sessions`,
        delta: paceDelta(c.lt2.pace, past?.lt2.pace), tags: staleTag('lt2') })}
      ${tile({ label: 'Tempo', href: '#/workouts?type=tempo', dot: css('--s3'), value: paceSpan(c.tempo.pace, c.tempo.hr), unit: '/km', meta: `@ ${hrSpan(c.tempo.pace, c.tempo.hr)} bpm`, delta: paceDelta(c.tempo.pace, past?.tempo.pace) })}
      ${tile({ label: 'Easy', href: '#/workouts?type=easy', dot: css('--s1'), value: paceSpan(c.easy.pace, c.easy.hr), unit: '/km', meta: `@ ${hrSpan(c.easy.pace, c.easy.hr)} bpm`,
        delta: paceDelta(c.easy.pace, past?.easy.pace), tags: staleTag('easy') })}
    </div>
    <div class="row" style="margin-top:12px">${tempControl()}</div>

    <div class="grid g2 section-title">
      <div class="card"><h2>Estimated paces</h2><p class="sub">Weekly estimate at ${tempSpan()}°C, faster is up</p><div class="chart tall" id="cPaces"></div></div>
      <div class="card"><h2>Heart rate at each pace</h2><p class="sub">bpm at that effort at ${tempSpan()}°C</p><div class="chart tall" id="cHr"></div></div>
    </div>
    <div class="grid g2" style="margin-top:16px">
      <div class="card"><h2>L2 threshold sessions</h2><p class="sub">Rep pace corrected to your L2 heart rate (at ${S.ds.meta.ref_temp}°C) · line = 6-week average · dot size = minutes at threshold</p><div class="chart" id="cThr"></div></div>
      <div class="card"><h2>Estimated 5k and 10k</h2><p class="sub">Daniels VDOT from L2 pace${c.t5k_vo2 ? ' and 4x4 pace' : ''} · at ${tempSpan()}°C · faster is up</p><div class="chart" id="c5k"></div></div>
    </div>
    <div class="grid g2" style="margin-top:16px">
      <div class="card"><h2>VO2max / 4x4 sessions</h2><p class="sub">Average rep pace</p><div class="chart" id="cVo2"></div></div>
      <div class="card"><h2>Training paces</h2><p class="sub">Zones from your threshold HR ${Math.round(c.lt2_hr)} and max HR ${Math.round(c.hrmax)} · HR at ${tempSpan()}°C</p>${zoneTable(c)}</div>
    </div>`;

  const after = () => {
    bindTemp();
    const series = [['VO2max', 'vo2', '--s4'], ['L2 threshold', 'lt2', '--s2'], ['Tempo', 'tempo', '--s3'], ['Easy', 'easy', '--s1']];
    // Fixed axes covering 15–40°C so the lines visibly move with the slider.
    const okE = ER.filter((e) => !e.gap);
    const allP = okE.flatMap((e) => series.flatMap(([, k]) => [e[k].pace, atTemp(e[k].pace, e[k].hr, e, 40).pace]));
    const pMin = Math.floor(Math.min(...allP) / 30) * 30, pMax = Math.ceil(Math.max(...allP) / 30) * 30;
    chart($('#cPaces'), () => {
      const b = base();
      return { ...b.opt, tooltip: { ...b.opt.tooltip, trigger: 'axis', valueFormatter: (v) => `${pace(v)} /km` },
        grid: { ...b.opt.grid, right: 96 },
        xAxis: timeAxis(b), yAxis: paceAxis(b, okE.length ? { min: pMin, max: pMax, interval: 30 } : {}),
        series: series.map(([n, k, col]) => line(n, ER.map((e) => v(e, (x) => atTemp(x[k].pace, x[k].hr, x).pace)), css(col),
          { endLabel: { show: true, formatter: '{a}', color: css('--ink-2'), fontSize: 11 } })) };
    }, { temp: true });
    chart($('#cHr'), () => {
      const b = base();
      return { ...b.opt, tooltip: { ...b.opt.tooltip, trigger: 'axis', valueFormatter: (v) => `${v} bpm` },
        grid: { ...b.opt.grid, right: 96 },
        xAxis: timeAxis(b), yAxis: { type: 'value', min: 130, max: 190, interval: 10, ...b.axisStyle },
        series: series.map(([n, k, col]) => line(n, ER.map((e) => v(e, (x) => atTemp(x[k].pace, x[k].hr, x).hr)), css(col),
          { endLabel: { show: true, formatter: '{a}', color: css('--ink-2'), fontSize: 11 } })) };
    }, { temp: true });
    chart($('#cThr'), () => {
      const b = base();
      const pts = thr.map((p) => ({ value: [p.date, p.pace_at_lt2], p }));
      return { ...b.opt, legend: { ...b.opt.legend, data: ['Session', '6-week average'] },
        tooltip: { ...b.opt.tooltip, trigger: 'item', formatter: (x) => {
          if (!x.data.p) return `${shortDay(x.value[0])}<br>6-week average <b>${pace(x.value[1])}</b> /km`;
          const p = x.data.p;
          return `<b>${esc(p.s.name)}</b> · ${day(p.date)}<br>${p.reps} reps · ${p.work_min} min work${p.s.indoor ? ' · treadmill' : ''}
            <br>Rep pace ${pace(p.pace)} /km · HR ${p.hr ?? 'n/a'} · ${p.s.temp != null ? Math.round(p.s.temp) + '°C' : ''}
            <br>At L2 HR: <b>${pace(p.pace_at_lt2)}</b> /km`; } },
        xAxis: timeAxis(b), yAxis: paceAxis(b),
        series: [
          { name: 'Session', type: 'scatter', data: pts, symbolSize: (v, x) => 6 + Math.sqrt(x.data.p.work_min) * 1.6,
            itemStyle: { color: css('--s2'), borderColor: css('--surface'), borderWidth: 2 } },
          line('6-week average', rolling(thrAll, 42, 'pace_at_lt2').filter(([d]) => d >= start), css('--ink-2'), { smooth: 0.3, lineStyle: { width: 2, color: css('--ink-2') } }),
        ] };
    }).on('click', (x) => x.data?.p && (location.hash = `#/workouts/${x.data.p.s.id}`));
    chart($('#c5k'), () => {
      const b = base();
      const ya = (i, k) => {
        const vals = okE.flatMap((e) => [e[k], raceAt(e[k], 40)]);
        const step = [15, 30, 60, 120, 300, 600].find((x) => (Math.max(...vals) - Math.min(...vals)) / x <= 5) || 600;
        const lim = vals.length ? { min: Math.floor(Math.min(...vals) / step) * step, max: Math.ceil(Math.max(...vals) / step) * step } : { scale: true };
        return { type: 'value', gridIndex: i, inverse: true, ...lim, interval: step, ...b.axisStyle, axisLabel: { ...b.axisStyle.axisLabel, formatter: clock } };
      };
      const xa = (i, show) => ({ ...timeAxis(b), gridIndex: i, axisLabel: { ...b.axisStyle.axisLabel, show } });
      const lab = (t) => ({ type: 'text', left: 12, style: { text: t, fill: css('--ink-2'), fontSize: 12, fontWeight: 600 } });
      return { ...b.opt, tooltip: { ...b.opt.tooltip, trigger: 'axis', valueFormatter: (v) => clock(v) },
        legend: { show: false }, axisPointer: { link: [{ xAxisIndex: 'all' }] },
        grid: [{ left: 8, right: 16, top: 24, height: '34%', containLabel: true }, { left: 8, right: 16, top: '60%', bottom: 8, containLabel: true }],
        graphic: [{ ...lab('5k'), top: 0 }, { ...lab('10k'), top: '52%' }],
        xAxis: [xa(0, false), xa(1, true)], yAxis: [ya(0, 't5k'), ya(1, 't10k')],
        series: [line('5k', ER.map((e) => v(e, (x) => raceAt(x.t5k))), css('--s1')),
          line('10k', ER.map((e) => v(e, (x) => raceAt(x.t10k))), css('--s7'), { xAxisIndex: 1, yAxisIndex: 1 })] };
    }, { temp: true });
    chart($('#cVo2'), () => {
      const b = base();
      return { ...b.opt, legend: { show: false },
        tooltip: { ...b.opt.tooltip, trigger: 'item', formatter: (x) => { const p = x.data.p;
          return `<b>${esc(p.s.name)}</b> · ${day(p.date)}<br>${p.reps} reps · ${pace(p.pace)} /km · HR ${p.hr ?? 'n/a'}${p.s.indoor ? ' · treadmill' : ''}`; } },
        xAxis: timeAxis(b), yAxis: paceAxis(b),
        series: [{ name: '4x4', type: 'scatter', symbolSize: 12, data: vo2.map((p) => ({ value: [p.date, p.pace], p })),
          itemStyle: { color: css('--s4'), borderColor: css('--surface'), borderWidth: 2 } }],
        graphic: vo2.length ? [] : [{ type: 'text', left: 'center', top: 'middle', style: { text: 'No 4x4 sessions yet', fill: css('--muted') } }] };
    }).on('click', (x) => x.data?.p && (location.hash = `#/workouts/${x.data.p.s.id}`));
  };
  return [html, after];
}

function pageDashboard() {
  const { weekly: W, sessions } = S.ds;
  const today = S.ds.meta.to;
  const start = rangeStart();
  const wkStart = addDays(start, -((new Date(start + 'T12:00:00').getDay() + 6) % 7));
  const last = W.filter((w) => w.week >= wkStart);
  const inR = sessions.filter((s) => s.date >= start);
  const d28 = sessions.filter((s) => s.date > addDays(today, -28));
  const ytd = sessions.filter((s) => s.date.slice(0, 4) === today.slice(0, 4));
  const thisWeek = W[W.length - 1] || { km: 0, runs: 0 };
  const avg4 = W.slice(-5, -1).reduce((a, w) => a + w.km, 0) / 4;
  const hard = d28.reduce((a, s) => a + s.zone_s[3] + s.zone_s[4], 0);
  const easyShare = d28.reduce((a, s) => a + s.zone_s[0] + s.zone_s[1], 0) / Math.max(1, d28.reduce((a, s) => a + s.zone_s.reduce((x, y) => x + y, 0), 0));
  const effAll = sessions.filter((s) => s.eff_easy).map((s) => ({ date: s.date, v: s.eff_easy, s }));
  const eff = effAll.filter((p) => p.date >= start);

  const html = `
    <h1>Dashboard</h1><p class="sub">Training load and consistency</p>
    <div class="grid g4">
      ${tile({ label: 'This week', value: km(thisWeek.km), unit: ' km', meta: `${thisWeek.runs} runs` })}
      ${tile({ label: '4-week average', value: km(avg4), unit: ' km/wk', meta: `${d28.length} runs in 28 days` })}
      ${tile({ label: 'Threshold + VO2 time', value: Math.round(hard / 60), unit: ' min', meta: `last 28 days · ${Math.round(easyShare * 100)}% easy (I1–I2)` })}
      ${tile({ label: 'Selected period', value: Math.round(inR.reduce((a, s) => a + s.km, 0)), unit: ' km', meta: `${inR.length} runs ${rangeLabel()} · ${today.slice(0, 4)}: ${Math.round(ytd.reduce((a, s) => a + s.km, 0))} km` })}
    </div>
    <div class="grid g2 section-title">
      <div class="card"><h2>Weekly distance</h2><p class="sub">km per week · line = 4-week average</p><div class="chart" id="cKm"></div></div>
      <div class="card"><h2>Weekly time in zones</h2><p class="sub">minutes per week</p><div class="chart" id="cZw"></div></div>
    </div>
    <div class="card" style="margin-top:16px"><h2>Every run</h2><p class="sub">km per day, ${rangeLabel()}</p><div class="chart" id="cCal" style="height:150px"></div></div>
    <div class="card" style="margin-top:16px"><h2>Aerobic efficiency</h2><p class="sub">Easy-run pace at your easy HR (${Math.round(S.ds.current?.easy.hr ?? 140)} bpm at ${S.ds.meta.ref_temp}°C), heat-corrected · faster is up · line = 6-week median</p><div class="chart" id="cEff"></div></div>`;

  const after = () => {
    chart($('#cKm'), () => {
      const b = base();
      const avg = last.map((w, i) => [w.week, +(last.slice(Math.max(0, i - 3), i + 1).reduce((a, x) => a + x.km, 0) / Math.min(4, i + 1)).toFixed(1)]);
      return { ...b.opt, tooltip: { ...b.opt.tooltip, trigger: 'axis', valueFormatter: (v) => `${v} km` },
        xAxis: { type: 'category', data: last.map((w) => w.week), ...b.axisStyle, splitLine: { show: false },
          axisLabel: { ...b.axisStyle.axisLabel, formatter: shortDay } },
        yAxis: { type: 'value', ...b.axisStyle },
        series: [{ name: 'Distance', type: 'bar', data: last.map((w) => w.km), barMaxWidth: 14, itemStyle: { color: css('--s1'), borderRadius: [4, 4, 0, 0] } },
          line('4-week average', avg, css('--ink-2'), { smooth: 0.3 })] };
    });
    chart($('#cZw'), () => {
      const b = base();
      const w = last;
      const zn = (S.ds.zones || []).map((z) => `${z.zone} ${z.name}`);
      return { ...b.opt, tooltip: { ...b.opt.tooltip, trigger: 'axis', valueFormatter: (v) => `${v} min` },
        xAxis: { type: 'category', data: w.map((x) => x.week), ...b.axisStyle, splitLine: { show: false }, axisLabel: { ...b.axisStyle.axisLabel, formatter: shortDay } },
        yAxis: { type: 'value', ...b.axisStyle },
        series: zn.map((n, i) => ({ name: n, type: 'bar', stack: 'z', barMaxWidth: 16, data: w.map((x) => Math.round(x.zone_s[i] / 60)),
          itemStyle: { color: css(`--z${i + 1}`), borderColor: css('--surface'), borderWidth: 1, borderRadius: i === 4 ? [4, 4, 0, 0] : 0 } })) };
    });
    chart($('#cCal'), () => {
      const b = base();
      const perDay = {};
      sessions.forEach((s) => { perDay[s.date] = (perDay[s.date] || 0) + s.km; });
      const max = Math.max(5, ...Object.values(perDay));
      return { ...b.opt, tooltip: { ...b.opt.tooltip, formatter: (x) => `${day(x.value[0])}<br><b>${km(x.value[1])} km</b>` },
        visualMap: { show: false, min: 0, max, inRange: { color: [css('--z1'), css('--z5')] } },
        calendar: { range: [start, today], top: 24, left: 34, right: 8, cellSize: ['auto', 13], splitLine: { show: false },
          itemStyle: { color: css('--surface-2'), borderColor: css('--surface'), borderWidth: 2 },
          dayLabel: { color: css('--muted'), fontSize: 10, firstDay: 1, nameMap: ['', 'M', '', 'W', '', 'F', ''] },
          monthLabel: { color: css('--muted'), fontSize: 11 }, yearLabel: { show: false } },
        series: [{ type: 'heatmap', coordinateSystem: 'calendar', data: Object.entries(perDay).filter(([d]) => d >= start).map(([d, v]) => [d, +v.toFixed(1)]) }] };
    }).on('click', (x) => { const s = sessions.find((q) => q.date === x.value[0]); if (s) location.hash = `#/workouts/${s.id}`; });
    chart($('#cEff'), () => {
      const b = base();
      const med = eff.map((p) => { const w = effAll.filter((q) => q.date <= p.date && q.date > addDays(p.date, -42)).map((q) => q.v).sort((a, c) => a - c);
        return [p.date, w[Math.floor(w.length / 2)]]; });
      return { ...b.opt, legend: { ...b.opt.legend, data: ['Easy run', '6-week median'] },
        tooltip: { ...b.opt.tooltip, trigger: 'item', formatter: (x) => x.data.s ? `<b>${esc(x.data.s.name)}</b> · ${day(x.data.s.date)}<br>${pace(x.value[1])} /km at easy HR · ${x.data.s.temp != null ? Math.round(x.data.s.temp) + '°C' : ''}` : `6-week median ${pace(x.value[1])}` },
        xAxis: timeAxis(b), yAxis: paceAxis(b),
        series: [{ name: 'Easy run', type: 'scatter', symbolSize: 8, data: eff.map((p) => ({ value: [p.date, p.v], s: p.s })),
          itemStyle: { color: css('--s1'), opacity: 0.55 } },
          line('6-week median', med, css('--ink-2'), { smooth: 0.3 })] };
    }).on('click', (x) => x.data?.s && (location.hash = `#/workouts/${x.data.s.id}`));
  };
  return [html, after];
}

function pageWorkouts() {
  const all = S.ds.sessions.filter((s) => inRange(s.date)).reverse();
  const counts = all.reduce((a, s) => ((a[s.type] = (a[s.type] || 0) + 1), a), {});
  const review = all.filter((s) => s.needs_review).length;
  const list = all.filter((s) => S.wFilter === 'all' || (S.wFilter === 'review' ? s.needs_review : s.type === S.wFilter));
  const chips = [['all', `All ${all.length}`], ...Object.keys(TYPE_LABEL).filter((t) => counts[t]).map((t) => [t, `${TYPE_LABEL[t]} ${counts[t]}`]),
    ...(review ? [['review', `Needs review ${review}`]] : [])];
  const rows = list.slice(0, 400).map((s) => `<tr class="click" data-id="${s.id}">
      <td class="num">${weekday(s.date)} ${s.date} <span class="muted">${s.local_time}</span></td>
      <td>${esc(s.name)}${s.indoor ? ' <span class="tag">treadmill</span>' : ''}${s.needs_review ? ' <span class="tag warn">review</span>' : ''}</td>
      <td>${typeTag(s.type)}</td><td class="n">${km(s.km)}</td><td class="n">${clock(s.moving_s)}</td>
      <td class="n">${pace(s.pace)}</td><td class="n">${s.avg_hr ? Math.round(s.avg_hr) : '–'}</td>
      <td class="n">${s.temp != null && !s.indoor ? Math.round(s.temp) + '°' : '–'}</td><td>${esc(s.place || '–')}</td></tr>`).join('');
  const html = `<h1>Workouts</h1><p class="sub">${all.length} runs ${rangeLabel()} · click one for the HR and pace breakdown</p>
    <div class="filters">${chips.map(([k, l]) => `<button class="chip ${S.wFilter === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
    <div class="card table-wrap"><table><thead><tr><th>Date</th><th>Name</th><th>Type</th><th class="n">km</th><th class="n">Time</th><th class="n">Pace</th><th class="n">HR</th><th class="n">Temp</th><th>Place</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
  const after = () => {
    document.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => {
      S.wFilter = b.dataset.f;
      if (location.hash.includes('?')) history.replaceState(null, '', '#/workouts');
      route(); }));
    document.querySelectorAll('tr[data-id]').forEach((r) => r.addEventListener('click', () => (location.hash = `#/workouts/${r.dataset.id}`)));
  };
  return [html, after];
}

function pageWorkout(id) {
  const s = S.ds.sessions.find((x) => x.id === id);
  if (!s) return ['<p class="pad muted">Workout not found in this dataset.</p>', () => {}];
  const st = S.ds.streams[id];
  const reps = s.reps || [];
  const repRows = reps.map((r, i) => `<tr><td>${i + 1}</td><td class="n">${r.start != null ? clock(r.start) : '–'}</td><td class="n">${clock(r.dur)}</td>
      <td class="n">${pace(r.pace)}</td><td class="muted">${r.pace_source || ''}</td><td class="n">${r.hr ?? '–'}</td><td class="n">${r.hr_max ?? '–'}</td></tr>`).join('');
  const html = `<p><a href="#/workouts">← Workouts</a></p>
    <h1>${esc(s.name)}</h1><p class="sub">${day(s.date)} ${s.local_time} · ${esc(s.place || '')} ${typeTag(s.type)}</p>
    <div class="grid g4">
      ${tile({ label: 'Distance', value: km(s.km), unit: ' km', meta: `${clock(s.moving_s)} moving` })}
      ${tile({ label: 'Average pace', value: pace(s.pace), unit: '/km', meta: s.indoor ? 'treadmill' : '' })}
      ${tile({ label: 'Heart rate', value: s.avg_hr ? Math.round(s.avg_hr) : '–', unit: ' bpm', meta: `max ${s.max_hr ?? '–'}` })}
      ${tile({ label: s.indoor ? 'Indoors' : 'Weather', value: s.temp != null ? Math.round(s.temp) : '–', unit: '°C',
        meta: s.indoor ? (s.outdoor_temp != null ? `outside ${Math.round(s.outdoor_temp)}°C` : 'assumed') : `feels like · air ${s.outdoor_temp != null ? Math.round(s.outdoor_temp) + '°C' : '–'} · dew point ${s.dew ?? '–'}° · wind ${s.wind ?? '–'} km/h` })}
    </div>
    ${s.desc ? `<div class="section-title"><div class="desc">${esc(s.desc)}</div></div>` : ''}
    <div class="card section-title"><h2>Heart rate (top) and pace (bottom)</h2>
      <p class="sub">${reps.length ? `${reps.length} of ${s.planned_reps || reps.length} reps found · ${esc(s.rep_source || '')}${s.quality != null ? ` · match ${Math.round(s.quality * 100)}%` : ''}` : 'No structured reps'}${s.needs_review ? ' · <span class="tag warn">needs review</span>' : ''}</p>
      ${st ? '<div class="chart tall" id="cRun"></div>' : '<p class="muted">No HR/pace stream for this run in the Strava export (treadmill runs without GPS are exported empty). Summary values only.</p>'}
    </div>
    ${reps.length ? `<div class="card" style="margin-top:16px"><h2>Reps</h2><div class="table-wrap"><table><thead><tr><th>#</th><th class="n">Start</th><th class="n">Duration</th><th class="n">Pace</th><th>Pace from</th><th class="n">Settled HR</th><th class="n">Max HR</th></tr></thead><tbody>${repRows}</tbody></table></div></div>` : ''}
    ${s.note ? `<p class="muted">Note: ${esc(s.note)}</p>` : ''}`;
  const after = () => {
    if (!st) return;
    chart($('#cRun'), () => {
      const b = base();
      const areas = reps.filter((r) => r.start != null).map((r, i) => [{ xAxis: r.start / 60, name: `${i + 1}` }, { xAxis: (r.start + r.dur) / 60 }]);
      const mark = { silent: true, itemStyle: { color: css('--s2'), opacity: 0.12 }, label: { color: css('--muted'), fontSize: 11 }, data: areas };
      const hasPace = st.pace.some((p) => p != null);
      const xa = (i, show) => ({ type: 'value', gridIndex: i, min: 0, max: st.t[st.t.length - 1] / 60, ...b.axisStyle, splitLine: { show: false },
        axisLabel: { ...b.axisStyle.axisLabel, show, formatter: (v) => `${Math.round(v)}′` } });
      return { ...b.opt, legend: { show: false },
        axisPointer: { link: [{ xAxisIndex: 'all' }] },
        tooltip: { ...b.opt.tooltip, trigger: 'axis', formatter: (ps) => `${Math.floor(ps[0].value[0])} min<br>` +
          ps.map((p) => `${p.seriesName}: <b>${p.seriesName === 'Pace' ? pace(p.value[1]) + ' /km' : p.value[1] + ' bpm'}</b>`).join('<br>') },
        grid: hasPace ? [{ left: 8, right: 16, top: 16, height: '42%', containLabel: true }, { left: 8, right: 16, top: '58%', bottom: 8, containLabel: true }]
          : [{ left: 8, right: 16, top: 16, bottom: 8, containLabel: true }],
        xAxis: hasPace ? [xa(0, false), xa(1, true)] : [xa(0, true)],
        yAxis: [{ type: 'value', gridIndex: 0, scale: true, ...b.axisStyle },
          ...(hasPace ? [{ ...paceAxis(b), gridIndex: 1,
            max: (v) => Math.min(v.max, 600), min: (v) => Math.max(v.min, 150) }] : [])],
        series: [line('HR', st.t.map((t, i) => [t / 60, st.hr[i]]), css('--s8'), { markArea: mark, connectNulls: false }),
          ...(hasPace ? [line('Pace', st.t.map((t, i) => [t / 60, st.pace[i]]), css('--s1'), { xAxisIndex: 1, yAxisIndex: 1, markArea: mark })] : [])] };
    });
  };
  return [html, after];
}

function pageZones() {
  const c = S.ds.current;
  const today = S.ds.meta.to;
  const sum = (days) => S.ds.sessions.filter((s) => s.date > addDays(today, -days)).reduce((a, s) => a.map((x, i) => x + s.zone_s[i]), [0, 0, 0, 0, 0]);
  const start = rangeStart();
  const z4 = sum(28), z12 = sum(84);
  const zr = S.ds.sessions.filter((s) => s.date >= start).reduce((a, s) => a.map((x, i) => x + s.zone_s[i]), [0, 0, 0, 0, 0]);
  const pts = S.ds.scatter.filter((p) => p.date >= start);
  const WK = [['steady', 'Easy & long runs (steady 4 min)', '--muted'], ['tempo', 'Tempo workouts', '--s3'], ['threshold', 'Threshold workouts', '--s2'], ['vo2', 'VO2 / 4x4 workouts', '--s4']];
  const html = `<h1>Heart-rate zones</h1>
    <p class="sub">Data-driven: threshold HR ${Math.round(c.lt2_hr)} from your threshold reps (settled HR), max HR ${Math.round(c.hrmax)} from your runs. Zones are fractions of threshold HR (Norwegian I1–I5 model).</p>
    <div class="row">${tempControl()}</div>
    <div class="grid g2 section-title">
      <div class="card"><h2>Zones and paces</h2><p class="sub">at ${tempSpan()}°C</p>${zoneTable(c)}</div>
      <div class="card"><h2>Time in zones</h2><p class="sub">share of running time</p><div class="chart short" id="cZt"></div></div>
    </div>
    <div class="card" style="margin-top:16px"><h2>Pace vs heart rate</h2><p class="sub">${rangeLabel()} · HR heat-corrected to ${S.ds.meta.ref_temp}°C · easy runs: steady 4-minute segments · workouts: one point each at the written target pace (else the measured rep pace, else the fastest 3 minutes) and the settled rep HR · diamonds = current estimates</p><div class="chart tall" id="cSc"></div></div>`;
  const after = () => {
    bindTemp();
    chart($('#cZt'), () => {
      const b = base();
      const tot = (z) => z.reduce((a, x) => a + x, 0) || 1;
      const rows = [['Selected period', zr], ['Last 12 weeks', z12], ['Last 4 weeks', z4]];
      return { ...b.opt, tooltip: { ...b.opt.tooltip, trigger: 'axis', valueFormatter: (v) => `${v}%` },
        grid: { ...b.opt.grid, top: 36 },
        yAxis: { type: 'category', inverse: true, data: rows.map((r) => r[0]), ...b.axisStyle, splitLine: { show: false } },
        xAxis: { type: 'value', max: 100, ...b.axisStyle, axisLabel: { ...b.axisStyle.axisLabel, formatter: '{value}%' } },
        series: c.zones.map((z, i) => ({ name: z.zone, type: 'bar', stack: 't', barWidth: 22,
          data: rows.map(([, z]) => Math.round((z[i] / tot(z)) * 100)),
          itemStyle: { color: css(`--z${i + 1}`), borderColor: css('--surface'), borderWidth: 2 } })) };
    });
    chart($('#cSc'), () => {
      const b = base();
      const anchors = [['Easy', c.easy, '--s1'], ['Tempo', c.tempo, '--s3'], ['L2', c.lt2, '--s2'], ['VO2max', c.vo2, '--s4']];
      const kinds = WK.filter(([k]) => pts.some((p) => p.kind === k));
      return { ...b.opt, legend: { ...b.opt.legend, data: [...kinds.map((k) => k[1]), ...anchors.map((a) => a[0])] },
        tooltip: { ...b.opt.tooltip, trigger: 'item', formatter: (x) => { const p = x.data.p || {};
          return `${p.name ? `<b>${esc(p.name)}</b>` : x.seriesName}${p.date ? ' · ' + day(p.date) : ''}<br>${pace(x.value[1])} /km @ ${Math.round(x.value[0])} bpm${p.raw_hr && Math.round(p.raw_hr) !== Math.round(x.value[0]) ? ` (${Math.round(p.raw_hr)} measured)` : ''}${p.temp != null ? ` · ${Math.round(p.temp)}°C` : ''}${p.src ? `<br>pace: ${p.src}` : ''}`; } },
        xAxis: { type: 'value', scale: true, name: 'HR', nameLocation: 'end', nameTextStyle: { color: css('--muted') }, ...b.axisStyle },
        yAxis: paceAxis(b, { max: (v) => Math.min(v.max, 540) }),
        series: [...kinds.map(([k, n, col]) => ({ name: n, type: 'scatter', symbolSize: k === 'steady' ? 7 : 13,
            itemStyle: k === 'steady' ? { color: css(col), opacity: 0.4 } : { color: css(col), borderColor: css('--surface'), borderWidth: 2 },
            data: pts.filter((p) => p.kind === k).map((p) => ({ value: [p.hr, p.pace], p })) })),
          ...anchors.map(([n, a, col]) => ({ name: n, type: 'scatter', symbol: 'diamond', symbolSize: 16, data: [{ value: [a.hr, a.pace] }],
            itemStyle: { color: css(col), borderColor: css('--surface'), borderWidth: 2 },
            label: { show: true, position: 'right', formatter: n, color: css('--ink-2'), fontSize: 12 } }))] };
    }).on('click', (x) => x.data?.p?.id && (location.hash = `#/workouts/${x.data.p.id}`));
  };
  return [html, after];
}

function pageWeather() {
  const m = S.ds.meta;
  const inR = S.ds.sessions.filter((s) => inRange(s.date));
  const out = inR.filter((s) => !s.indoor && s.temp != null);
  const easy = out.filter((s) => (s.type === 'easy' || s.type === 'long') && s.avg_hr && s.pace);
  const places = {};
  inR.forEach((s) => {
    const p = s.place || 'Unknown';
    const x = (places[p] ||= { runs: 0, km: 0, temps: [], indoor: 0 });
    x.runs++; x.km += s.km; if (s.indoor) x.indoor++; else if (s.temp != null) x.temps.push(s.temp);
  });
  const prow = Object.entries(places).sort((a, b) => b[1].runs - a[1].runs).map(([p, x]) => {
    const t = x.temps; const avg = t.length ? t.reduce((a, v) => a + v, 0) / t.length : null;
    return `<tr><td>${esc(p)}</td><td class="n">${x.runs}</td><td class="n">${Math.round(x.km)}</td><td class="n">${x.indoor}</td>
      <td class="n">${avg != null ? Math.round(avg) + '°' : '–'}</td><td class="n">${t.length ? Math.round(Math.min(...t)) + '° – ' + Math.round(Math.max(...t)) + '°' : '–'}</td></tr>`;
  }).join('');
  const html = `<h1>Weather</h1><p class="sub">Perceived ("feels like") temperature at the time and place of each outdoor run (Open-Meteo historical data; used everywhere a run's temperature is used) · ${rangeLabel()}</p>
    <div class="grid g3">
      ${tile({ label: 'Heat effect on HR', value: `+${m.heat.c}`, unit: ' bpm/°C', meta: `above ${m.ref_temp}°C · ${m.heat.fitted ? `fitted on ${m.heat.n} steady segments` : 'default (not enough data yet)'}` })}
      ${tile({ label: 'Outdoor runs, last 90 days', value: out.filter((s) => s.date > addDays(m.to, -90)).length, meta: `average ${Math.round(avgOf(out.filter((s) => s.date > addDays(m.to, -90)).map((s) => s.temp)))}°C` })}
      ${tile({ label: 'Hottest run', value: out.length ? Math.round(Math.max(...out.map((s) => s.temp))) : '–', unit: '°C', meta: out.length ? esc(out.reduce((a, s) => (s.temp > a.temp ? s : a)).name) : '' })}
    </div>
    <div class="grid g2 section-title">
      <div class="card"><h2>Temperature and easy-run heart rate</h2><p class="sub">Each dot is an easy or long run · average HR vs feels-like temperature</p><div class="chart" id="cTh"></div></div>
      <div class="card"><h2>Temperature over time</h2><p class="sub">Feels-like °C during each outdoor run</p><div class="chart" id="cTt"></div></div>
    </div>
    <div class="card" style="margin-top:16px"><h2>Places</h2><div class="table-wrap"><table><thead><tr><th>Place</th><th class="n">Runs</th><th class="n">km</th><th class="n">Treadmill</th><th class="n">Avg temp</th><th class="n">Range</th></tr></thead><tbody>${prow}</tbody></table></div></div>`;
  const after = () => {
    chart($('#cTh'), () => {
      const b = base();
      return { ...b.opt, legend: { show: false },
        tooltip: { ...b.opt.tooltip, trigger: 'item', formatter: (x) => `<b>${esc(x.data.s.name)}</b> · ${day(x.data.s.date)}<br>${Math.round(x.value[0])}°C · HR ${Math.round(x.value[1])} · ${pace(x.data.s.pace)} /km` },
        xAxis: { type: 'value', scale: true, name: '°C', nameTextStyle: { color: css('--muted') }, ...b.axisStyle },
        yAxis: { type: 'value', scale: true, name: 'bpm', nameTextStyle: { color: css('--muted') }, ...b.axisStyle },
        series: [{ type: 'scatter', symbolSize: 9, data: easy.map((s) => ({ value: [s.temp, s.avg_hr], s })), itemStyle: { color: css('--s2'), opacity: 0.7 } }] };
    }).on('click', (x) => (location.hash = `#/workouts/${x.data.s.id}`));
    chart($('#cTt'), () => {
      const b = base();
      return { ...b.opt, legend: { show: false },
        tooltip: { ...b.opt.tooltip, trigger: 'item', formatter: (x) => `<b>${esc(x.data.s.name)}</b> · ${day(x.data.s.date)}<br>${Math.round(x.value[1])}°C in ${esc(x.data.s.place || '?')}` },
        xAxis: timeAxis(b), yAxis: { type: 'value', ...b.axisStyle, axisLabel: { ...b.axisStyle.axisLabel, formatter: '{value}°' } },
        series: [{ type: 'scatter', symbolSize: 8, data: out.map((s) => ({ value: [s.date, s.temp], s })), itemStyle: { color: css('--s1'), opacity: 0.7 } }] };
    }).on('click', (x) => (location.hash = `#/workouts/${x.data.s.id}`));
  };
  return [html, after];
}
const avgOf = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

// ------------------------------------------------------------------ routing & data
function route() {
  if (!S.ds) return;
  disposeCharts();
  const [path, query = ''] = location.hash.split('?');
  const [, page = 'performance', id] = path.replace(/^#\/?/, '#/').split('/');
  const qType = new URLSearchParams(query).get('type');
  if (page === 'workouts' && qType) S.wFilter = qType;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#/${page}`));
  const pages = { performance: pagePerformance, dashboard: pageDashboard, workouts: () => (id ? pageWorkout(id) : pageWorkouts()), zones: pageZones, weather: pageWeather };
  const [html, after] = (pages[page] || pagePerformance)();
  $('#app').innerHTML = html;
  after && after();
  window.scrollTo({ top: 0 });
}
window.addEventListener('hashchange', route);

function useDataset(ds, real) {
  S.ds = ds;
  syncRangeCtl();
  S.temp = S.temp ?? ds.meta.ref_temp;
  $('#badge').textContent = real ? 'Personal data' : 'Demo data';
  $('#badge').className = `badge ${real ? 'real' : 'demo'}`;
  $('#lockBtn').textContent = real ? 'Lock' : 'Unlock';
  $('#lockBtn').hidden = !S.blob;
  const n = $('#notice');
  n.hidden = real;
  n.innerHTML = real ? '' : `You are looking at an <b>artificial demo runner</b>. ${S.blob ? 'Unlock to see the real data.' : ''}`;
  $('#foot').textContent = `Generated ${ds.meta.generated.replace('T', ' ')} · ${ds.meta.runs} runs since ${ds.meta.from ? day(ds.meta.from) : '–'}${document.body.dataset.version ? ` · site ${document.body.dataset.version}` : ''}`;
  route();
}

async function unlock(password, remember) {
  const key = await deriveKey(password, S.blob);
  const ds = await decryptWithKey(key, S.blob); // throws on wrong password
  await storeKey(key, S.blob, remember);
  S.real = ds;
  useDataset(ds, true);
}

async function init() {
  if (!location.hash) history.replaceState(null, '', '#/performance');
  S.demo = await (await fetch('data/demo.json', { cache: 'no-cache' })).json();
  try {
    const r = await fetch('data/real.enc', { cache: 'no-cache' });
    if (r.ok) S.blob = await r.json();
  } catch (e) { /* no personal data published */ }
  if (S.blob) {
    try {
      const key = await loadStoredKey(S.blob);
      if (key) { S.real = await decryptWithKey(key, S.blob); return useDataset(S.real, true); }
    } catch (e) { forgetKey(); }
  }
  useDataset(S.demo, false);
}

const dlg = $('#unlock');
$('#lockBtn').addEventListener('click', () => {
  if (S.ds === S.real) { forgetKey(); S.real = null; useDataset(S.demo, false); return; }
  $('#pwErr').hidden = true; $('#pw').value = ''; dlg.showModal();
});
$('#cancelUnlock').addEventListener('click', () => dlg.close());
$('#unlockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#doUnlock');
  btn.disabled = true; btn.textContent = 'Decrypting…';
  try { await unlock($('#pw').value, $('#remember').checked); dlg.close(); }
  catch (err) { $('#pwErr').hidden = false; }
  finally { btn.disabled = false; btn.textContent = 'Unlock'; }
});

init().catch((e) => { $('#app').innerHTML = `<p class="pad">Could not load data: ${esc(e.message)}</p>`; });
