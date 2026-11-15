import {
  CONF_TZ, pad, toMin, fromMin, utcToZoned, normalize, sessionId,
  csvToSessions, icsToSessions, sessionsToICS,
} from './parsers.js';

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------
const STORE_KEY = 'scplanner:v1';
const MASTER_KEY = 'scplanner:master';
const TYPES = {
  keynote: 'Keynote', tutorial: 'Tutorial', workshop: 'Workshop', paper: 'Paper / Talk',
  bof: 'BoF', panel: 'Panel', poster: 'Poster', exhibit: 'Exhibit', social: 'Social',
  award: 'Award', meeting: 'Meeting', community: 'Community', student: 'Students', other: 'Other',
};
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------
const defaults = () => ({
  starred: [], custom: [], notes: {}, friends: [],
  settings: { theme: 'auto', name: '', hidePast: true },
});
let store = load();
let master = loadMaster();
const ui = {
  day: null,          // selected yyyy-mm-dd
  q: '',              // search
  types: new Set(),   // type filter
  myAll: false,       // My view: all days vs single day
  friend: null,       // index of friend being viewed
  pendingShare: null, // decoded share payload awaiting action
};

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s) return { ...defaults(), ...s, settings: { ...defaults().settings, ...s.settings } };
  } catch { /* ignore */ }
  return defaults();
}
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch (e) {
    // Storage full: drop the cached program copy (it can be re-downloaded) and retry.
    localStorage.removeItem(MASTER_KEY);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { toast('⚠️ Could not save — storage full'); }
  }
  askPersist();
}

// Ask the browser not to evict our data (no-op where unsupported).
let persistAsked = false;
function askPersist() {
  if (persistAsked || !navigator.storage?.persist) return;
  persistAsked = true;
  navigator.storage.persisted().then((p) => p || navigator.storage.persist()).catch(() => {});
}
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function loadMaster() {
  try {
    const m = JSON.parse(localStorage.getItem(MASTER_KEY));
    if (m && m.sessions) return prepMaster(m);
  } catch { /* ignore */ }
  return prepMaster({ conference: { name: 'SC26', tz: CONF_TZ, start: '2026-11-15', end: '2026-11-20' }, sessions: [] });
}
function prepMaster(m) {
  m.sessions = (m.sessions || []).map(normalize);
  return m;
}

const starred = () => new Set(store.starred);
function sortByTime(a, b) {
  return (a.date + a.start).localeCompare(b.date + b.start) || a.end.localeCompare(b.end) || a.title.localeCompare(b.title);
}
const conf = () => master.conference || {};
const tz = () => conf().tz || CONF_TZ;

// Unified index of all sessions (master + custom).
let index = new Map();
let children = new Map(); // parent session id -> talks
function rebuildIndex() {
  index = new Map();
  children = new Map();
  for (const s of master.sessions) index.set(s.id, s);
  for (const s of store.custom) index.set(s.id, { ...s, mine: true });
  for (const f of store.friends) for (const s of f.custom || []) if (!index.has(s.id)) index.set(s.id, { ...s, friendOnly: true });
  for (const s of index.values()) {
    if (s.parent && index.has(s.parent)) {
      if (!children.has(s.parent)) children.set(s.parent, []);
      children.get(s.parent).push(s);
    }
    if (!s.hay) {
      Object.defineProperty(s, 'hay', {
        value: `${s.title} ${s.room || ''} ${s.speakers || ''} ${s.track || ''} ${s.cat || ''} ${s.description || ''} ${TYPES[s.type] || ''}`.toLowerCase(),
        enumerable: false,
      });
    }
  }
  for (const list of children.values()) list.sort(sortByTime);
}
rebuildIndex();

const allSessions = () => [...index.values()].filter((s) => !s.friendOnly);

function mySessions() {
  if (ui.friend != null && store.friends[ui.friend]) {
    const f = store.friends[ui.friend];
    const ids = new Set(f.ids);
    return [...index.values()].filter((s) => ids.has(s.id)).sort(sortByTime);
  }
  const st = starred();
  return [...index.values()].filter((s) => st.has(s.id) && !s.friendOnly).sort(sortByTime);
}

function friendsFor(id) {
  return store.friends.filter((f) => f.ids.includes(id));
}

// ------------------------------------------------------------------
// Time
// ------------------------------------------------------------------
function now() {
  const p = new URLSearchParams(location.search).get('now'); // debug: ?now=2026-11-17T10:15
  if (p) {
    const [d, t] = p.split('T');
    return { date: d, min: toMin(t || '09:00') };
  }
  const z = utcToZoned(new Date(), tz());
  return { date: z.date, min: toMin(z.time) };
}

