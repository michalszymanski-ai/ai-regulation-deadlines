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

function check(cond, msg) { if (!cond) throw new Error('validation: ' + msg); }
function validateDeadline(d) {
  for (const [k] of DEADLINE_FIELDS) if (k !== 'url') check(typeof d[k] === 'string' && d[k].trim(), `${d.id || '?'}: missing ${k}`);
  check(/^[a-z0-9-]+$/.test(d.id), `bad id ${d.id}`);
  check(/^\d{4}-\d{2}-\d{2}$/.test(d.date) && !Number.isNaN(Date.parse(d.date)), `${d.id}: bad date ${d.date}`);
  check(STATUS.has(d.status), `${d.id}: bad status ${d.status}`);
  check(/^https:\/\//.test(d.source), `${d.id}: source must be an https URL`);
}
function validateTerm(t) {
  for (const k of ['slug', 'term', 'group', 'text', 'ref', 'source']) check(typeof t[k] === 'string' && t[k].trim(), `${t.slug || '?'}: missing ${k}`);
  check(/^https:\/\//.test(t.source), `${t.slug}: source must be an https URL`);
}

const csvCell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const toCsv = (rows, fields) => [fields.map(([k]) => k).join(','), ...rows.map((r) => fields.map(([k]) => csvCell(r[k])).join(','))].join('\r\n') + '\r\n';
const writeIfChanged = (file, text) => { if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return false; fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return true; };

const [dl, gl] = await Promise.all([load('deadlines.json'), load('glossary.json')]);
check(Array.isArray(dl.items) && dl.items.length >= 10, 'deadlines: fewer than 10 items, refusing to overwrite');
check(Array.isArray(gl.items) && gl.items.length >= 10, 'glossary: fewer than 10 items, refusing to overwrite');
dl.items.forEach(validateDeadline); gl.items.forEach(validateTerm);
check(new Set(dl.items.map((d) => d.id)).size === dl.items.length, 'duplicate deadline ids');

const deadlines = dl.items
  .map((d) => Object.fromEntries(DEADLINE_FIELDS.map(([k]) => [k, k === 'url' ? `${BASE}/deadlines/${d.id}/` : d[k]])))
  .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
const glossary = gl.items
  .map((t) => Object.fromEntries(GLOSSARY_FIELDS.map(([k]) => [k, k === 'url' ? `${BASE}/glossary/#${t.slug}` : t[k]])))
  .sort((a, b) => a.term.localeCompare(b.term));

const meta = (title) => ({ title, publisher: 'Dutybound', homepage: `${BASE}/deadlines/`, licence: LICENCE.title, licence_url: LICENCE.path, attribution: ATTRIBUTION, disclaimer: 'Operational information, not legal advice. Check the linked source before relying on a row.' });
const changed = [];
if (writeIfChanged('data/deadlines.json', JSON.stringify({ ...meta('AI regulation deadlines'), count: deadlines.length, items: deadlines }, null, 2) + '\n')) changed.push('data/deadlines.json');
if (writeIfChanged('data/deadlines.csv', toCsv(deadlines, DEADLINE_FIELDS))) changed.push('data/deadlines.csv');
if (writeIfChanged('data/glossary.json', JSON.stringify({ ...meta('AI regulation glossary'), count: glossary.length, items: glossary }, null, 2) + '\n')) changed.push('data/glossary.json');
if (writeIfChanged('data/glossary.csv', toCsv(glossary, GLOSSARY_FIELDS))) changed.push('data/glossary.csv');

// Frictionless data package (https://datapackage.org), so data portals and tools can read the files with their schema
const fieldsSchema = (fields, types = {}) => ({ fields: fields.map(([name, description]) => ({ name, type: types[name] || 'string', description, ...(name === 'status' ? { constraints: { enum: [...STATUS] } } : {}) })), primaryKey: fields[0][0] });
const pkg = {
  name: 'ai-regulation-deadlines', title: 'AI regulation deadlines',
  description: 'Dates, scope and expected evidence for AI-regulation obligations in the EU (AI Act as amended by the Digital Omnibus), Poland, South Korea and US states, each with a source, plus a glossary of the terms they use.',
  homepage: `${BASE}/deadlines/`, licenses: [LICENCE], contributors: [{ title: 'Dutybound', path: BASE, role: 'author' }],
  keywords: ['EU AI Act', 'AI regulation', 'compliance', 'Digital Omnibus', 'KRiBSI', 'Korea AI Basic Act', 'Colorado', 'California ADMT', 'Texas TRAIGA', 'open data'],
  resources: [
    { name: 'deadlines', path: 'data/deadlines.csv', format: 'csv', mediatype: 'text/csv', encoding: 'utf-8', schema: fieldsSchema(DEADLINE_FIELDS, { date: 'date' }) },
    { name: 'glossary', path: 'data/glossary.csv', format: 'csv', mediatype: 'text/csv', encoding: 'utf-8', schema: fieldsSchema(GLOSSARY_FIELDS) },
  ],
};
if (writeIfChanged('datapackage.json', JSON.stringify(pkg, null, 2) + '\n')) changed.push('datapackage.json');

// README table between markers, so the repository page shows the current data
const readme = fs.readFileSync('README.md', 'utf8');
const esc = (s) => s.replace(/\|/g, '\\|');
const table = ['| Date | Jurisdiction | Obligation | Status | Source |', '|---|---|---|---|---|',
  ...deadlines.map((d) => `| ${d.date} | ${esc(d.jurisdiction)} | [${esc(d.title)}](${d.url}) | ${d.status} | [${esc(d.source_label)}](${d.source}) |`)].join('\n');
const next = readme.replace(/<!-- table:start -->[\s\S]*<!-- table:end -->/, `<!-- table:start -->\n${table}\n<!-- table:end -->`)
  .replace(/<!-- count:deadlines -->\d+/g, `<!-- count:deadlines -->${deadlines.length}`).replace(/<!-- count:glossary -->\d+/g, `<!-- count:glossary -->${glossary.length}`);
if (writeIfChanged('README.md', next)) changed.push('README.md');

console.log(changed.length ? 'changed: ' + changed.join(', ') : 'no change');
