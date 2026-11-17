/* =========================================================
   KB TRACKER ENGINE (shared)
   Each person's index.html sets window.KB_CONFIG: their routine,
   app name, storage key and accent colour. Nothing here is personal.
   ========================================================= */
const CONFIG = window.KB_CONFIG;
const ROUTINE = CONFIG.routine;
const ORDER = Object.keys(ROUTINE);
const NEXT = Object.fromEntries(ORDER.map((w, i) => [w, ORDER[(i + 1) % ORDER.length]]));
const SIDE_WORD = CONFIG.sideWord || "side";
const wName = w => ROUTINE[w].name || "Workout " + w;
const wLetter = w => ROUTINE[w].letter || w;
const lowerFirst = t => t.charAt(0).toLowerCase() + t.slice(1);

(function applyAccent(a) {
  if (!a) return;
  const st = document.createElement("style");
  st.textContent = `:root{--bell:${a.light};--on-bell:${a.on}}
    @media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bell:${a.dark};--on-bell:${a.onDark || a.on}}}`;
  document.head.appendChild(st);
})(CONFIG.accent);

/* =========================================================
   STORAGE
   state = { version, history: [session], active: session|null }
   session = { id, workout, startedAt, finishedAt?,
               exercises: [{ exId, variant, sets: [{ value, done, extra }] }] }
   ========================================================= */
const KEY = CONFIG.storageKey;
let canStore = true;

function load() {
  try {
    localStorage.setItem(KEY + ".test", "1");
    localStorage.removeItem(KEY + ".test");
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1) return parsed;
    }
  } catch (e) {
    canStore = false;
  }
  return { version: 1, history: [], active: null };
}
function save() {
  if (!canStore) return;
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch (e) { canStore = false; render(); }
}
let state = load();

// Ask the browser not to evict our data under storage pressure.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

/* =========================================================
   HELPERS
   ========================================================= */