function confDays() {
  const c = conf();
  const days = [];
  if (c.start && c.end) {
    const d = new Date(c.start + 'T12:00:00Z');
    const end = new Date(c.end + 'T12:00:00Z');
    while (d <= end) { days.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  }
  for (const s of index.values()) if (!days.includes(s.date)) days.push(s.date);
  return days.sort();
}

function dayLabel(date, long = false) {
  const d = new Date(date + 'T12:00:00Z');
  if (long) return `${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getUTCDay()]}, ${MON[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return { dow: DOW[d.getUTCDay()], num: d.getUTCDate() };
}

function fmtTime(hhmm) {
  let [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return m ? `${h}:${pad(m)}${ap}` : `${h}${ap}`;
}
function fmtDur(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

function status(s, n = now()) {
  if (s.date < n.date) return 'past';
  if (s.date > n.date) return 'future';
  if (toMin(s.end) <= n.min) return 'past';
  if (toMin(s.start) <= n.min) return 'now';
  return 'future';
}

function defaultDay() {
  const days = confDays();
  const t = now().date;
  if (days.includes(t)) return t;
  if (t < days[0]) return days[0];
  return days[0] || t;
}

// ------------------------------------------------------------------
// Rendering helpers
// ------------------------------------------------------------------
// Long blocks (exhibit floor, all-day tutorials) are "background" and don't count as clashes.
const isBackground = (s) => s.type === 'exhibit' || toMin(s.end) - toMin(s.start) >= 240;

function conflictsIn(all) {
  const bad = new Set();
  const list = all.filter((s) => !isBackground(s));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.date !== b.date) continue;
      if (toMin(b.start) >= toMin(a.end)) continue;
      if (a.parent === b.id || b.parent === a.id) continue;
      if (toMin(a.start) < toMin(b.end) && toMin(b.start) < toMin(a.end)) { bad.add(a.id); bad.add(b.id); }
    }
  }
  return bad;
}

function initials(name) {
  return (name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

function card(s, { conflict = false, showDay = false, n = now() } = {}) {
  const st = starred().has(s.id);
  const stt = status(s, n);
  const fr = friendsFor(s.id);
  const kids = children.get(s.id);
  const par = s.parent && index.get(s.parent);
  const meta = [
    s.room && `<span class="room">📍 ${esc(s.room)}</span>`,
    `<span>${esc(s.cat || TYPES[s.type] || 'Other')}</span>`,
    s.speakers && `<span class="who">${esc(s.speakers)}</span>`,
  ].filter(Boolean).join('<i>·</i>');
  return `<article class="card t-${s.type} ${st ? 'starred' : ''} ${stt} ${conflict ? 'conflict' : ''}" data-id="${s.id}" tabindex="0">
    <div class="time">${showDay ? `<b class="dd">${dayLabel(s.date).dow}</b>` : ''}<span>${fmtTime(s.start)}</span><small>${fmtTime(s.end)}</small></div>
    <div class="body">
      <h3>${esc(s.title)}</h3>
      <p class="meta">${meta}</p>
      ${par ? `<p class="parent">in ${esc(par.title)}</p>` : ''}
      ${kids ? `<span class="pill">${kids.length} talk${kids.length === 1 ? '' : 's'}</span>` : ''}${stt === 'now' ? '<span class="pill live">Now</span>' : ''}${conflict ? '<span class="pill warn">Overlap</span>' : ''}${s.mine ? '<span class="pill">Added by you</span>' : ''}${store.notes[s.id] ? '<span class="pill">📝 Note</span>' : ''}
      ${fr.length ? `<span class="friends">${fr.map((f) => `<b title="${esc(f.name)}">${esc(initials(f.name))}</b>`).join('')}</span>` : ''}
    </div>
    <button class="star" aria-label="${st ? 'Remove from' : 'Add to'} my schedule" aria-pressed="${st}">${st ? '★' : '☆'}</button>
  </article>`;
}

function renderDays() {
  const nav = $('#days');
  const show = ['my', 'all'].includes(route().name) && !(route().name === 'my' && ui.myAll) && !(route().name === 'all' && ui.q);
  nav.hidden = !show;
  if (!show) return;
  const mine = mySessions();
  const t = now().date;
  nav.innerHTML = confDays().map((d) => {
    const { dow, num } = dayLabel(d);
    const count = mine.filter((s) => s.date === d).length;
    return `<button class="day ${d === ui.day ? 'on' : ''} ${d === t ? 'today' : ''}" data-day="${d}" aria-pressed="${d === ui.day}">
      <span>${d === t ? 'Today' : dow}</span><b>${num}</b>${count ? `<i>${count}</i>` : '<i class="z"></i>'}
    </button>`;
  }).join('');
  const on = $('.day.on', nav);
  if (on) on.scrollIntoView({ block: 'nearest', inline: 'center' });
}

// ------------------------------------------------------------------
// Views
// ------------------------------------------------------------------
function viewMy() {
  const n = now();
  const friend = ui.friend != null ? store.friends[ui.friend] : null;
  const mine = mySessions();
  const conflicts = conflictsIn(mine);
  let html = '';

  if (friend) {
    html += `<div class="banner friend"><div><b>${esc(friend.name)}'s schedule</b><br><small>${friend.ids.length} sessions · shared ${esc(friend.added || '')}</small></div>
      <div class="row"><button class="btn sm" data-act="merge-friend">Add all to mine</button><button class="btn sm ghost" data-act="close-friend">Close</button></div></div>`;
  }

  // Now / next card
  if (!friend) html += nowCard(mine, n);

  if (!friend && !store.settings.tipDone) {
    html += isStandalone()
      ? `<div class="banner tip">💾 Everything you star is saved on this phone. Tip: under <b>More → Backup</b>, copy a backup link once in a while. <button class="link" data-act="dismiss-tip">Got it</button></div>`
      : `<div class="banner tip">📲 <b>Install it:</b> tap Share → <b>Add to Home Screen</b> so it opens instantly, works offline and keeps your stars. The Home Screen app has its own storage, so do this <i>before</i> starring (or move stars over with More → Backup link). <button class="link" data-act="dismiss-tip">Got it</button></div>`;
  }

  html += `<div class="seg" role="tablist">
    <button class="${!ui.myAll ? 'on' : ''}" data-act="my-day">${esc(dayLabel(ui.day, true))}</button>
    <button class="${ui.myAll ? 'on' : ''}" data-act="my-all">All days (${mine.length})</button>
  </div>`;

  if (!friend && mine.length) {
    html += `<div class="row sharebar"><button class="btn sm primary" data-act="share">🔗 Share my schedule</button><button class="btn sm" data-act="copytext">📋 Copy as text</button></div>`;
  }

  const list = ui.myAll ? mine : mine.filter((s) => s.date === ui.day);
  if (!list.length) {
    html += `<div class="empty">
      <p>${ui.myAll ? 'Your schedule is empty.' : 'Nothing planned this day.'}</p>
      <p><a class="btn" href="#/all">Browse full schedule</a> <a class="btn ghost" href="#/add">+ Add your own</a></p>
      <p class="hint">Tap ☆ on any session to add it here. Works offline once loaded.</p>
    </div>`;
    return html;
  }

  let lastDay = null, lastEnd = null;
  html += '<div class="list">';
  for (const s of list) {
    if (ui.myAll && s.date !== lastDay) {
      html += `<h2 class="dayhead">${esc(dayLabel(s.date, true))}</h2>`;
      lastEnd = null;
    }
    if (lastEnd != null && toMin(s.start) - lastEnd >= 15) {
      html += `<div class="gap">☕ ${fmtDur(toMin(s.start) - lastEnd)} free</div>`;
    }
    lastDay = s.date;
    lastEnd = Math.max(lastEnd ?? 0, toMin(s.end));
    html += card(s, { conflict: conflicts.has(s.id), n });
  }
  html += '</div>';
  if (conflicts.size) html += `<p class="hint center">⚠️ ${conflicts.size} sessions overlap — tap one to decide.</p>`;
  return html;
}

function nowCard(mine, n) {
  const days = confDays();
  if (n.date < days[0]) {
    const diff = Math.round((new Date(days[0] + 'T12:00:00Z') - new Date(n.date + 'T12:00:00Z')) / 864e5);
    return `<div class="nowcard pre"><div><small>${esc(conf().name || 'Conference')} starts in</small><b>${diff} day${diff === 1 ? '' : 's'}</b></div>
      <div class="sub">${esc(conf().venue || '')} · ${mine.length} session${mine.length === 1 ? '' : 's'} planned</div></div>`;
  }
  if (!days.includes(n.date)) return '';
  const today = mine.filter((s) => s.date === n.date);
  const live = today.filter((s) => status(s, n) === 'now');
  // Prefer specific sessions over all-day background blocks (shuttle, exhibit floor...).
  const cur = live.some((s) => !isBackground(s)) ? live.filter((s) => !isBackground(s)) : live.slice(0, 1);
  const next = today.find((s) => toMin(s.start) > n.min);
  if (!cur.length && !next) {
    return `<div class="nowcard"><div><small>Right now</small><b>Nothing else planned today</b></div>
      <a class="btn sm" href="#/all" data-act="jump-now">What's on now →</a></div>`;
  }
  let h = '<div class="nowcard">';
  for (const s of cur) {
    const left = toMin(s.end) - n.min;
    h += `<button class="nowitem" data-id="${s.id}"><small>Now · ends in ${fmtDur(left)}</small><b>${esc(s.title)}</b>${s.room ? `<span>📍 ${esc(s.room)}</span>` : ''}</button>`;
  }
  if (next) {
    const inn = toMin(next.start) - n.min;
    h += `<button class="nowitem next" data-id="${next.id}"><small>Next · ${fmtTime(next.start)} (in ${fmtDur(inn)})</small><b>${esc(next.title)}</b>${next.room ? `<span>📍 ${esc(next.room)}</span>` : ''}</button>`;
  }
  return h + '</div>';
}

