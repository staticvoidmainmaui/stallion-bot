/**
 * Eval: run the REAL ask agent (your ANTHROPIC_API_KEY, about $0.02 for the whole set) on saved questions
 * and check each answer is short, on-point and safe. Run it after changing the prompt or the tools.
 *
 *   npm run ask-eval                 (all questions)
 *   npm run ask-eval -- retreat      (only questions containing "retreat")
 *
 * Built on the 11/2 minutes: data/parse-2026-11-02-bot.json (+ fixtures/minutes-2026-11-02.txt for the
 * minutes text, when present). "Now" is pinned to Wed 11/4 10am so dates stay stable.
 * When the minutes change, update the questions below.
 */
import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { config } from '../src/config.js';
import { Store } from '../src/db.js';
import { Roster } from '../src/roster.js';
import { Glossary } from '../src/glossary.js';
import { findEvents } from '../src/events.js';
import { answer, composeReply, scrub } from '../src/ask.js';
import { DocReader, serviceAccountToken } from '../src/docread.js';
import * as M from '../src/messages.js';
import type { Extraction } from '../src/extract.js';

interface Case {
  q: string;
  /** Pretend the question replied to a bot message about this event (search words). */
  about?: string;
  as?: string;
  /** At least one of these must appear (case-insensitive) in the final message. */
  any?: string[];
  /** None of these may appear. */
  none?: string[];
  /** Most lines of Claude's text (the header line from code isn't counted). Default 3. */
  maxLines?: number;
}

const CASES: Case[] = [
  { q: 'when is the mgc market?', any: ['11/19', 'thu'] },
  { q: "what's the theme for mgc market?", any: ['grand premiere'] },
  { q: 'what character are we doing for mgc market?', any: ['minion'] },
  { q: "who's doing gru?", any: ['james'] },
  { q: 'when are song cuts due?', any: ['11/18', 'wed'] },
  { q: 'where is the mgc retreat?', any: ['arredondo'] },
  { q: 'how many more people do we need for the retreat?', any: ['3'] },
  { q: 'who else is going?', about: 'mgc retreat', any: ['elias', 'david'] },
  { q: 'what time is the ronald mcdonald house volunteering?', any: ['6'] },
  { q: 'is the ronald mcdonald house thing full?', any: ['7'] },
  { q: 'when is step and stroll practice?', any: ['8:30'] },
  { q: 'when is the next round of nominations?', any: ['11/9', 'mon'] },
  { q: 'what am i signed up for?', as: 'Alejandro', maxLines: 3 },
  { q: 'what do the bylaws say about removing an e-board member?', any: ['judicial'], maxLines: 1 },
  { q: "what's the weather tomorrow?", maxLines: 1, none: ['°', 'sunny', 'rain'] },
  { q: 'who owes fines right now?', none: ['$', 'owes $'], maxLines: 2 },
];

const FIXTURE = 'data/parse-2026-11-02-bot.json';
const MINUTES = 'fixtures/minutes-2026-11-02.txt';
if (!config.anthropicApiKey) {
  console.log('Set ANTHROPIC_API_KEY in .env first. (For the free offline check: npm run ask-test)');
  process.exit(1);
}
if (!existsSync(FIXTURE)) {
  console.log(`Missing ${FIXTURE} (the saved extraction of the 11/2 minutes).`);
  process.exit(1);
}

// A throwaway database with the 11/2 minutes, so results don't change as the real minutes do.
const DB = 'data/_ask-eval.db';
const clean = () => ['', '-wal', '-shm'].forEach((x) => rmSync(DB + x, { force: true }));
clean();
const store = new Store(DB);
const roster = Roster.load(config.rosterPath);
const glossary = Glossary.load(config.glossaryPath);
const raw = existsSync(MINUTES) ? readFileSync(MINUTES, 'utf8') : '';
if (!raw) console.log(`(no ${MINUTES}: minutes-text questions may fail)`);
store.saveSnapshot('eval', raw, JSON.parse(readFileSync(FIXTURE, 'utf8')) as Extraction, roster, glossary);

const NOW = new Date('2026-11-04T10:00:00');
const client = new Anthropic({ apiKey: config.anthropicApiKey });
const docs = new DocReader({ getToken: serviceAccountToken(config.googleCredentials), scrub });
const only = process.argv.slice(2).join(' ').toLowerCase();
const phone = /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/;

let pass = 0;
let total = 0;
for (const c of CASES.filter((x) => !only || x.q.toLowerCase().includes(only))) {
  total++;
  const quoted = c.about ? findEvents(store, c.about, glossary, NOW).slice(0, 1).map((v) => v.id) : [];
  const senderName = c.as ?? 'Alejandro';
  const tools: string[] = [];
  const res = await answer(c.q, { senderName, quotedEventIds: quoted, now: NOW }, {
    store,
    roster,
    glossary,
    client,
    model: config.model,
    maxRounds: config.askMaxRounds,
    docs,
    onStep: (s) => s.type === 'tool' && tools.push(s.name),
  });
  const msg = composeReply(res, { store, quotedEventIds: quoted, now: NOW }).text;
  const low = msg.toLowerCase();
  const lines = res.text ? res.text.split('\n').length : 0;
  const problems = [
    lines > (c.maxLines ?? 3) ? `${lines} lines (max ${c.maxLines ?? 3})` : '',
    c.any && !c.any.some((w) => low.includes(w.toLowerCase())) ? `missing any of: ${c.any.join(' / ')}` : '',
    ...(c.none ?? []).filter((w) => low.includes(w.toLowerCase())).map((w) => `contains "${w}"`),
    phone.test(msg) ? 'contains a phone number' : '',
  ].filter(Boolean);
  if (!problems.length) pass++;
  console.log(`\n${problems.length ? 'FAIL' : 'PASS'}  ${c.q}${c.about ? `  (reply about ${c.about})` : ''}`);
  console.log(`      tools: ${tools.join(' → ') || 'none'}`);
  console.log(M.style(msg).replace(/^/gm, '      '));
  for (const p of problems) console.log(`      ✗ ${p}`);
}
console.log(`\n${pass}/${total} passed`);
store.db.close();
clean();
process.exit(pass === total ? 0 : 1);