const exDef = (w, id) => ROUTINE[w].exercises.find(e => e.id === id);
function isPerSide(ex, variant) {
  if (ex.variants) { const v = ex.variants.find(v => v.id === variant); return !!(v && v.perSide); }
  return !!ex.perSide;
}
function variantLabel(ex, variant) {
  if (!ex.variants) return null;
  const v = ex.variants.find(v => v.id === variant);
  return v ? v.label : null;
}
function unitWord(ex) { return ex.unit === "sec" ? "seconds" : "reps"; }
function unitShort(ex) { return ex.unit === "sec" ? "s" : ""; }
function rangeText(ex) { return ex.top ? `${ex.target}–${ex.top}` : `${ex.target}`; }
function planShort(ex) {
  if (ex.noPlan) return "Max";
  return `${ex.sets} × ${rangeText(ex)}${ex.unit === "sec" ? "s" : ""}`;
}
function metaText(ex, variant, prev) {
  const side = isPerSide(ex, variant) ? ` per ${SIDE_WORD}` : "";
  let main;
  if (!prev && ex.noPlan) main = "First time";
  else if (!prev) main = `First time with this option. Plan ${ex.sets} × ${rangeText(ex)} ${unitWord(ex)}${side}`;
  else if (prev.source === "plan") main = `Plan ${ex.sets} × ${rangeText(ex)} ${unitWord(ex)}${side}`;
  else main = `Last time ${prev.sets.join(", ")} ${unitWord(ex)}${side}${ex.top ? `. Aim ${rangeText(ex)}` : ""}`;
  return main + (ex.note ? `. ${ex.note}` : "");
}
function chipHTML(ex, value) {
  return ex.unit === "sec" ? `<span>${value}<small>s</small></span>` : `${value}`;
}
function nextWorkout() {
  const last = state.history[state.history.length - 1];
  return last && NEXT[last.workout] ? NEXT[last.workout] : ORDER[0];
}
function lastSessionFor(w) {
  for (let i = state.history.length - 1; i >= 0; i--) if (state.history[i].workout === w) return state.history[i];
  return null;
}
function relDay(iso) {
  const d = new Date(iso), now = new Date();
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const diff = Math.round((day(now) - day(d)) / 864e5);
  if (diff === 0) return "today";
  if (diff === 1) return "yesterday";
  if (diff < 7) return `${diff} days ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
function lastDoneText(w) {
  for (let i = state.history.length - 1; i >= 0; i--) {
    const s = state.history[i];
    if (s.workout !== w) continue;
    const r = summarise(s, i);
    const compared = r.beat + r.matched + r.below;
    return `Last done ${relDay(s.finishedAt)}` + (compared ? `, beat ${r.beat} of ${compared}` : "");
  }
  return "Not done yet";
}
function timeText(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/* =========================================================
   LAST TIME + COMPARISON
   ========================================================= */

/* The result to beat for one exercise: the most recent finished session
   (before history index `beforeIdx`) where it was done with the same variant.
   With no history, the hardcoded plan is the baseline for the default variant. */
function getPrevious(ex, w, variant, beforeIdx) {
  if (ex.warmup) return null;
  for (let i = beforeIdx - 1; i >= 0; i--) {
    const s = state.history[i];
    if (s.workout !== w) continue;
    const se = s.exercises.find(e => e.exId === ex.id);
    if (!se || (se.variant || null) !== (variant || null)) continue;
    const vals = se.sets.filter(st => st.done).map(st => st.value);
    if (!vals.length) continue;
    return { sets: vals, total: vals.reduce((a, b) => a + b, 0), source: "history" };
  }
  if (!ex.noPlan && (!ex.variants || variant === ex.defaultVariant)) {
    const vals = Array(ex.sets).fill(ex.target);
    return { sets: vals, total: ex.sets * ex.target, source: "plan" };
  }
  return null;
}

function lastVariantFor(w, exId) {
  for (let i = state.history.length - 1; i >= 0; i--) {
    const s = state.history[i];
    if (s.workout !== w) continue;
    const se = s.exercises.find(e => e.exId === exId);
    if (se && se.variant) return se.variant;
  }
  return null;
}

/* Pre-fill today's sets with what was done last time (same variant).
   At least the planned number of sets; more if last time had extras. */
function prefillSets(ex, w, variant, beforeIdx) {
  const prev = getPrevious(ex, w, variant, beforeIdx);
  const vals = prev ? prev.sets : [];
  const n = Math.max(ex.sets || 1, vals.length);
  return Array.from({ length: n }, (_, i) => ({ value: vals[i] ?? ex.target, done: false, extra: false }));
}

function newSession(w) {
  const idx = state.history.length;
  return {
    id: Date.now().toString(36),
    workout: w,
    startedAt: new Date().toISOString(),
    exercises: ROUTINE[w].exercises.map(ex => {
      const variant = ex.variants ? (lastVariantFor(w, ex.id) || ex.defaultVariant) : null;
      return { exId: ex.id, variant, sets: prefillSets(ex, w, variant, idx) };
    }),
  };
}

/* Total volume (sum of done reps or seconds) against last time.
   status: beat | matched | below | progress (still sets to go) | new (nothing to compare) */
function compareExercise(ex, se, w, beforeIdx, final) {
  const cur = se.sets.filter(st => st.done).reduce((a, st) => a + st.value, 0);
  const prev = getPrevious(ex, w, se.variant, beforeIdx);
  if (!prev) return { cur, prev: null, status: cur ? "new" : "progress" };
  const remaining = se.sets.some(st => !st.done);
  let status;
  if (cur > prev.total) status = "beat";
  else if (cur === prev.total) status = "matched";
  else status = (final || !remaining) ? "below" : "progress";
  return { cur, prev, status };
}

function summarise(session, historyIdx) {
  const r = { beat: 0, matched: 0, below: 0, new: 0, rows: [] };
  session.exercises.forEach(se => {
    const ex = exDef(session.workout, se.exId);
    if (!ex || ex.warmup) return;
    const c = compareExercise(ex, se, session.workout, historyIdx, true);
    if (c.status === "beat") r.beat++;
    else if (c.status === "matched") r.matched++;
    else if (c.status === "below") r.below++;
    else r.new++;
    r.rows.push({ ex, se, c });
  });
  return r;
}

function cmpHTML(ex, c) {
  const u = unitShort(ex);
  const label = { beat: "Beat last time", matched: "Matched last time", below: "Below last time",
                  progress: "So far", new: "First time" }[c.status];
  const aria = c.prev ? `${label}: ${c.cur} versus ${c.prev.total} ${unitWord(ex)}` : `${label}: ${c.cur} ${unitWord(ex)}`;
  if (c.status === "beat")    return `<span class="cmp up" aria-label="${aria}">▲ ${c.cur}${u}<span class="vs">vs ${c.prev.total}${u}</span></span>`;
  if (c.status === "matched") return `<span class="cmp eq" aria-label="${aria}">= ${c.cur}${u}</span>`;
  if (c.status === "below")   return `<span class="cmp down" aria-label="${aria}">▼ ${c.cur}${u}<span class="vs">vs ${c.prev.total}${u}</span></span>`;
  if (c.status === "new")     return `<span class="cmp new" aria-label="${aria}">${c.cur}${u}</span>`;
  return `<span class="cmp prog" aria-label="${aria}">${c.cur}${u}<span class="vs">of ${c.prev ? c.prev.total + u : "?"}</span></span>`;
}

/* =========================================================
   PAGES AND NAVIGATION
   #progress, #history and #edit-<id> are separate pages, so the
   Android back button moves between them naturally.
   ========================================================= */
const ICON_KB = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M8.5 9.5V7a3.5 3.5 0 0 1 7 0v2.5"/><circle cx="12" cy="14.5" r="6"/></svg>`;
const ICON_CHART = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 20h18"/><path d="M4 16l5-5 4 3 7-8"/></svg>`;
const ICON_LIST = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/></svg>`;

function route() {
  const h = location.hash.replace(/^#/, "");
  if (h.startsWith("edit-")) return { view: "edit", id: h.slice(5) };
  if (h === "progress" || h === "history") return { view: h };
  return { view: "home" };
}
function navHTML(currentPage) {
  const tabs = [["", "Workout", ICON_KB], ["progress", "Progress", ICON_CHART], ["history", "History", ICON_LIST]];
  return `<nav class="tabbar" aria-label="Pages"><div class="tabbar-inner">
    ${tabs.map(([h, label, icon]) => `<a class="tab" href="#${h}"${h === currentPage ? ' aria-current="page"' : ""}>${icon}<span>${label}</span></a>`).join("")}
  </div></nav>`;
}

/* The session being shown with set circles: today's workout, or a past one being edited. */
let draft = null;          // working copy of a past workout; only saved on "Save changes"
let openedFromList = false;
function current() { return state.active || draft; }
function persist() { if (state.active) save(); else if (draft) draft.dirty = true; }

function shortDate(iso) { return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }); }
function longDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) + ", " + timeText(iso);
}
function dateInputValue(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function durationMins(s) { return Math.max(1, Math.round((new Date(s.finishedAt) - new Date(s.startedAt)) / 60000)); }

/* =========================================================
   RENDER
   ========================================================= */
const app = document.getElementById("app");
let popTarget = null;

function warningHTML() {
  return canStore ? "" :
    `<p class="warning">This browser isn’t letting the app save. Anything you log will be lost when you close it.</p>`;
}

let summaryIdx = null; // history index of a just-finished session to show

function render() {
  keepAwake(!!state.active);
  if (state.active) { draft = null; renderSession(state.active, "active"); return; }
  if (summaryIdx !== null && state.history[summaryIdx]) { renderSummary(); return; }
  const r = route();
  if (r.view === "edit") {
    if (!draft || draft.id !== r.id) {
      const src = state.history.find(x => x.id === r.id);
      draft = src ? JSON.parse(JSON.stringify(src)) : null;
      if (draft) draft.dirty = false;
    }
    if (draft) { renderSession(draft, "edit"); return; }
    location.replace("#history");
    return;
  }
  draft = null;
  if (r.view === "progress") renderProgress();
  else if (r.view === "history") renderHistory();
  else renderHome();
}
window.addEventListener("hashchange", () => { window.scrollTo(0, 0); render(); });

function renderSummary() {
  const s = state.history[summaryIdx];
  const r = summarise(s, summaryIdx);
  const mins = Math.max(1, Math.round((new Date(s.finishedAt) - new Date(s.startedAt)) / 60000));
  const compared = r.beat + r.matched + r.below;
  let headline;
  if (!compared) headline = "Baseline set. Next time you’ll have numbers to beat.";
  else if (r.beat === compared) headline = "You beat last time on every exercise.";
  else if (r.beat > 0) headline = `More than last time on ${r.beat} of ${compared} exercises.`;
  else if (r.below === 0) headline = "Matched last time across the board.";
  else headline = "Below last time this round. Same numbers to beat next time.";

  app.innerHTML = `
    ${warningHTML()}
    <header class="session-head">
      <span class="disc" aria-hidden="true">${wLetter(s.workout)}</span>
      <div class="text">
        <h1>${wName(s.workout)} done</h1>
        <p class="muted">${mins} min</p>
      </div>
    </header>
    <div class="score">
      <div class="up"><strong>${r.beat}</strong><span>Beat</span></div>
      <div><strong>${r.matched}</strong><span>Matched</span></div>
      <div class="down"><strong>${r.below}</strong><span>Below</span></div>
    </div>
    <p class="score-note">${headline}${r.new ? ` ${r.new} with nothing to compare yet.` : ""}</p>
    <ul class="results">
      ${r.rows.map(({ ex, se, c }) => `
        <li>
          <span class="name">${ex.name}${variantLabel(ex, se.variant) ? `<small>${variantLabel(ex, se.variant)}</small>` : ""}</span>
          ${cmpHTML(ex, c)}
        </li>`).join("")}
    </ul>
    <button class="btn primary" data-action="close-summary">Done</button>
  `;
}

function renderHome() {
  const next = nextWorkout();
  const nextEx = ROUTINE[next].exercises;
  const others = ORDER.filter(w => w !== next);
  const n = state.history.length;

  app.innerHTML = `
    ${warningHTML()}
    <header class="top">
      <h1 class="brand">${CONFIG.appName}</h1>
      <span class="muted">${CONFIG.equipment || ""}</span>
    </header>

    <section class="next" aria-labelledby="next-title">
      <p class="next-label">${ORDER.length > 1 ? "Next up" : "Today"}</p>
      <div class="next-head">
        <span class="disc big" aria-hidden="true">${wLetter(next)}</span>
        <div>
          <h2 id="next-title">${wName(next)}</h2>
          <p class="muted">${lastDoneText(next)}</p>
        </div>
      </div>
      <ul class="ex-list">
        ${nextEx.some(ex => ex.warmup) ? `<li><span>Warm-up</span><span>${nextEx.filter(ex => ex.warmup).length} moves</span></li>` : ""}
        ${nextEx.filter(ex => !ex.warmup).map(ex => `
          <li><span>${ex.name}</span><span>${planShort(ex)}</span></li>
        `).join("")}
      </ul>
      <button class="btn primary" data-action="start" data-w="${next}">Start ${lowerFirst(wName(next))}</button>
    </section>

    ${others.length ? `<section class="others">
      <h3>Or do a different one</h3>
      ${others.map(w => `
        <div class="other-row">
          <span class="disc outline" aria-hidden="true">${wLetter(w)}</span>
          <div class="text">
            <strong>${wName(w)}</strong>
            <span>${lastDoneText(w)}</span>
          </div>
          <button class="btn ghost small" data-action="start" data-w="${w}" aria-label="Start ${lowerFirst(wName(w))}">Start</button>
        </div>
      `).join("")}
    </section>` : ""}

    <section class="footnote" aria-label="Backup">
      <p>${n === 0 ? "No workouts logged yet." : `${n} workout${n === 1 ? "" : "s"} logged.`}
         ${state.lastBackupAt ? ` Last backup ${relDay(state.lastBackupAt)}.` : (n ? " Not backed up yet." : "")}</p>
      ${unbackedCount() >= 3 ? `<p><strong>${unbackedCount()} workouts since your last backup.</strong></p>` : ""}
      <div class="backup-row">
        <button class="btn ghost small" data-action="backup"${n ? "" : " disabled"}>Back up</button>
        <button class="btn ghost small" data-action="restore">Restore</button>
      </div>
    </section>
    ${navHTML("")}
  `;
}

function renderSession(s, mode) {
  const editing = mode === "edit";
  const beforeIdx = editing ? state.history.findIndex(x => x.id === s.id) : state.history.length;
  let done = 0, total = 0;

  const hasWarm = s.exercises.some(se => exDef(s.workout, se.exId).warmup);
  let lastSection = null;
  const items = s.exercises.map((se, ei) => {
    const ex = exDef(s.workout, se.exId);
    const section = ex.warmup ? "Warm-up" : "Workout";
    const label = hasWarm && section !== lastSection ? `<li class="section-label">${section}</li>` : "";
    lastSection = section;
    if (ex.warmup) {
      const st = se.sets[0];
      const amount = ex.unit === "sec" ? `${ex.target} seconds` : `${ex.target} reps`;
      return `${label}
      <li class="ex warm">
        <div class="warm-row">
          <div><h2>${ex.name}</h2><p class="meta">${amount}${ex.perSide ? ` per ${SIDE_WORD}` : ""}</p></div>
          <button class="chip check${st.done ? " done" : ""}" data-ei="${ei}" data-si="0" data-warm="1"
            aria-pressed="${st.done}" aria-label="${ex.name}${st.done ? ", done" : ", not done"}">✓</button>
        </div>
      </li>`;
    }
    const cmp = compareExercise(ex, se, s.workout, beforeIdx, editing);
    const perSide = isPerSide(ex, se.variant);
    const d = se.sets.filter(x => x.done).length;
    done += d; total += se.sets.length;
    const unitWord = ex.unit === "sec" ? "seconds" : "reps";

    const chips = se.sets.map((st, si) => `
      <button class="chip${st.done ? " done" : ""}${st.extra ? " extra" : ""}"
        data-ei="${ei}" data-si="${si}" aria-pressed="${st.done}"
        aria-label="Set ${si + 1}: ${st.value} ${unitWord}${perSide ? ` per ${SIDE_WORD}` : ""}${st.done ? ", done" : ""}">
        ${chipHTML(ex, st.value)}
      </button>`).join("");

    return `
      ${label}
      <li class="ex">
        <div class="ex-head">
          <h2>${ex.name}</h2>
          ${cmpHTML(ex, cmp)}
        </div>
        <p class="meta">${metaText(ex, se.variant, cmp.prev)}</p>
        ${ex.variants ? `
        <div class="variants" role="group" aria-label="${ex.name} option">
          ${ex.variants.map(v => `<button class="variant-btn" data-action="variant" data-ei="${ei}" data-v="${v.id}" aria-pressed="${v.id === se.variant}">${v.label}</button>`).join("")}
        </div>` : ""}
        <div class="chips">
          ${chips}
          ${ex.unit === "sec" && !editing ? `<button class="chip timer" data-action="timer" data-ei="${ei}" aria-label="Time the next set of ${ex.name}">${STOPWATCH_ICON}</button>` : ""}
          <button class="chip add" data-action="add" data-ei="${ei}" aria-label="Add a set of ${ex.name}">+</button>
        </div>
      </li>`;
  }).join("");

  const pct = total ? Math.round((done / total) * 100) : 0;

  const header = editing ? `
    <header class="session-head">
      <span class="disc" aria-hidden="true">${wLetter(s.workout)}</span>
      <div class="text">
        <h1>${wName(s.workout)}</h1>
        <label class="muted">Editing, date <input type="date" class="date-input" id="edit-date" value="${dateInputValue(s.finishedAt)}" max="${dateInputValue(new Date().toISOString())}"></label>
      </div>
      <button class="btn ghost small danger" data-action="delete">Delete</button>
    </header>
    <p class="hint">Tap a set to mark it done or not done. Hold a set to change the number.</p>` : `
    <header class="session-head">
      <span class="disc" aria-hidden="true">${wLetter(s.workout)}</span>
      <div class="text">
        <h1>${wName(s.workout)}</h1>
        <p class="muted">Started ${timeText(s.startedAt)}</p>
      </div>
      <button class="btn ghost small" data-action="discard">Discard</button>
    </header>
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}" aria-label="Sets done">
      <div style="width:${pct}%"></div>
    </div>
    <p class="hint">Tap a set when you’ve done it. Hold a set to change the number. Use the stopwatch to time holds.</p>`;

  const footer = editing ? `
        <button class="btn ghost" data-action="cancel-edit">Cancel</button>
        <button class="btn primary" data-action="save-edit">Save changes</button>` : `
        <span class="count">${done} of ${total} sets</span>
        <button class="btn primary" data-action="finish">Finish workout</button>`;

  app.innerHTML = `
    ${warningHTML()}
    ${header}
    <ul class="exercises">${items}</ul>
    <div class="finish-bar"><div class="finish-inner">${footer}</div></div>
  `;

  if (popTarget) {
    const el = app.querySelector(`.chip[data-ei="${popTarget[0]}"][data-si="${popTarget[1]}"]`);
    if (el) el.classList.add("pop");
    popTarget = null;
  }
}

/* =========================================================
   PROGRESS PAGE
   One trend per exercise (and per option, for row and bridge):
   total reps or seconds per workout, starting from the plan.
   ========================================================= */
let expanded = null;

function seriesFor(w, ex, variant) {
  const pts = [];
  if (!ex.noPlan && (!ex.variants || variant === ex.defaultVariant)) {
    pts.push({ plan: true, total: ex.sets * ex.target, sets: Array(ex.sets).fill(ex.target) });
  }
  state.history.forEach(s => {
    if (s.workout !== w) return;
    const se = s.exercises.find(e => e.exId === ex.id);
    if (!se || (se.variant || null) !== (variant || null)) return;
    const vals = se.sets.filter(st => st.done).map(st => st.value);
    if (!vals.length) return;
    pts.push({ date: s.finishedAt, total: vals.reduce((a, b) => a + b, 0), sets: vals });
  });
  return pts;
}

function changeInfo(pts) {
  const real = pts.filter(p => !p.plan);
  if (!real.length) return { text: "–", cls: "flat", label: "Not done yet" };
  if (pts.length < 2) return { text: "New", cls: "flat", label: "Only one workout so far" };
  const first = pts[0].total, last = pts[pts.length - 1].total;
  const pct = Math.round(((last - first) / first) * 100);
  if (pct > 0) return { text: `+${pct}%`, cls: "up", label: `Up ${pct}% since ${pts[0].plan ? "your starting plan" : "your first workout"}` };
  if (pct < 0) return { text: `−${-pct}%`, cls: "down", label: `Down ${-pct}% since ${pts[0].plan ? "your starting plan" : "your first workout"}` };
  return { text: "0%", cls: "flat", label: "No change yet" };
}

function sparkSVG(pts) {
  if (pts.length < 2) return `<svg class="spark" aria-hidden="true"></svg>`;
  const W = 84, H = 30, m = 4;
  const vals = pts.map(p => p.total), lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const xy = vals.map((v, i) => [m + (i * (W - 2 * m)) / (vals.length - 1), H - m - ((v - lo) / span) * (H - 2 * m)]);
  const [lx, ly] = xy[xy.length - 1];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <polyline points="${xy.map(p => p.join(",")).join(" ")}"/><circle cx="${lx}" cy="${ly}" r="3"/></svg>`;
}

