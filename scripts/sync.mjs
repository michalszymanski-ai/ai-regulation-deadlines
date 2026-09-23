#!/usr/bin/env node
// Pulls the current data from getdutybound.com, validates it and writes JSON, CSV, the data package and the README table.
// Run daily by .github/workflows/sync.yml. Writes nothing that changes unless the data changes, so quiet days make no commit.
//   node scripts/sync.mjs                         fetch from https://getdutybound.com
//   DUTYBOUND_DIST=../dutybound/dist node scripts/sync.mjs   read a local build instead
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://getdutybound.com';
const LICENCE = { name: 'CC-BY-4.0', title: 'Creative Commons Attribution 4.0 International', path: 'https://creativecommons.org/licenses/by/4.0/' };
const ATTRIBUTION = 'Dutybound, https://getdutybound.com/deadlines/ (CC BY 4.0)';

async function load(file) {
  if (process.env.DUTYBOUND_DIST) return JSON.parse(fs.readFileSync(path.join(process.env.DUTYBOUND_DIST, file), 'utf8'));
  const res = await fetch(`${BASE}/${file}`, { headers: { 'user-agent': 'ai-regulation-deadlines-sync (+https://github.com/michalszymanski-ai/ai-regulation-deadlines)' } });
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  return res.json();
}

const DEADLINE_FIELDS = [
  ['id', 'Stable identifier of the obligation'],
  ['jurisdiction', 'EU, Poland, South Korea, or "US, <State>"'],
  ['law', 'The law or regulation that creates the obligation'],
  ['title', 'Short name of the obligation'],
  ['date', 'Date the obligation applies (YYYY-MM-DD)'],
  ['status', 'in-force, upcoming or deferred'],
  ['applies_to', 'Who the obligation applies to'],
  ['summary', 'What the obligation requires, in plain words'],
  ['evidence', 'The evidence a supervisor or auditor can expect to see'],
  ['source', 'URL of the source the row was checked against'],
  ['source_label', 'Name of that source'],
  ['url', 'Page for this obligation on getdutybound.com'],
];
const GLOSSARY_FIELDS = [
  ['slug', 'Stable identifier of the term'],
  ['term', 'The term'],
  ['group', 'Law or framework the term belongs to'],
  ['text', 'Definition, paraphrased in plain words'],
  ['ref', 'Legal reference (article, section or clause)'],
  ['source', 'URL of the source'],
  ['url', 'The term on getdutybound.com'],
];
const STATUS = new Set(['in-force', 'upcoming', 'deferred']);
const KRIBSI_FIELDS = [
  ['date', 'Date of the event (YYYY-MM-DD); empty when only a window is known'],
  ['when', 'Expected window when there is no date yet'],
  ['state', 'done, upcoming, expected (announced or reported plan) or pending (awaiting a decision)'],
  ['kind', 'law, appointment, report, publication, opinion, inspection, sandbox, fine or guidance'],
  ['title_en', 'Event, in English'],
  ['text_en', 'Details, in English'],
  ['title_pl', 'Event, in Polish'],
  ['text_pl', 'Details, in Polish'],
  ['source', 'URL of the source'],
  ['source_label', 'Name of the source'],
];
const KRIBSI_STATE = new Set(['done', 'upcoming', 'expected', 'pending']);