function viewAll() {
  const n = now();
  const q = ui.q.trim().toLowerCase();
  const all = allSessions();
  const typesPresent = [...new Set(all.filter((s) => !s.parent).map((s) => s.type))].sort((a, b) => Object.keys(TYPES).indexOf(a) - Object.keys(TYPES).indexOf(b));
  let list = all;
  if (q) {
    const terms = q.split(/\s+/);
    list = list.filter((s) => terms.every((t) => s.hay.includes(t)));
  } else {
    list = list.filter((s) => s.date === ui.day && !s.parent);
  }
  if (ui.types.size) list = list.filter((s) => ui.types.has(s.type));
  const isToday = !q && ui.day === n.date;
  let hiddenPast = 0;
  if (isToday && store.settings.hidePast) {
    const before = list.length;
    list = list.filter((s) => status(s, n) !== 'past');
    hiddenPast = before - list.length;
  }
  list.sort(sortByTime);
  const total = list.length;
  if (q && list.length > 150) list = list.slice(0, 150);

  let html = `<div class="toolbar">
    <div class="search"><input id="q" type="search" placeholder="Search title, speaker, room… (press /)" value="${esc(ui.q)}" autocomplete="off" enterkeyhint="search"></div>
    <div class="chips">${typesPresent.map((t) => `<button class="chip t-${t} ${ui.types.has(t) ? 'on' : ''}" data-type="${t}">${TYPES[t]}</button>`).join('')}</div>
  </div>`;

  if (master.notice) html += `<div class="banner notice">ℹ️ ${esc(master.notice)}</div>`;

  html += `<p class="count">${total} result${total === 1 ? '' : 's'}${q && total > list.length ? ` (showing first ${list.length})` : ''}${q ? ` matching “${esc(ui.q)}” across all days` : ` · ${esc(dayLabel(ui.day, true))}`}
    ${isToday ? `<button class="link" data-act="toggle-past">${store.settings.hidePast ? `Show ${hiddenPast} earlier` : 'Hide earlier'}</button>` : ''}</p>`;

  if (!list.length) {
    html += `<div class="empty"><p>No sessions found.</p>${!all.length ? '<p class="hint">No program loaded yet. Go to More → Import to load the official schedule.</p>' : ''}</div>`;
    return html;
  }

  html += '<div class="list">';
  let lastKey = null;
  let nowMarked = !isToday;
  for (const s of list) {
    if (!nowMarked && toMin(s.start) > n.min) {
      html += `<div class="nowline" id="nowline"><span>Now · ${fmtTime(fromMin(n.min))}</span></div>`;
      nowMarked = true;
    }
    const key = q ? s.date : s.start;
    if (key !== lastKey) {
      html += q ? `<h2 class="dayhead">${esc(dayLabel(s.date, true))}</h2>` : `<h2 class="slot">${fmtTime(s.start)}</h2>`;
      lastKey = key;
    }
    html += card(s, { n });
  }
  html += '</div>';
  return html;
}