function chartSVG(pts, ex) {
  const W = 320, H = 160, L = 34, R = 10, T = 12, B = 24;
  const vals = pts.map(p => p.total);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const padding = Math.max(1, Math.round((hi - lo) * 0.15)) || Math.max(1, Math.round(hi * 0.1));
  lo = Math.max(0, lo - padding); hi = hi + padding;
  const y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const x = i => pts.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (pts.length - 1);
  const u = unitShort(ex);
  const ticks = [lo, Math.round((lo + hi) / 2), hi];
  const lbl = p => p.plan ? "Plan" : shortDate(p.date);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Total ${unitWord(ex)} per workout, from ${vals[0]} to ${vals[vals.length - 1]}">
    ${ticks.map(t => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 6}" y="${y(t) + 3}" text-anchor="end">${t}${u}</text>`).join("")}
    <polyline points="${pts.map((p, i) => `${x(i)},${y(p.total)}`).join(" ")}"/>
    ${pts.map((p, i) => `<circle class="${p.plan ? "plan" : ""}" cx="${x(i)}" cy="${y(p.total)}" r="4"/>`).join("")}
    <text x="${x(0)}" y="${H - 6}" text-anchor="${pts.length === 1 ? "middle" : "start"}">${lbl(pts[0])}</text>
    ${pts.length > 1 ? `<text x="${x(pts.length - 1)}" y="${H - 6}" text-anchor="end">${lbl(pts[pts.length - 1])}</text>` : ""}
  </svg>`;
}

function renderProgress() {
  const n = state.history.length;
  if (!n) {
    app.innerHTML = `${warningHTML()}<h1 class="page-title">Progress</h1>
      <p class="empty">Finish a workout and your progress shows up here.</p>${navHTML("progress")}`;
    return;
  }

  // Headline: average change against the starting plan, across exercises done with their usual option.
  const ratios = [];
  ORDER.forEach(w => ROUTINE[w].exercises.forEach(ex => {
    if (ex.warmup) return;
    const pts = seriesFor(w, ex, ex.variants ? ex.defaultVariant : null);
    if (pts.length > 1 && pts[0].plan) ratios.push(pts[pts.length - 1].total / pts[0].total);
  }));
  const overall = ratios.length ? Math.round((ratios.reduce((a, b) => a + b, 0) / ratios.length - 1) * 100) : null;
  let headline = "";
  if (overall !== null) {
    headline = overall > 0 ? `Across your exercises, you’re doing <strong>${overall}% more</strong> than your starting plan.`
             : overall < 0 ? `Across your exercises, you’re <strong>${-overall}% below</strong> your starting plan.`
             : "Across your exercises, you’re level with your starting plan.";
  }
  const monthAgo = Date.now() - 30 * 864e5;
  const last30 = state.history.filter(s => new Date(s.finishedAt) >= monthAgo).length;
  const recent = state.history.slice(-5);
  const avgMins = Math.round(recent.reduce((a, s) => a + durationMins(s), 0) / recent.length);

  const groups = ORDER.map(w => {
    const rows = [];
    ROUTINE[w].exercises.forEach(ex => {
      if (ex.warmup) return;
      const variants = ex.variants ? ex.variants.map(v => v.id) : [null];
      variants.forEach(v => {
        const pts = seriesFor(w, ex, v);
        const real = pts.filter(p => !p.plan);
        if (ex.variants && v !== ex.defaultVariant && !real.length) return;
        const key = `${w}:${ex.id}:${v}`;
        const ch = changeInfo(pts);
        const last = pts[pts.length - 1];
        const vl = variantLabel(ex, v);
        const sub = !real.length ? "Not done yet" : real.length === 1 && ex.noPlan ? `First result ${last.total}${unitShort(ex) || " reps"}` : `Latest ${last.total} ${unitWord(ex)} in total`;
        const open = expanded === key;
        rows.push(`
          <li class="trend">
            <button class="trend-row" data-action="expand" data-key="${key}" aria-expanded="${open}">
              <span class="name">${ex.name}<small>${vl ? `${vl}. ` : ""}${sub}</small></span>
              ${sparkSVG(pts)}
              <span class="change ${ch.cls}" aria-label="${ch.label}">${ch.text}</span>
            </button>
            ${open && pts.length ? `
            <div class="trend-detail">
              ${chartSVG(pts, ex)}
              <ul class="entries">
                ${pts.slice(-6).reverse().map(p => `
                  <li><span>${p.plan ? "Starting plan" : shortDate(p.date)}: ${p.sets.join(", ")}</span><strong>${p.total}${unitShort(ex) || " reps"}</strong></li>`).join("")}
              </ul>
            </div>` : ""}
          </li>`);
      });
    });
    return `
      <section class="prog-group">
        <h2><span class="disc" aria-hidden="true">${wLetter(w)}</span>${wName(w)}</h2>
        <ul class="exercises">${rows.join("")}</ul>
      </section>`;
  }).join("");

  app.innerHTML = `
    ${warningHTML()}
    <h1 class="page-title">Progress</h1>
    ${headline ? `<p class="headline">${headline}</p>` : ""}
    <div class="score stats">
      <div><strong>${n}</strong><span>Workouts</span></div>
      <div><strong>${last30}</strong><span>Past month</span></div>
      <div><strong>${avgMins}<small>min</small></strong><span>Avg time</span></div>
    </div>
    <p class="page-intro">Each line is your total reps or seconds per workout, starting from your plan. Tap one for details.</p>
    ${groups}
    ${navHTML("progress")}
  `;
}

/* =========================================================
   HISTORY PAGE
   ========================================================= */
function renderHistory() {
  const items = state.history.map((s, i) => ({ s, i })).reverse();
  let body;
  if (!items.length) {
    body = `<p class="empty">No workouts yet. Finish one and it shows up here.</p>`;
  } else {
    let month = null;
    body = `<p class="page-intro">Tap a workout to change or delete it.</p>` + items.map(({ s, i }) => {
      const m = new Date(s.finishedAt).toLocaleDateString(undefined, { month: "long", year: "numeric" });
      const heading = m !== month ? `<h2 class="month">${m}</h2>` : "";
      month = m;
      const r = summarise(s, i);
      const compared = r.beat + r.matched + r.below;
      return `${heading}
        <a class="hist-row" href="#edit-${s.id}">
          <span class="disc outline" aria-hidden="true">${wLetter(s.workout)}</span>
          <div class="text">
            <strong><span class="visually-hidden">${wName(s.workout)}, </span>${new Date(s.finishedAt).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</strong>
            <span>${timeText(s.finishedAt)}, ${durationMins(s)} min${compared ? `, beat ${r.beat} of ${compared}` : ""}</span>
          </div>
          <span class="chev muted" aria-hidden="true">›</span>
        </a>`;
    }).join("");
  }
  app.innerHTML = `${warningHTML()}<h1 class="page-title">History</h1>${body}${navHTML("history")}`;
}

/* =========================================================
   ACTIONS
   ========================================================= */
function startWorkout(w) {
  state.active = newSession(w);
  save();
  window.scrollTo(0, 0);
  render();
}

function toggleSet(ei, si) {
  const st = current().exercises[ei].sets[si];
  st.done = !st.done;
  if (st.done && navigator.vibrate) navigator.vibrate(12);
  persist();
  popTarget = [ei, si];
  render();
}

function addSet(ei) {
  const se = current().exercises[ei];
  const ex = exDef(current().workout, se.exId);
  const last = se.sets[se.sets.length - 1];
  se.sets.push({ value: last ? last.value : ex.target, done: true, extra: true });
  if (navigator.vibrate) navigator.vibrate(12);
  persist();
  popTarget = [ei, se.sets.length - 1];
  render();
}

/* Switching variant re-loads last time's numbers for that variant,
   unless sets have already been logged, in which case they're kept. */
function setVariant(ei, v) {
  const se = current().exercises[ei];
  if (se.variant === v) return;
  const ex = exDef(current().workout, se.exId);
  se.variant = v;
  // In today's workout, load last time's numbers for that option. When editing a past one, keep what was logged.
  if (state.active && !se.sets.some(st => st.done)) se.sets = prefillSets(ex, state.active.workout, v, state.history.length);
  persist();
  render();
}

/* ---------- Editing a past workout ---------- */
function leaveEdit() {
  draft = null;
  if (openedFromList) { openedFromList = false; history.back(); }
  else location.replace("#history");
}
function saveEdit() {
  const s = draft;
  if (!s.exercises.some(se => se.sets.some(st => st.done))) {
    if (confirm("No sets are marked done. Delete this workout instead?")) deleteWorkout(true);
    return;
  }
  delete s.dirty;
  s.updatedAt = new Date().toISOString();
  const i = state.history.findIndex(x => x.id === s.id);
  if (i < 0) return;
  state.history[i] = s;
  state.history.sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));
  save();
  leaveEdit();
  toast("Changes saved");
}
function cancelEdit() {
  if (draft && draft.dirty && !confirm("Discard your changes to this workout?")) return;
  leaveEdit();
}
function deleteWorkout(skipConfirm) {
  const s = draft;
  if (!skipConfirm && !confirm(`Delete ${lowerFirst(wName(s.workout))} from ${longDate(s.finishedAt)}? You can only get it back by restoring a backup that includes it.`)) return;
  state.history = state.history.filter(x => x.id !== s.id);
  save();
  leaveEdit();
  toast("Workout deleted");
}
app.addEventListener("change", e => {
  if (e.target.id !== "edit-date" || !draft || !e.target.value) return;
  const [y, m, d] = e.target.value.split("-").map(Number);
  const fin = new Date(draft.finishedAt), dur = fin - new Date(draft.startedAt);
  fin.setFullYear(y, m - 1, d);
  draft.finishedAt = fin.toISOString();
  draft.startedAt = new Date(fin - dur).toISOString();
  draft.dirty = true;
});

function finish() {
  const s = state.active;
  let done = 0, undone = 0;
  s.exercises.forEach(se => { if (!exDef(s.workout, se.exId).warmup) se.sets.forEach(st => st.done ? done++ : undone++); });

  if (done === 0) {
    if (confirm("No sets logged yet. Discard this workout instead?")) {
      state.active = null; save(); window.scrollTo(0, 0); render();
    }
    return;
  }
  if (undone > 0 && !confirm(`${undone} ${undone === 1 ? "set isn’t" : "sets aren’t"} logged. Finish anyway?`)) return;

  s.finishedAt = new Date().toISOString();
  state.history.push(s);
  state.active = null;
  save();
  summaryIdx = state.history.length - 1;
  window.scrollTo(0, 0);
  render();
}

function discard() {
  if (!confirm("Discard this workout? Nothing from it will be saved.")) return;
  state.active = null;
  save();
  window.scrollTo(0, 0);
  render();
}

/* =========================================================
   INPUT: tap to toggle, hold to edit
   ========================================================= */
let pressTimer = null, pressStart = null, suppressClick = false;

app.addEventListener("pointerdown", e => {
  suppressClick = false;
  const chip = e.target.closest(".chip[data-si]");
  if (!chip) return;
  pressStart = { x: e.clientX, y: e.clientY };
  if (chip.dataset.warm) return; // warm-up items are tick-only
  pressTimer = setTimeout(() => {
    pressTimer = null;
    suppressClick = true;
    if (navigator.vibrate) navigator.vibrate(20);
    openEditor(+chip.dataset.ei, +chip.dataset.si);
  }, 450);
});
function cancelPress() { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } }
app.addEventListener("pointerup", cancelPress);
app.addEventListener("pointercancel", cancelPress);
app.addEventListener("pointermove", e => {
  if (pressTimer && pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) cancelPress();
});
app.addEventListener("contextmenu", e => { if (e.target.closest(".chip")) e.preventDefault(); });

app.addEventListener("click", e => {
  if (e.target.closest("a.hist-row")) openedFromList = true;
  const chip = e.target.closest(".chip[data-si]");
  if (chip) {
    if (suppressClick) { suppressClick = false; return; }
    toggleSet(+chip.dataset.ei, +chip.dataset.si);
    return;
  }
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const a = btn.dataset.action;
  if (a === "start") startWorkout(btn.dataset.w);
  else if (a === "add") addSet(+btn.dataset.ei);
  else if (a === "finish") finish();
  else if (a === "discard") discard();
  else if (a === "variant") setVariant(+btn.dataset.ei, btn.dataset.v);
  else if (a === "close-summary") { summaryIdx = null; window.scrollTo(0, 0); if (location.hash) location.hash = ""; else render(); }
  else if (a === "save-edit") saveEdit();
  else if (a === "cancel-edit") cancelEdit();
  else if (a === "delete") deleteWorkout(false);
  else if (a === "expand") { expanded = expanded === btn.dataset.key ? null : btn.dataset.key; render(); }
  else if (a === "timer") openTimer(+btn.dataset.ei);
  else if (a === "backup") exportBackup();
  else if (a === "restore") document.getElementById("restore-input").click();
});

/* =========================================================
   EDIT SHEET
   ========================================================= */
const sheet = document.getElementById("sheet");
let editing = null;

function openEditor(ei, si) {
  const se = current().exercises[ei];
  const ex = exDef(current().workout, se.exId);
  const st = se.sets[si];
  editing = { ei, si, value: st.value, ex, step: ex.unit === "sec" ? 5 : 1, min: ex.unit === "sec" ? 5 : 1 };
  const perSide = isPerSide(ex, se.variant);

  sheet.innerHTML = `
    <div class="sheet-body">
      <h2 id="sheet-title">${ex.name}</h2>
      <p class="muted">Set ${si + 1}${perSide ? `, per ${SIDE_WORD}` : ""}</p>
      <div class="stepper">
        <button type="button" data-step="-1" aria-label="Decrease">−</button>
        <output id="sheet-value" aria-live="polite"></output>
        <button type="button" data-step="1" aria-label="Increase">+</button>
      </div>
      <button type="button" class="btn primary" data-sheet="save">Save as done</button>
      <div class="sheet-row">
        ${st.done ? `<button type="button" class="btn ghost" data-sheet="undone">Mark not done</button>` : ""}
        ${st.extra ? `<button type="button" class="btn ghost danger" data-sheet="remove">Remove set</button>` : ""}
        <button type="button" class="btn ghost" data-sheet="cancel">Cancel</button>
      </div>
    </div>`;
  updateSheetValue();
  sheet.showModal();
}

function updateSheetValue() {
  const out = document.getElementById("sheet-value");
  if (!out || !editing) return;
  out.innerHTML = editing.ex.unit === "sec" ? `${editing.value}<small>s</small>` : `${editing.value}`;
}

sheet.addEventListener("click", e => {
  if (e.target === sheet) { sheet.close(); return; } // backdrop tap
  if (!editing) return;
  const stepBtn = e.target.closest("[data-step]");
  if (stepBtn) {
    editing.value = Math.max(editing.min, editing.value + Number(stepBtn.dataset.step) * editing.step);
    updateSheetValue();
    return;
  }
  const act = e.target.closest("[data-sheet]");
  if (!act) return;
  const sets = current().exercises[editing.ei].sets;
  const st = sets[editing.si];
  const kind = act.dataset.sheet;
  if (kind === "save") { st.value = editing.value; st.done = true; popTarget = [editing.ei, editing.si]; }
  else if (kind === "undone") { st.done = false; }
  else if (kind === "remove") { sets.splice(editing.si, 1); }
  if (kind !== "cancel") persist();
  sheet.close();
});

sheet.addEventListener("close", () => { editing = null; render(); });

/* =========================================================
   TOAST
   ========================================================= */
let toastTimer = null;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

/* =========================================================
   KEEP SCREEN AWAKE (during a workout)
   ========================================================= */
let wakeLock = null, wakePending = false;
async function keepAwake(on) {
  if (!("wakeLock" in navigator)) return;
  try {
    if (on && !wakeLock && !wakePending && document.visibilityState === "visible") {
      wakePending = true;
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      const l = wakeLock; wakeLock = null; await l.release();
    }
  } catch (e) { /* not allowed right now; carry on */ }
  finally { wakePending = false; }
}
// The browser drops the lock when the app is hidden; take it back on return.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") keepAwake(!!state.active);
});

/* =========================================================
   HOLD STOPWATCH
   5-second get-ready countdown, then counts up. Beeps on go and
   when you pass last time's value; Stop logs the seconds.
   ========================================================= */
const STOPWATCH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="14" r="7.5"/><path d="M12 14V10M10 2.5h4M18.5 6.5l1.5-1.5"/></svg>`;
const READY_SECONDS = 5;
const RING_C = 2 * Math.PI * 52;
const timerDlg = document.getElementById("timer");
let timer = null, audioCtx = null;

function beep(freq, dur) {
  try {
    if (!audioCtx) return;
    const t = audioCtx.currentTime, o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "sine"; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(t); o.stop(t + dur + 0.02);
  } catch (e) {}
}
function buzz(pattern) { if (navigator.vibrate) navigator.vibrate(pattern); }

function openTimer(ei) {
  const se = state.active.exercises[ei];
  const ex = exDef(state.active.workout, se.exId);
  const si = se.sets.findIndex(st => !st.done);           // -1 means all done: this becomes an extra set
  const prev = getPrevious(ex, state.active.workout, se.variant, state.history.length);
  const target = !prev ? null : si >= 0 ? se.sets[si].value : se.sets[se.sets.length - 1]?.value ?? ex.target;
  const setNo = si >= 0 ? si + 1 : se.sets.length + 1;
  const perSide = isPerSide(ex, se.variant);

  // Audio must be unlocked by a tap, which this is.
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (e) { audioCtx = null; }

  timer = { ei, si, ex, target, phase: "ready", readyEnd: Date.now() + READY_SECONDS * 1000,
            start: null, passed: false, lastCount: null, interval: null };

  timerDlg.innerHTML = `
    <div class="timer-body">
      <div>
        <h2 id="timer-title">${ex.name}</h2>
        <p class="muted">Set ${setNo}${si < 0 ? " (extra)" : ""}${perSide ? `, one ${SIDE_WORD}` : ""}. ${target === null ? "Hold as long as you can" : `${prev.source === "plan" ? "Plan" : "Last time"} ${target}s`}</p>
      </div>
      <div class="ring ready" id="ring">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <circle class="track" cx="60" cy="60" r="52"/>
          <circle class="fill" id="ring-fill" cx="60" cy="60" r="52" stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C}"/>
        </svg>
        <div class="ring-inner">
          <div class="ring-num" id="ring-num" aria-live="off">${READY_SECONDS}</div>
          <div class="ring-label" id="ring-label">Get into position</div>
        </div>
      </div>
      <div class="timer-actions">
        <button type="button" class="btn primary huge" id="timer-main">Start now</button>
        <button type="button" class="btn ghost" id="timer-cancel">Cancel</button>
      </div>
    </div>`;
  timerDlg.showModal();
  timer.interval = setInterval(tick, 100);
  tick();
}

function goTimer() {
  timer.phase = "run";
  timer.start = Date.now();
  beep(880, 0.35); buzz(120);
  document.getElementById("ring").classList.remove("ready");
  document.getElementById("ring-label").textContent = timer.target === null ? "Keep going" : `Beat ${timer.target}s`;
  document.getElementById("timer-main").textContent = "Stop and save";
}

function tick() {
  if (!timer) return;
  const now = Date.now();
  const num = document.getElementById("ring-num");
  const fill = document.getElementById("ring-fill");

  if (timer.phase === "ready") {
    const left = Math.ceil((timer.readyEnd - now) / 1000);
    if (left !== timer.lastCount) {
      timer.lastCount = left;
      if (left > 0 && left <= 3) beep(660, 0.1);
      num.textContent = Math.max(left, 0);
    }
    if (now >= timer.readyEnd) goTimer();
    return;
  }

  const elapsed = (now - timer.start) / 1000;
  num.textContent = Math.floor(elapsed);
  if (timer.target === null) return;
  const pct = Math.min(elapsed / Math.max(timer.target, 1), 1);
  fill.setAttribute("stroke-dashoffset", RING_C * (1 - pct));
  if (!timer.passed && elapsed >= timer.target) {
    timer.passed = true;
    beep(1047, 0.45); buzz([80, 60, 80]);
    document.getElementById("ring").classList.add("passed");
    document.getElementById("ring-label").textContent = "Past last time";
  }
}

timerDlg.addEventListener("click", e => {
  if (!timer) return;
  if (e.target.closest("#timer-cancel")) { timerDlg.close(); return; }
  if (e.target.closest("#timer-main")) {
    if (timer.phase === "ready") { goTimer(); tick(); return; }
    const value = Math.max(1, Math.floor((Date.now() - timer.start) / 1000));
    const sets = state.active.exercises[timer.ei].sets;
    if (timer.si >= 0) { sets[timer.si].value = value; sets[timer.si].done = true; popTarget = [timer.ei, timer.si]; }
    else { sets.push({ value, done: true, extra: true }); popTarget = [timer.ei, sets.length - 1]; }
    save();
    buzz(12);
    timerDlg.close();
  }
});
// Android back button or Cancel: nothing is saved.
timerDlg.addEventListener("close", () => {
  if (timer) clearInterval(timer.interval);
  timer = null;
  render();
});

/* =========================================================
   BACKUP AND RESTORE
   Backups contain finished workouts only. Restore adds any
   workouts not already on this phone; it never deletes.
   ========================================================= */
function unbackedCount() {
  if (!state.lastBackupAt) return state.history.length;
  return state.history.filter(s => (s.updatedAt || s.finishedAt) > state.lastBackupAt).length;
}
function markBackedUp() {
  state.lastBackupAt = new Date().toISOString();
  save();
  render();
  toast("Backup saved");
}
async function exportBackup() {
  const payload = { app: "kb-tracker", profile: CONFIG.id, version: 1, exportedAt: new Date().toISOString(), history: state.history };
  const json = JSON.stringify(payload);
  const name = `${CONFIG.id === "main" ? "kb-tracker" : "kb-tracker-" + CONFIG.id}-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([json], { type: "application/json" });

  // Prefer the Android share sheet (save to Drive, email it to yourself, etc.).
  try {
    const file = new File([blob], name, { type: "application/json" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: `${CONFIG.appName} backup` });
      markBackedUp();
      return;
    }
  } catch (e) {
    if (e && e.name === "AbortError") return; // closed the share sheet
  }
  // Fallback: plain download to the Downloads folder.
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  markBackedUp();
}

function isValidSession(x) {
  return x && typeof x.id === "string" && ROUTINE[x.workout] && typeof x.finishedAt === "string" &&
         Array.isArray(x.exercises) && x.exercises.every(e => e && typeof e.exId === "string" && Array.isArray(e.sets));
}
document.getElementById("restore-input").addEventListener("change", async e => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch (err) { data = null; }
  if (!data || data.app !== "kb-tracker" || !Array.isArray(data.history)) {
    toast(`That file isn’t a ${CONFIG.appName} backup`);
    return;
  }
  if ((data.profile || "main") !== CONFIG.id) {
    toast("That backup is from a different tracker");
    return;
  }
  const have = new Set(state.history.map(s => s.id));
  const incoming = data.history.filter(isValidSession).filter(s => !have.has(s.id));
  if (!incoming.length) { toast("Nothing new in that backup"); return; }
  const keep = state.history.length;
  if (!confirm(`Add ${incoming.length} workout${incoming.length === 1 ? "" : "s"} from this backup? ${keep ? `Your ${keep} existing workout${keep === 1 ? "" : "s"} stay as they are.` : ""}`)) return;
  state.history = state.history.concat(incoming).sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));
  if (!state.lastBackupAt || (data.exportedAt && data.exportedAt > state.lastBackupAt)) state.lastBackupAt = data.exportedAt || new Date().toISOString();
  save();
  render();
  toast(`${incoming.length} workout${incoming.length === 1 ? "" : "s"} restored`);
});

/* =========================================================
   BOOT
   ========================================================= */
render();

if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => navigator.serviceWorker.register(CONFIG.swPath || "sw.js").catch(() => {}));
}
