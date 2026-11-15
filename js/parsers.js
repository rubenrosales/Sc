// Shared parsing / time helpers. Used by the browser app and by tools/build-schedule.mjs.
// All session times are stored as conference-local wall-clock time:
//   { date: "2026-11-17", start: "10:30", end: "12:00" }

export const CONF_TZ = 'America/Chicago';

// ---------- time helpers ----------
export const pad = (n) => String(n).padStart(2, '0');
export const toMin = (hhmm) => {
  if (!hhmm) return 0;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
};
export const fromMin = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;

// Wall-clock parts of a UTC instant in a given zone.
export function partsInZone(date, tz = CONF_TZ) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

// Zone wall-clock -> UTC Date.
export function zonedToUtc(dateStr, hhmm, tz = CONF_TZ) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = (hhmm || '00:00').split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const p = partsInZone(new Date(t), tz);
    const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    t += guess - asUtc;
  }
  return new Date(t);
}

export function utcToZoned(date, tz = CONF_TZ) {
  const p = partsInZone(date, tz);
  return { date: `${p.y}-${pad(p.mo)}-${pad(p.d)}`, time: `${pad(p.h)}:${pad(p.mi)}` };
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// Accepts 2026-11-17, 11/17/2026, 11/17, Nov 17 2026, Tuesday Nov 17, 17 Nov.
export function parseDate(s, defaultYear = 2026) {
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (m) {
    let y = m[3] ? +m[3] : defaultYear;
    if (y < 100) y += 2000;
    return `${y}-${pad(m[1])}-${pad(m[2])}`;
  }
  m = s.toLowerCase().match(/([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/);
  if (m && MONTHS[m[1]]) return `${m[3] || defaultYear}-${pad(MONTHS[m[1]])}-${pad(m[2])}`;
  m = s.toLowerCase().match(/(\d{1,2})\s+([a-z]{3})[a-z]*\.?(?:\s+(\d{4}))?/);
  if (m && MONTHS[m[2]]) return `${m[3] || defaultYear}-${pad(MONTHS[m[2]])}-${pad(m[1])}`;
  return null;
}

// Accepts 8:30, 08:30, 8:30am, 8:30 PM, 1330, 8am, noon.
export function parseTime(s) {
  if (!s) return null;
  s = String(s).trim().toLowerCase();
  if (s === 'noon') return '12:00';
  if (s === 'midnight') return '00:00';
  const m = s.match(/^(\d{1,2})(?::?(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/);
  if (!m) return null;
  let h = +m[1];
  const mi = m[2] ? +m[2] : 0;
  const ap = m[3] ? m[3][0] : null;
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  return `${pad(h)}:${pad(mi)}`;
}

// Accepts "8:30 AM - 10:00 AM", "08:30–10:00", "1:30pm-3pm"
export function parseTimeRange(s) {
  if (!s) return [null, null];
  const parts = String(s).split(/\s*(?:-|–|—|to)\s*/i);
  let a = parseTime(parts[0]);
  let b = parseTime(parts[1] || '');
  // "1:30-3pm" -> inherit pm for start if needed
  if (a && b && /p/i.test(parts[1]) && !/[ap]/i.test(parts[0]) && toMin(a) < 12 * 60 && toMin(a) + 12 * 60 < toMin(b)) {
    a = fromMin(toMin(a) + 12 * 60);
  }
  return [a, b];
}

// ---------- ids ----------
export function hashId(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export const sessionId = (s) => hashId(`${s.date}|${s.start}|${s.title}`.toLowerCase());

// ---------- CSV ----------
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', q = false;
  const delim = (text.split('\n')[0].match(/\t/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const COLS = {
  title: ['title', 'name', 'session', 'session title', 'event', 'summary', 'subject'],
  date: ['date', 'day', 'start date'],
  start: ['start', 'start time', 'begin', 'from', 'time start'],
  end: ['end', 'end time', 'finish', 'to', 'time end'],
  time: ['time', 'times', 'time slot', 'timeslot'],
  room: ['room', 'location', 'where', 'venue'],
  type: ['type', 'session type', 'event type', 'format', 'category'],
  track: ['track', 'topic', 'theme'],
  speakers: ['speakers', 'speaker', 'presenter', 'presenters', 'authors', 'organizers'],
  description: ['description', 'abstract', 'details', 'notes'],
  url: ['url', 'link', 'web', 'website'],
};

export function csvToSessions(text, defaultYear = 2026) {
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/[_]+/g, ' '));
  const idx = {};
  for (const [k, names] of Object.entries(COLS)) {
    const i = head.findIndex((h) => names.includes(h));
    if (i >= 0) idx[k] = i;
  }
  if (idx.title == null) throw new Error('CSV needs a "title" column (or name/session/summary).');
  const out = [];
  for (const r of rows.slice(1)) {
    const g = (k) => (idx[k] != null ? (r[idx[k]] || '').trim() : '');
    const title = g('title');
    if (!title) continue;
    let date = parseDate(g('date'), defaultYear);
    let start = parseTime(g('start'));
    let end = parseTime(g('end'));
    // "start" column might hold a full datetime: 2026-11-17 10:30
    if (!date && g('start')) date = parseDate(g('start'), defaultYear);
    if (g('start').match(/\d{4}-\d\d-\d\d[ T](\d{1,2}:\d\d)/)) start = parseTime(g('start').split(/[ T]/)[1]);
    if (g('end').match(/\d{4}-\d\d-\d\d[ T](\d{1,2}:\d\d)/)) end = parseTime(g('end').split(/[ T]/)[1]);
    if ((!start || !end) && g('time')) {
      const [a, b] = parseTimeRange(g('time'));
      start = start || a;
      end = end || b;
    }
    if (!date || !start) continue;
    if (!end) end = fromMin(Math.min(toMin(start) + 60, 23 * 60 + 59));
    out.push(normalize({
      title, date, start, end,
      room: g('room'), type: g('type'), track: g('track'),
      speakers: g('speakers'), description: g('description'), url: g('url'),
    }));
  }
  return out;
}

// ---------- ICS ----------
function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}
const unesc = (s) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');

function icsDateToLocal(value, params, tz) {
  // 20261117T103000Z | 20261117T103000 (TZID or floating) | 20261117 (all day)
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4]) return { date, time: null };
  const time = `${m[4]}:${m[5]}`;
  if (m[7]) return utcToZoned(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])), tz);
  const tzid = (params.match(/TZID=("?)([^;:"]+)\1/) || [])[2];
  if (tzid && tzid !== tz) {
    try {
      return utcToZoned(zonedToUtc(date, time, tzid), tz);
    } catch { /* unknown TZID: treat as wall clock */ }
  }
  return { date, time };
}