function viewAdd(editId) {
  const s = editId ? index.get(editId) : null;
  if (editId && (!s || !s.mine)) return '<div class="empty"><p>That item can’t be edited.</p></div>';
  const n = now();
  const day = s?.date || ui.day;
  let start = s?.start;
  if (!start) {
    const base = day === n.date ? Math.ceil(n.min / 30) * 30 : 9 * 60;
    start = fromMin(Math.min(base, 23 * 60));
  }
  const dur = s ? toMin(s.end) - toMin(s.start) : 60;
  const days = confDays();
  return `<form id="addform" class="form" autocomplete="off">
    <h2>${s ? 'Edit item' : 'Add to my schedule'}</h2>
    <p class="hint">For meetings, booth visits, dinners — or any session not in the list.</p>
    <label>Title<input name="title" required value="${esc(s?.title || '')}" placeholder="e.g. Meet with NVIDIA team"></label>
    <div class="grid2">
      <label>Day<select name="date">${days.map((d) => `<option value="${d}" ${d === day ? 'selected' : ''}>${esc(dayLabel(d, true))}</option>`).join('')}</select></label>
      <label>Start<input name="start" type="time" required value="${start}" step="300"></label>
    </div>
    <label>Duration</label>
    <div class="chips dur">${[15, 30, 45, 60, 90, 120, 180].map((m) => `<button type="button" class="chip ${m === dur ? 'on' : ''}" data-dur="${m}">${fmtDur(m)}</button>`).join('')}
      <input name="end" type="time" value="${fromMin(toMin(start) + dur)}" step="300" aria-label="End time"></div>
    <label>Where<input name="room" value="${esc(s?.room || '')}" placeholder="Room, booth #, restaurant…" list="rooms"></label>
    <datalist id="rooms">${[...new Set(allSessions().map((x) => x.room).filter(Boolean))].sort().slice(0, 300).map((r) => `<option value="${esc(r)}">`).join('')}</datalist>
    <label>Type<select name="type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${(s?.type || 'meeting') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label>Link <small>(optional)</small><input name="url" type="url" value="${esc(s?.url || '')}" placeholder="https://"></label>
    <label>Details <small>(optional)</small><textarea name="description" rows="3" placeholder="Who, agenda, contact…">${esc(s?.description || '')}</textarea></label>
    <div class="row end">
      ${s ? `<button type="button" class="btn danger ghost" data-act="delete" data-id="${s.id}">Delete</button>` : ''}
      <button class="btn primary" type="submit">${s ? 'Save' : 'Add to my schedule'}</button>
    </div>
    <input type="hidden" name="editId" value="${s?.id || ''}">
  </form>`;
}

