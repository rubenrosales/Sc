#!/usr/bin/env node
// Convert an exported program (.ics / .csv / .json) into data/schedule.json,
// which is the shared "Full Schedule" everyone using the site sees.
//
//   node tools/build-schedule.mjs program.ics            # merge into existing sessions
//   node tools/build-schedule.mjs program.csv --replace  # replace all sessions
//   node tools/build-schedule.mjs a.ics b.csv --notice "Official program, synced Nov 14"
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { csvToSessions, icsToSessions, normalize, CONF_TZ } from '../js/parsers.js';

const args = process.argv.slice(2);
const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--notice');
const replace = args.includes('--replace');
const noticeIdx = args.indexOf('--notice');
if (!files.length) {
  console.error('usage: node tools/build-schedule.mjs <file.ics|file.csv|file.json>... [--replace] [--notice "text"]');
  process.exit(1);
}

const out = fileURLToPath(new URL('../data/schedule.json', import.meta.url));
const data = JSON.parse(readFileSync(out, 'utf8'));
const tz = data.conference?.tz || CONF_TZ;

let incoming = [];
for (const f of files) {
  const text = readFileSync(f, 'utf8').replace(/^﻿/, '');
  let s;
  if (/BEGIN:VCALENDAR/.test(text)) s = icsToSessions(text, tz);
  else if (/^\s*[[{]/.test(text)) { const j = JSON.parse(text); s = (Array.isArray(j) ? j : j.sessions).map(normalize); }
  else s = csvToSessions(text);
  console.log(`${f}: ${s.length} sessions`);
  incoming.push(...s);
}

const map = new Map((replace ? [] : data.sessions.map(normalize)).map((s) => [s.id, s]));
for (const s of incoming) map.set(s.id, s);
data.sessions = [...map.values()].sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start) || a.title.localeCompare(b.title));
data.updated = new Date().toISOString().slice(0, 10);
if (noticeIdx >= 0) data.notice = args[noticeIdx + 1] || undefined;
else if (replace) delete data.notice;

writeFileSync(out, JSON.stringify(data, null, 1) + '\n');
console.log(`wrote ${data.sessions.length} sessions -> data/schedule.json`);