export function icsToSessions(text, tz = CONF_TZ) {
  const lines = unfold(text).split('\n');
  const out = [];
  let ev = null;
  let sub = 0; // depth of nested components (VALARM etc.) inside a VEVENT
  for (const line of lines) {
    if (line.startsWith('BEGIN:VEVENT')) { ev = {}; sub = 0; continue; }
    if (ev && line.startsWith('BEGIN:')) { sub++; continue; }
    if (ev && sub && line.startsWith('END:')) { sub--; continue; }
    if (sub) continue;
    if (line.startsWith('END:VEVENT')) {
      if (ev && ev.title && ev.s && ev.s.time) {
        const e = ev.e && ev.e.time ? ev.e : { time: fromMin(Math.min(toMin(ev.s.time) + 60, 1439)) };
        out.push(normalize({
          title: ev.title, date: ev.s.date, start: ev.s.time,
          end: ev.e && ev.e.date !== ev.s.date ? '23:59' : e.time,
          room: ev.room || '', description: ev.desc || '', url: ev.url || '', type: ev.cat || '',
        }));
      }
      ev = null;
      continue;
    }
    if (!ev) continue;
    const ci = line.indexOf(':');
    if (ci < 0) continue;
    const left = line.slice(0, ci);
    const val = line.slice(ci + 1);
    const [name, ...rest] = left.split(';');
    const params = rest.join(';');
    switch (name.toUpperCase()) {
      case 'SUMMARY': ev.title = unesc(val).trim(); break;
      case 'LOCATION': ev.room = unesc(val).trim(); break;
      case 'DESCRIPTION': ev.desc = unesc(val).trim(); break;
      case 'URL': ev.url = val.trim(); break;
      case 'CATEGORIES': ev.cat = unesc(val).split(',')[0].trim(); break;
      case 'DTSTART': ev.s = icsDateToLocal(val.trim(), params, tz); break;
      case 'DTEND': ev.e = icsDateToLocal(val.trim(), params, tz); break;
      default: break;
    }
  }
  return out;
}

const icsStamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function fold(line) {
  const out = [];
  while (line.length > 74) { out.push(line.slice(0, 74)); line = ' ' + line.slice(74); }
  out.push(line);
  return out.join('\r\n');
}

export function sessionsToICS(sessions, { tz = CONF_TZ, name = 'My SC26 schedule', notes = {} } = {}) {
  const now = icsStamp(new Date());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SC Planner//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${esc(name)}`];
  for (const s of sessions) {
    const desc = [s.speakers, notes[s.id] ? `My notes: ${notes[s.id]}` : '', s.description, s.url].filter(Boolean).join('\n\n');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${s.id}@sc-planner`,
      `DTSTAMP:${now}`,
      `DTSTART:${icsStamp(zonedToUtc(s.date, s.start, tz))}`,
      `DTEND:${icsStamp(zonedToUtc(s.date, s.end, tz))}`,
      `SUMMARY:${esc(s.title)}`,
    );
    if (s.room) lines.push(`LOCATION:${esc(s.room)}`);
    if (s.type) lines.push(`CATEGORIES:${esc(s.type)}`);
    if (desc) lines.push(`DESCRIPTION:${esc(desc)}`);
    if (s.url) lines.push(`URL:${s.url}`);
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// ---------- normalize ----------
const TYPE_ALIASES = [
  ['keynote', /keynote|plenary|invited talk/i],
  ['tutorial', /tutorial/i],
  ['workshop', /workshop/i],
  ['paper', /paper|technical program|presentation|talk/i],
  ['bof', /\bbof\b|birds of a feather/i],
  ['panel', /panel/i],
  ['poster', /poster/i],
  ['exhibit', /exhibit|expo|booth|vendor/i],
  ['social', /reception|gala|party|social|dinner|lunch|breakfast|happy hour/i],
  ['award', /award|prize|gordon bell/i],
  ['meeting', /meeting|1:1|1on1|call|meetup/i],
];

const KNOWN = new Set(['keynote', 'tutorial', 'workshop', 'paper', 'bof', 'panel', 'poster', 'exhibit', 'social', 'award', 'meeting', 'community', 'student', 'other']);

export function guessType(type, title = '') {
  if (KNOWN.has(type)) return type;
  for (const src of [type, title]) {
    if (!src) continue;
    for (const [k, re] of TYPE_ALIASES) if (re.test(src)) return k;
  }
  return type ? 'other' : 'other';
}

// Sessions can arrive from share/backup links and imported files, so every field is
// coerced to a safe shape: strict date/time formats, plain ids, http(s)-only links.
const str = (v) => (v == null ? '' : String(v)).trim();
const cleanDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : undefined);
const cleanTime = (v) => {
  const m = str(v).match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  return m && +m[1] < 24 && +m[2] < 60 ? `${pad(+m[1])}:${m[2]}` : undefined;
};
const cleanId = (v) => str(v).replace(/[^\w.:-]/g, '').slice(0, 80);
const cleanUrl = (v) => (/^https?:\/\//i.test(str(v)) ? str(v) : '');

// A session is usable only with a title, a valid day and a valid start time.
export const isValidSession = (s) => !!(s && s.title && s.date && s.start);

export function normalize(s) {
  s = s || {};
  const start = cleanTime(s.start);
  const end = cleanTime(s.end);
  const out = {
    title: str(s.title),
    date: cleanDate(s.date),
    start,
    end: end && start && toMin(end) > toMin(start) ? end : fromMin(Math.min(toMin(start) + 60, 1439)),
    room: str(s.room),
    type: guessType(str(s.type), str(s.title)),
    track: str(s.track),
    speakers: str(s.speakers),
    description: str(s.description),
    url: cleanUrl(s.url),
    cat: str(s.cat),
    parent: cleanId(s.parent),
  };
  out.id = cleanId(s.id) || sessionId(out);
  for (const k of Object.keys(out)) if (out[k] === '' || out[k] === undefined) delete out[k];
  return out;
}