function viewMore() {
  const c = conf();
  return `<div class="more">
    <section>
      <h2>Share</h2>
      <label>Your name <small>(shown to people you share with)</small><input id="myname" value="${esc(store.settings.name)}" placeholder="e.g. Alex"></label>
      <div class="row wrap">
        <button class="btn primary" data-act="share">🔗 Share my schedule</button>
        <button class="btn" data-act="copytext">📋 Copy as text</button>
        <button class="btn" data-act="ics">📅 Add all to calendar (.ics)</button>
      </div>
      <p class="hint">“Copy as text” gives a plain list you can paste into Slack, email or a text message. Re-share after you change your plans — a link is a snapshot.<br>Sharing creates a link containing your picks — no account or server needed. Friends who open it can see where you’ll be and their initials show up on sessions.</p>
    </section>

    ${store.friends.length ? `<section><h2>Friends’ schedules</h2><ul class="friendlist">${store.friends.map((f, i) => `
      <li><b class="av">${esc(initials(f.name))}</b><span>${esc(f.name)}<small>${f.ids.length} sessions</small></span>
      <button class="btn sm" data-act="view-friend" data-i="${i}">View</button><button class="btn sm ghost" data-act="del-friend" data-i="${i}">Remove</button></li>`).join('')}</ul></section>` : ''}

    <section>
      <h2>Open a link</h2>
      <p class="hint">Got a schedule link from a friend, or your own backup link? If you use the Home Screen app, paste it here (links tapped in Messages open in Safari instead).</p>
      <div class="row">
        <input id="linkin" placeholder="Paste link here" autocomplete="off" autocapitalize="off" spellcheck="false">
        <button class="btn" data-act="open-link">Open</button>
      </div>
      ${navigator.clipboard?.readText ? '<button class="link" data-act="paste-link">📋 Paste from clipboard</button>' : ''}
    </section>

    <section>
      <h2>Backup &amp; move to another device</h2>
      <p class="hint">Your stars, notes and your own events live on this phone. Make a backup link and keep it somewhere safe (send it to yourself, or put it in Notes). Opening that link restores everything, on this phone or a new one.</p>
      <div class="row wrap">
        <button class="btn primary" data-act="backup-link">💾 Copy backup link</button>
      </div>
      <p class="hint" id="persistinfo"></p>
    </section>

    <section>
      <h2>Conference</h2>
      <p><b>${esc(c.fullName || c.name || '')}</b><br>${esc(c.venue || '')}${c.start ? ` · ${esc(dayLabel(c.start, true))} – ${esc(dayLabel(c.end, true))}` : ''}<br><small>All times are ${esc(tz().replace('_', ' '))} (venue local).</small></p>
      <div class="row wrap">
        ${c.url ? `<a class="btn" href="${esc(c.url)}" target="_blank" rel="noopener">Official site ↗</a>` : ''}
        ${c.programUrl ? `<a class="btn" href="${esc(c.programUrl)}" target="_blank" rel="noopener">Official program ↗</a>` : ''}
        ${c.venueMap ? `<a class="btn" href="${esc(c.venueMap)}" target="_blank" rel="noopener">🗺️ Venue map</a>` : ''}
      </div>
      <p class="hint">Program: ${master.sessions.length} sessions &amp; talks${master.source ? ` from the ${esc(master.source)}` : ''}${master.updated ? `, updated ${esc(master.updated)}` : ''}. <button class="link" data-act="refresh">Check for updates</button></p>
    </section>

    <section>
      <h2>Settings</h2>
      <label>Theme<select id="theme">${['auto', 'light', 'dark'].map((t) => `<option ${store.settings.theme === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <div class="row wrap">
        <button class="btn danger ghost" data-act="reset">Clear my data</button>
      </div>
    </section>

    <details class="adv"><summary>Advanced: import a calendar or spreadsheet</summary>
      <section>
        <p class="hint">Add sessions from an .ics, .csv or JSON file, or paste the text.</p>
        <label class="btn file">📂 Choose file<input type="file" id="importfile" accept=".ics,.csv,.tsv,.json,.txt,text/calendar,text/csv,application/json" hidden></label>
        <textarea id="importtext" rows="4" placeholder="…or paste .ics / CSV / JSON text"></textarea>
        <button class="btn" data-act="import-paste">Import pasted text</button>
        <label class="check"><input type="checkbox" id="importstar" checked> Add imported items to my schedule (★)</label>
        <button class="btn" data-act="backup">⬇️ Download backup file</button>
      </section>
    </details>
  </div>`;
}

// ------------------------------------------------------------------
// Detail sheet
// ------------------------------------------------------------------
function openDetail(id) {
  const s = index.get(id);
  if (!s) return;
  const st = starred().has(id);
  const fr = friendsFor(id);
  const sameTime = isBackground(s) ? [] : mySessions().filter((x) => x.id !== id && !isBackground(x) && x.date === s.date && toMin(x.start) < toMin(s.end) && toMin(s.start) < toMin(x.end));
  const sheet = $('#sheet');
  sheet.innerHTML = `<div class="sheet t-${s.type}" data-id="${id}">
    <div class="grab"></div>
    <button class="x" data-act="close" aria-label="Close">✕</button>
    <span class="type">${esc(s.cat || TYPES[s.type] || 'Other')}</span>
    <h2>${esc(s.title)}</h2>
    <p class="when">🕒 ${esc(dayLabel(s.date, true))} · ${fmtTime(s.start)}–${fmtTime(s.end)} <small>(${fmtDur(toMin(s.end) - toMin(s.start))})</small></p>
    ${s.room ? `<p class="when">📍 ${esc(s.room)}</p>` : ''}
    ${s.speakers ? `<p class="when">👤 ${esc(s.speakers)}</p>` : ''}
    ${fr.length ? `<p class="when">👥 Also going: ${fr.map((f) => esc(f.name)).join(', ')}</p>` : ''}
    ${sameTime.length ? `<div class="banner warn">⚠️ Overlaps with ${sameTime.map((x) => `<a href="#" data-open="${x.id}">${esc(x.title)}</a>`).join(', ')}</div>` : ''}
    <div class="row wrap actions">
      <button class="btn ${st ? '' : 'primary'}" data-act="star">${st ? '★ In my schedule' : '☆ Add to my schedule'}</button>
      <button class="btn" data-act="ics1">📅 Calendar</button>
      ${navigator.share ? '<button class="btn" data-act="share1">Share</button>' : ''}
      ${s.url ? `<a class="btn" href="${esc(s.url)}" target="_blank" rel="noopener">Details ↗</a>` : ''}
      ${s.mine ? `<a class="btn ghost" href="#/edit/${id}">Edit</a>` : ''}
    </div>
    ${s.parent && index.get(s.parent) ? `<p class="when">📂 Part of <a href="#" data-open="${s.parent}">${esc(index.get(s.parent).title)}</a></p>` : ''}
    ${s.track ? `<p class="hint">🏷️ ${esc(s.track)}</p>` : ''}
    ${s.description ? `<div class="desc">${esc(s.description).replace(/\n/g, '<br>')}</div>` : ''}
    ${children.get(id) ? `<h3 class="talkhead">Talks in this session (${children.get(id).length})</h3><div class="talks">${children.get(id).map((k) => {
      const ks = starred().has(k.id);
      return `<div class="talk ${ks ? 'starred' : ''}" data-open="${k.id}"><span class="tt">${fmtTime(k.start)}</span><span class="tn">${esc(k.title)}${k.speakers ? `<small>${esc(k.speakers)}</small>` : ''}</span><button class="star" data-star="${k.id}" aria-label="Star talk">${ks ? '★' : '☆'}</button></div>`;
    }).join('')}</div>` : ''}
    <label class="notes">My notes<textarea id="note" rows="3" placeholder="Questions to ask, people to meet, takeaways…">${esc(store.notes[id] || '')}</textarea></label>
  </div>`;
  if (!sheet.open) sheet.showModal();
}

function closeSheet() {
  const sheet = $('#sheet');
  if (sheet.open) sheet.close();
}

// ------------------------------------------------------------------
// Actions
// ------------------------------------------------------------------
function toggleStar(id) {
  const st = new Set(store.starred);
  if (st.has(id)) { st.delete(id); toast('Removed from my schedule', () => { store.starred.push(id); save(); render(); }); }
  else { st.add(id); toast('★ Added to my schedule'); }
  store.starred = [...st];
  save();
}

let toastTimer;
function toast(msg, undo) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button>Undo</button>' : ''}`;
  t.classList.add('show');
  if (undo) $('button', t).onclick = () => { undo(); t.classList.remove('show'); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function shareOrCopy(data) {
  if (navigator.share) {
    try { await navigator.share(data); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(data.url || data.text);
    toast('Link copied to clipboard');
  } catch {
    prompt('Copy this link:', data.url || data.text);
  }
}

// --- share link encoding (base64url of deflated JSON) ---
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function streamBytes(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

async function encodePlan(obj) {
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  if ('CompressionStream' in window) {
    try { return 'z' + b64u(await streamBytes(raw, new CompressionStream('deflate-raw'))); } catch { /* fall through */ }
  }
  return 'j' + b64u(raw);
}

async function decodePlan(str) {
  const kind = str[0];
  let bytes = unb64u(str.slice(1));
  if (kind === 'z') bytes = await streamBytes(bytes, new DecompressionStream('deflate-raw'));
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function shareMine() {
  const ids = store.starred.filter((id) => index.has(id));
  if (!ids.length) return toast('Your schedule is empty — star some sessions first');
  const masterIds = ids.filter((id) => !index.get(id).mine);
  const custom = store.custom.filter((s) => ids.includes(s.id)).map(({ id, title, date, start, end, room, type }) => ({ id, title, date, start, end, room, type }));
  const code = await encodePlan({ v: 1, n: store.settings.name || '', s: masterIds, c: custom });
  const url = `${location.origin}${location.pathname}#plan=${code}`;
  const who = store.settings.name ? `${store.settings.name}'s` : 'My';
  shareOrCopy({ title: `${who} ${conf().name || ''} schedule`, text: `${who} ${conf().name || 'conference'} schedule (${ids.length} sessions)`, url });
}

function planAsText() {
  const list = mySessions();
  if (!list.length) return 'My schedule is empty.';
  const who = store.settings.name ? `${store.settings.name}'s` : 'My';
  let out = `${who} ${conf().name || ''} schedule (times ${tz().split('/').pop().replace('_', ' ')})\n`;
  let day = null;
  for (const s of list) {
    if (s.date !== day) { out += `\n${dayLabel(s.date, true)}\n`; day = s.date; }
    out += `• ${fmtTime(s.start)}–${fmtTime(s.end)}  ${s.title}${s.room ? ` (${s.room})` : ''}\n`;
  }
  return out;
}

function exportICS(list, name) {
  if (!list.length) return toast('Nothing to export');
  download(name, sessionsToICS(list, { tz: tz(), name: `${conf().name || ''} schedule`, notes: store.notes }), 'text/calendar');
}

function importSessions(sessions, { star = true, label = 'Imported' } = {}) {
  if (!sessions.length) return toast('No sessions found in that file');
  const existing = new Set(index.keys());
  let added = 0, starredN = 0;
  const st = new Set(store.starred);
  for (const s of sessions) {
    const n = normalize(s);
    if (!existing.has(n.id)) { store.custom.push(n); existing.add(n.id); added++; }
    if (star && !st.has(n.id)) { st.add(n.id); starredN++; }
  }
  store.starred = [...st];
  save();
  rebuildIndex();
  toast(`${label}: ${sessions.length} sessions (${added} new${star ? `, ${starredN} starred` : ''})`);
  render();
}

function importText(text, filename = '') {
  const star = $('#importstar')?.checked ?? true;
  text = text.replace(/^﻿/, '');
  try {
    if (/BEGIN:VCALENDAR/i.test(text)) return importSessions(icsToSessions(text, tz()), { star });
    const t = text.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      const j = JSON.parse(t);
      if (j && j.starred && j.settings) { // backup file
        if (!confirm('Restore this backup? It replaces your current picks and notes.')) return;
        store = { ...defaults(), ...j };
        save(); rebuildIndex(); toast('Backup restored'); return render();
      }
      const arr = Array.isArray(j) ? j : j.sessions || [];
      return importSessions(arr.filter((s) => s.title && s.date && s.start), { star });
    }
    if (/\.(csv|tsv)$/i.test(filename) || /,|\t/.test(t.split('\n')[0])) return importSessions(csvToSessions(text), { star });
    toast('Could not recognise that format');
  } catch (e) {
    console.error(e);
    toast(`Import failed: ${e.message}`);
  }
}

async function refreshMaster(manual = false) {
  try {
    const r = await fetch('data/schedule.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    const m = await r.json();
    const changed = JSON.stringify(m) !== localStorage.getItem(MASTER_KEY);
    if (changed) {
      try { localStorage.setItem(MASTER_KEY, JSON.stringify(m)); } catch { /* the service worker cache still has it */ }
      master = prepMaster(m);
      rebuildIndex();
      if (!ui.day || !confDays().includes(ui.day)) ui.day = defaultDay();
      // Don't wipe a form the user is typing in.
      if (['my', 'all'].includes(route().name)) render();
    }
    if (manual) toast(changed ? 'Schedule updated' : 'Schedule is up to date');
  } catch (e) {
    if (manual) toast('Offline — using saved schedule');
  }
}

async function backupLink() {
  const code = await encodePlan({ v: 1, starred: store.starred, custom: store.custom, notes: store.notes, friends: store.friends, name: store.settings.name });
  return `${location.origin}${location.pathname}#restore=${code}`;
}

async function handleShareHash(src = location.hash) {
  const r = src.match(/[#&]restore=([\w-]+)/);
  if (r) {
    try {
      const b = await decodePlan(r[1]);
      ui.pendingRestore = b;
      if (src === location.hash) history.replaceState(null, '', location.pathname + location.search + '#/my');
      const sheet = $('#sheet');
      sheet.innerHTML = `<div class="sheet">
        <button class="x" data-act="close" aria-label="Close">✕</button>
        <span class="type">Backup</span>
        <h2>Restore your schedule?</h2>
        <p>${(b.starred || []).length} starred · ${(b.custom || []).length} own events · ${Object.keys(b.notes || {}).length} notes · ${(b.friends || []).length} friends</p>
        <p class="hint">“Merge” keeps what’s already on this device and adds the backup.</p>
        <div class="row wrap actions">
          <button class="btn primary" data-act="restore-merge">Merge into this device</button>
          <button class="btn ghost danger" data-act="restore-replace">Replace everything</button>
        </div>
      </div>`;
      if (!sheet.open) sheet.showModal();
    } catch (e) {
      console.error(e);
      toast('That backup link looks broken');
    }
    return true;
  }
  const m = src.match(/[#&]plan=([\w-]+)/);
  if (!m) return false;
  try {
    const p = await decodePlan(m[1]);
    ui.pendingShare = p;
    if (src === location.hash) history.replaceState(null, '', location.pathname + location.search + '#/my');
    const name = p.n || 'Someone';
    const count = (p.s || []).length + (p.c || []).length;
    const sheet = $('#sheet');
    sheet.innerHTML = `<div class="sheet">
      <button class="x" data-act="close" aria-label="Close">✕</button>
      <span class="type">Shared schedule</span>
      <h2>${esc(name)} shared ${count} session${count === 1 ? '' : 's'} with you</h2>
      <p class="hint">Save it to see where ${esc(name)} will be — their initials appear on sessions you both might attend.</p>
      <label>Name<input id="friendname" value="${esc(p.n || '')}" placeholder="Their name"></label>
      <div class="row wrap actions">
        <button class="btn primary" data-act="save-friend">👀 View &amp; keep their schedule</button>
        <button class="btn" data-act="merge-share">★ Add all to my schedule</button>
      </div>
    </div>`;
    if (!sheet.open) sheet.showModal();
  } catch (e) {
    console.error(e);
    toast('That share link looks broken');
  }
  return true;
}

function restoreBackup(b, replace) {
  if (replace) {
    store = { ...defaults(), settings: store.settings };
  }
  const ids = new Set(store.custom.map((x) => x.id));
  for (const c of b.custom || []) if (!ids.has(c.id)) store.custom.push(c);
  store.starred = [...new Set([...store.starred, ...(b.starred || [])])];
  store.notes = { ...(b.notes || {}), ...store.notes };
  if (replace) store.notes = { ...(b.notes || {}) };
  for (const f of b.friends || []) if (!store.friends.some((x) => x.name === f.name)) store.friends.push(f);
  if (b.name && !store.settings.name) store.settings.name = b.name;
  save();
  rebuildIndex();
  toast('✅ Schedule restored');
}

function saveFriend(p, name) {
  const custom = (p.c || []).map(normalize);
  const ids = [...(p.s || []), ...custom.map((s) => s.id)];
  const f = { name: name || p.n || 'Friend', ids, custom, added: new Date().toISOString().slice(0, 10) };
  const i = store.friends.findIndex((x) => x.name.toLowerCase() === f.name.toLowerCase());
  if (i >= 0) store.friends[i] = f; else store.friends.push(f);
  save();
  rebuildIndex();
  return i >= 0 ? i : store.friends.length - 1;
}

function mergeIds(ids, custom = []) {
  for (const s of custom) if (!index.has(s.id) || index.get(s.id).friendOnly) store.custom.push(normalize(s));
  store.starred = [...new Set([...store.starred, ...ids])];
  save();
  rebuildIndex();
  toast(`Added ${ids.length} sessions to your schedule`);
}

// ------------------------------------------------------------------
// Routing & render
// ------------------------------------------------------------------
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [name, arg] = h.split('/');
  return { name: ['my', 'all', 'add', 'edit', 'more'].includes(name) ? name : 'my', arg };
}

function render() {
  const r = route();
  const view = $('#view');
  const focusedSearch = document.activeElement?.id === 'q';
  const caret = focusedSearch ? document.activeElement.selectionStart : 0;
  renderDays();
  $$('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === (r.name === 'edit' ? 'add' : r.name)));
  if (r.name === 'my') view.innerHTML = viewMy();
  else if (r.name === 'all') view.innerHTML = viewAll();
  else if (r.name === 'add') view.innerHTML = viewAdd();
  else if (r.name === 'edit') view.innerHTML = viewAdd(r.arg);
  else if (r.name === 'more') {
    view.innerHTML = viewMore();
    navigator.storage?.persisted?.().then((p) => {
      const el = $('#persistinfo');
      if (el) el.textContent = `${p ? '🔒 Storage is marked persistent on this device.' : ''}${store.settings.lastBackup ? ` Last backup link: ${new Date(store.settings.lastBackup).toLocaleString()}.` : ' No backup link yet.'}`;
    });
  }
  document.title = `${conf().name || 'Conference'} Planner`;
  const q = $('#q');
  if (focusedSearch && q) {
    q.focus();
    q.setSelectionRange(caret, caret);
  }
}

function applyTheme() {
  document.documentElement.dataset.theme = store.settings.theme;
}

// ------------------------------------------------------------------
// Events
// ------------------------------------------------------------------
document.addEventListener('click', async (e) => {
  const t = e.target;

  const day = t.closest('[data-day]');
  if (day) { ui.day = day.dataset.day; render(); window.scrollTo({ top: 0 }); return; }

  const star = t.closest('.card .star');
  if (star) { e.stopPropagation(); toggleStar(star.closest('.card').dataset.id); render(); return; }

  const chip = t.closest('[data-type]');
  if (chip) {
    const k = chip.dataset.type;
    ui.types.has(k) ? ui.types.delete(k) : ui.types.add(k);
    render();
    return;
  }

  const dur = t.closest('[data-dur]');
  if (dur) {
    const f = $('#addform');
    f.end.value = fromMin(Math.min(toMin(f.start.value) + +dur.dataset.dur, 1439));
    $$('[data-dur]', f).forEach((b) => b.classList.toggle('on', b === dur));
    return;
  }

  const tstar = t.closest('[data-star]');
  if (tstar) {
    e.stopPropagation();
    toggleStar(tstar.dataset.star);
    const on = starred().has(tstar.dataset.star);
    tstar.textContent = on ? '★' : '☆';
    tstar.closest('.talk').classList.toggle('starred', on);
    render();
    return;
  }

  const open = t.closest('[data-open]');
  if (open) { e.preventDefault(); openDetail(open.dataset.open); return; }

  const actEl = t.closest('[data-act]');
  const act = actEl?.dataset.act;
  if (act) {
    const sheetId = t.closest('.sheet')?.dataset.id;
    switch (act) {
      case 'close': closeSheet(); return;
      case 'my-day': ui.myAll = false; render(); return;
      case 'my-all': ui.myAll = true; render(); return;
      case 'toggle-past': store.settings.hidePast = !store.settings.hidePast; save(); render(); return;
      case 'jump-now': ui.day = now().date; return; // link continues to #/all
      case 'star': toggleStar(sheetId); openDetail(sheetId); render(); return;
      case 'ics1': exportICS([index.get(sheetId)], `${index.get(sheetId).title.slice(0, 40).replace(/[^\w]+/g, '-')}.ics`); return;
      case 'share1': {
        const s = index.get(sheetId);
        shareOrCopy({ title: s.title, text: `${s.title}\n${dayLabel(s.date, true)} ${fmtTime(s.start)}–${fmtTime(s.end)}${s.room ? `\n📍 ${s.room}` : ''}${s.url ? `\n${s.url}` : ''}` });
        return;
      }
      case 'share': shareMine(); return;
      case 'backup-link': {
        const url = await backupLink();
        try { await navigator.clipboard.writeText(url); toast('Backup link copied — paste it into Notes or send it to yourself'); }
        catch { shareOrCopy({ title: 'My SC26 planner backup', url }); }
        store.settings.lastBackup = new Date().toISOString();
        save();
        return;
      }
      case 'paste-link': {
        try { $('#linkin').value = await navigator.clipboard.readText(); } catch { toast('Paste it into the box instead'); return; }
      }
      // falls through
      case 'open-link': {
        const v = $('#linkin').value.trim();
        if (!(await handleShareHash(v))) toast('That doesn’t look like a planner link');
        return;
      }
      case 'restore-merge': restoreBackup(ui.pendingRestore, false); ui.pendingRestore = null; closeSheet(); location.hash = '#/my'; render(); return;
      case 'restore-replace':
        if (!confirm('Replace all stars, notes and events on this device with the backup?')) return;
        restoreBackup(ui.pendingRestore, true); ui.pendingRestore = null; closeSheet(); location.hash = '#/my'; render(); return;
      case 'dismiss-tip': store.settings.tipDone = true; save(); render(); return;
      case 'copytext': shareOrCopy({ text: planAsText() }); return;
      case 'ics': exportICS(mySessions(), `${(conf().name || 'conference').toLowerCase()}-my-schedule.ics`); return;
      case 'backup': download(`${(conf().name || 'conf').toLowerCase()}-planner-backup.json`, JSON.stringify(store, null, 2), 'application/json'); return;
      case 'reset':
        if (confirm('Clear all your picks, notes, added items and friends on this device?')) { store = defaults(); save(); rebuildIndex(); applyTheme(); render(); toast('Cleared'); }
        return;
      case 'refresh': refreshMaster(true); return;
      case 'import-paste': importText($('#importtext').value); return;
      case 'delete': {
        const id = actEl.dataset.id;
        if (!confirm('Delete this item?')) return;
        store.custom = store.custom.filter((s) => s.id !== id);
        store.starred = store.starred.filter((x) => x !== id);
        save(); rebuildIndex(); location.hash = '#/my'; toast('Deleted');
        return;
      }
      case 'view-friend': ui.friend = +actEl.dataset.i; location.hash = '#/my'; render(); return;
      case 'close-friend': ui.friend = null; render(); return;
      case 'merge-friend': { const f = store.friends[ui.friend]; mergeIds(f.ids, f.custom); ui.friend = null; render(); return; }
      case 'del-friend': store.friends.splice(+actEl.dataset.i, 1); save(); rebuildIndex(); render(); return;
      case 'save-friend': {
        const i = saveFriend(ui.pendingShare, $('#friendname').value.trim());
        ui.pendingShare = null; closeSheet(); ui.friend = i; location.hash = '#/my'; render();
        toast(`Saved ${store.friends[i].name}'s schedule`);
        return;
      }
      case 'merge-share': {
        const p = ui.pendingShare;
        mergeIds([...(p.s || []), ...(p.c || []).map((s) => normalize(s).id)], p.c || []);
        ui.pendingShare = null; closeSheet(); render();
        return;
      }
      default: break;
    }
  }

  const c = t.closest('.card, .nowitem');
  if (c && c.dataset.id) { openDetail(c.dataset.id); return; }

  // click on dialog backdrop closes
  if (t.id === 'sheet') closeSheet();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList?.contains('card')) openDetail(e.target.dataset.id);
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) {
    e.preventDefault();
    if (route().name !== 'all') location.hash = '#/all';
    setTimeout(() => $('#q')?.focus(), 0);
  }
});

let qTimer;
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'q') {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { ui.q = t.value; render(); }, 120);
  } else if (t.id === 'note') {
    const id = t.closest('.sheet').dataset.id;
    if (t.value.trim()) store.notes[id] = t.value; else delete store.notes[id];
    save();
  } else if (t.id === 'myname') {
    store.settings.name = t.value.trim();
    save();
  } else if (t.name === 'start' && t.form?.id === 'addform') {
    const on = $('[data-dur].on', t.form);
    if (on) t.form.end.value = fromMin(Math.min(toMin(t.value) + +on.dataset.dur, 1439));
  } else if (t.name === 'end' && t.form?.id === 'addform') {
    $$('[data-dur]', t.form).forEach((b) => b.classList.remove('on'));
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.id === 'theme') { store.settings.theme = t.value; save(); applyTheme(); }
  if (t.id === 'importfile' && t.files[0]) {
    const f = t.files[0];
    importText(await f.text(), f.name);
    t.value = '';
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.id !== 'addform') return;
  e.preventDefault();
  const f = new FormData(e.target);
  const o = Object.fromEntries(f.entries());
  if (toMin(o.end) <= toMin(o.start)) o.end = fromMin(Math.min(toMin(o.start) + 60, 1439));
  const oldId = o.editId;
  delete o.editId;
  const s = normalize({ ...o, id: oldId || `u-${sessionId(o)}-${Date.now().toString(36)}` });
  if (oldId) store.custom = store.custom.map((x) => (x.id === oldId ? s : x));
  else store.custom.push(s);
  if (!store.starred.includes(s.id)) store.starred.push(s.id);
  save();
  rebuildIndex();
  ui.day = s.date;
  ui.myAll = false;
  location.hash = '#/my';
  toast(oldId ? 'Saved' : '★ Added to my schedule');
});

window.addEventListener('hashchange', async () => {
  if (await handleShareHash()) return;
  closeSheet();
  render();
  window.scrollTo({ top: 0 });
});

// Swipe left/right on the list to change day.
let touch = null;
document.addEventListener('touchstart', (e) => {
  if (e.target.closest('.chips, .days, dialog, input, textarea')) { touch = null; return; }
  touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
}, { passive: true });
document.addEventListener('touchend', (e) => {
  if (!touch || !$('#days') || $('#days').hidden) return;
  const dx = e.changedTouches[0].clientX - touch.x;
  const dy = e.changedTouches[0].clientY - touch.y;
  if (Math.abs(dx) > 70 && Math.abs(dy) < 40 && Date.now() - touch.t < 500) {
    const days = confDays();
    const i = days.indexOf(ui.day) + (dx < 0 ? 1 : -1);
    if (days[i]) { ui.day = days[i]; render(); }
  }
  touch = null;
}, { passive: true });

// Keep "now" fresh.
setInterval(() => {
  if ($('#sheet').open) return;
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
  if (['my', 'all'].includes(route().name)) render();
}, 60_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { render(); refreshMaster(); }
});

// ------------------------------------------------------------------
// Boot
// ------------------------------------------------------------------
applyTheme();
ui.day = defaultDay();
render();
handleShareHash();
refreshMaster().then(() => {
  // first run with no cache: make sure day/notice are right
  if (!confDays().includes(ui.day)) { ui.day = defaultDay(); render(); }
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