function check(cond, msg) { if (!cond) throw new Error('validation: ' + msg); }
function validateDeadline(d) {
  for (const [k] of DEADLINE_FIELDS) if (k !== 'url') check(typeof d[k] === 'string' && d[k].trim(), `${d.id || '?'}: missing ${k}`);
  check(/^[a-z0-9-]+$/.test(d.id), `bad id ${d.id}`);
  check(/^\d{4}-\d{2}-\d{2}$/.test(d.date) && !Number.isNaN(Date.parse(d.date)), `${d.id}: bad date ${d.date}`);
  check(STATUS.has(d.status), `${d.id}: bad status ${d.status}`);
  check(/^https:\/\//.test(d.source), `${d.id}: source must be an https URL`);
}
function validateKribsi(k) {
  check(Array.isArray(k.log) && k.log.length >= 3, 'kribsi: fewer than 3 log entries, refusing to overwrite');
  check(Array.isArray(k.facts) && k.facts.length >= 3, 'kribsi: fewer than 3 facts');
  for (const e of k.log) {
    check(KRIBSI_STATE.has(e.state), `kribsi: bad state ${e.state}`);
    check(e.date === null || (/^\d{4}-\d{2}-\d{2}$/.test(e.date) && !Number.isNaN(Date.parse(e.date))), `kribsi: bad date ${e.date}`);
    check(e.date || e.window_en, 'kribsi: entry without date or window');
    for (const l of ['en', 'pl']) check(e[l] && e[l].title && e[l].text, `kribsi: missing ${l} text`);
    check(/^https:\/\//.test(e.source), `kribsi: source must be an https URL (${e.en.title})`);
  }
  for (const f of k.facts) check(f.ref && /^https:\/\//.test(f.source), `kribsi: fact ${f.id} needs ref and https source`);
}
function validateTerm(t) {
  for (const k of ['slug', 'term', 'group', 'text', 'ref', 'source']) check(typeof t[k] === 'string' && t[k].trim(), `${t.slug || '?'}: missing ${k}`);
  check(/^https:\/\//.test(t.source), `${t.slug}: source must be an https URL`);
}

const csvCell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const toCsv = (rows, fields) => [fields.map(([k]) => k).join(','), ...rows.map((r) => fields.map(([k]) => csvCell(r[k])).join(','))].join('\r\n') + '\r\n';
const writeIfChanged = (file, text) => { if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return false; fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return true; };

const [dl, gl, kb] = await Promise.all([load('deadlines.json'), load('glossary.json'), load('kribsi.json')]);
check(Array.isArray(dl.items) && dl.items.length >= 10, 'deadlines: fewer than 10 items, refusing to overwrite');
check(Array.isArray(gl.items) && gl.items.length >= 10, 'glossary: fewer than 10 items, refusing to overwrite');
dl.items.forEach(validateDeadline); gl.items.forEach(validateTerm); validateKribsi(kb);
check(new Set(dl.items.map((d) => d.id)).size === dl.items.length, 'duplicate deadline ids');

const deadlines = dl.items
  .map((d) => Object.fromEntries(DEADLINE_FIELDS.map(([k]) => [k, k === 'url' ? `${BASE}/deadlines/${d.id}/` : d[k]])))
  .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
const glossary = gl.items
  .map((t) => Object.fromEntries(GLOSSARY_FIELDS.map(([k]) => [k, k === 'url' ? `${BASE}/glossary/#${t.slug}` : t[k]])))
  .sort((a, b) => a.term.localeCompare(b.term));

const kribsiLog = kb.log.slice().sort((a, b) => (a.date || a.sort || '9999').localeCompare(b.date || b.sort || '9999'));
const kribsiRows = kribsiLog.map((e) => ({ date: e.date || '', when: e.date ? '' : e.window_en || '', state: e.state, kind: e.kind, title_en: e.en.title, text_en: e.en.text, title_pl: e.pl.title, text_pl: e.pl.text, source: e.source, source_label: e.source_label }));
const meta = (title) => ({ title, publisher: 'Dutybound', homepage: `${BASE}/deadlines/`, licence: LICENCE.title, licence_url: LICENCE.path, attribution: ATTRIBUTION, disclaimer: 'Operational information, not legal advice. Check the linked source before relying on a row.' });
const changed = [];
if (writeIfChanged('data/deadlines.json', JSON.stringify({ ...meta('AI regulation deadlines'), count: deadlines.length, items: deadlines }, null, 2) + '\n')) changed.push('data/deadlines.json');
if (writeIfChanged('data/deadlines.csv', toCsv(deadlines, DEADLINE_FIELDS))) changed.push('data/deadlines.csv');
if (writeIfChanged('data/glossary.json', JSON.stringify({ ...meta('AI regulation glossary'), count: glossary.length, items: glossary }, null, 2) + '\n')) changed.push('data/glossary.json');
if (writeIfChanged('data/glossary.csv', toCsv(glossary, GLOSSARY_FIELDS))) changed.push('data/glossary.csv');
const kribsiOut = { ...meta("KRiBSI log: Poland's AI supervisor"), homepage: `${BASE}/kribsi/`, homepage_pl: `${BASE}/pl/kribsi/`, attribution: 'Dutybound, https://getdutybound.com/kribsi/ (CC BY 4.0)', updated: kb.updated, act: kb.act, status: kb.status, facts: kb.facts, log: kribsiLog.map(({ sort, ...e }) => e), watch: kb.watch };
if (writeIfChanged('data/kribsi.json', JSON.stringify(kribsiOut, null, 2) + '\n')) changed.push('data/kribsi.json');
if (writeIfChanged('data/kribsi-log.csv', toCsv(kribsiRows, KRIBSI_FIELDS))) changed.push('data/kribsi-log.csv');

// Frictionless data package (https://datapackage.org), so data portals and tools can read the files with their schema
const fieldsSchema = (fields, types = {}) => ({ fields: fields.map(([name, description]) => ({ name, type: types[name] || 'string', description, ...(name === 'status' ? { constraints: { enum: [...STATUS] } } : {}) })), primaryKey: fields[0][0] });
const pkg = {
  name: 'ai-regulation-deadlines', title: 'AI regulation deadlines',
  description: "Dates, scope and expected evidence for AI-regulation obligations in the EU (AI Act as amended by the Digital Omnibus), Poland, South Korea and US states, each with a source; a glossary of the terms they use; and a sourced log of KRiBSI, Poland's AI supervisor.",
  homepage: `${BASE}/deadlines/`, licenses: [LICENCE], contributors: [{ title: 'Dutybound', path: BASE, role: 'author' }],
  keywords: ['EU AI Act', 'AI regulation', 'compliance', 'Digital Omnibus', 'KRiBSI', 'Korea AI Basic Act', 'Colorado', 'California ADMT', 'Texas TRAIGA', 'open data'],
  resources: [
    { name: 'deadlines', path: 'data/deadlines.csv', format: 'csv', mediatype: 'text/csv', encoding: 'utf-8', schema: fieldsSchema(DEADLINE_FIELDS, { date: 'date' }) },
    { name: 'glossary', path: 'data/glossary.csv', format: 'csv', mediatype: 'text/csv', encoding: 'utf-8', schema: fieldsSchema(GLOSSARY_FIELDS) },
    { name: 'kribsi-log', path: 'data/kribsi-log.csv', format: 'csv', mediatype: 'text/csv', encoding: 'utf-8', description: "Dated log of what KRiBSI, Poland's AI supervisor, has done and is expected to do, with sources. Its powers, with article references, are in data/kribsi.json.", schema: { fields: KRIBSI_FIELDS.map(([name, description]) => ({ name, type: name === 'date' ? 'date' : 'string', description, ...(name === 'state' ? { constraints: { enum: [...KRIBSI_STATE] } } : {}) })) } },
  ],
};
if (writeIfChanged('datapackage.json', JSON.stringify(pkg, null, 2) + '\n')) changed.push('datapackage.json');

// README table between markers, so the repository page shows the current data
const readme = fs.readFileSync('README.md', 'utf8');
const esc = (s) => s.replace(/\|/g, '\\|');
const table = ['| Date | Jurisdiction | Obligation | Status | Source |', '|---|---|---|---|---|',
  ...deadlines.map((d) => `| ${d.date} | ${esc(d.jurisdiction)} | [${esc(d.title)}](${d.url}) | ${d.status} | [${esc(d.source_label)}](${d.source}) |`)].join('\n');
const kribsiTable = ['| Date | State | Event | Source |', '|---|---|---|---|',
  ...kribsiLog.map((e) => `| ${e.date || esc(e.window_en || '')} | ${e.state} | ${esc(e.en.title)} | [${esc(e.source_label)}](${e.source}) |`)].join('\n');
const next = readme.replace(/<!-- table:start -->[\s\S]*<!-- table:end -->/, `<!-- table:start -->\n${table}\n<!-- table:end -->`)
  .replace(/<!-- kribsi:start -->[\s\S]*<!-- kribsi:end -->/, `<!-- kribsi:start -->\n${kribsiTable}\n<!-- kribsi:end -->`)
  .replace(/<!-- count:deadlines -->\d+/g, `<!-- count:deadlines -->${deadlines.length}`).replace(/<!-- count:glossary -->\d+/g, `<!-- count:glossary -->${glossary.length}`);
if (writeIfChanged('README.md', next)) changed.push('README.md');

console.log(changed.length ? 'changed: ' + changed.join(', ') : 'no change');
