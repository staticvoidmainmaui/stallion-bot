/**
 * Offline test for the ask agent. No API key, no WhatsApp, no money:
 * a FAKE model plays Claude's part with scripted tool calls, and we check what our side does.
 *
 *   npm run ask-test
 *
 * Uses data/parse-2026-11-02-bot.json (the bot's real extraction of the 11/2 minutes) for events,
 * plus a small made-up minutes text and roster so nobody's real phone number is involved.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import { Store } from '../src/db.js';
import { Roster } from '../src/roster.js';
import { Glossary } from '../src/glossary.js';
import { answer, isSensitive, redact, runTool, scrub, type AskStep, type ModelClient } from '../src/ask.js';
import type { Extraction } from '../src/extract.js';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n      ${detail}` : ''}`);
  if (!ok) failed++;
};

// ---------- fixture ----------
const FIXTURE = 'data/parse-2026-11-02-bot.json';
if (!existsSync(FIXTURE)) {
  console.error(`Missing ${FIXTURE} (the saved extraction of the 11/2 minutes). Can't run.`);
  process.exit(1);
}
const ex = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Extraction;

const MINUTES = [
  'MGC Retreat: Sunday 11/15, 12pm-2pm at Arredondo Cafe. Dress code: business casual.',
  'Fines: Bradley owes $20 for missing tabling.',
  'Advisor contact: Dr. Smith 352-555-1234, smith@ufl.edu',
  'Step and Stroll practice is Wednesdays at 8:30 PM.',
  'Theta Nu Xi cosponsorship approved by MGC.',
].join('\n');

const roster = new Roster(
  ['Alejandro', 'Nader', 'Elias', 'Lucas', 'David', 'James', 'Charley', 'Eavin', 'Bradley', 'Yadel', 'Julian'].map((name, i) => ({
    name,
    aliases: [],
    phone: `1555000${String(i).padStart(4, '0')}`,
  })),
);
const glossary = Glossary.load('glossary.json');

const DB = 'data/_ask-test.db';
const clean = () => ['', '-wal', '-shm'].forEach((x) => rmSync(DB + x, { force: true }));
clean();
const store = new Store(DB);
store.saveSnapshot('test', MINUTES, ex, roster, glossary);
const NOW = new Date('2026-11-02T12:00:00');
const ctx = { senderName: 'Alejandro', quotedEventIds: [] as string[], now: NOW };
const deps = { store, roster, glossary };

// ---------- 1. tools return the right data ----------
const found = JSON.parse(runTool('find_events', { query: 'mgc retreat' }, ctx, deps)) as { id: string; name: string; date: string; required: number }[];
check('find_events finds MGC Retreat first', found[0]?.name === 'MGC Retreat' && found[0]?.date === '2026-11-15', JSON.stringify(found[0]));
const retreatId = found[0]?.id;

const viaOrg = JSON.parse(runTool('find_events', { query: 'theta nu xi' }, ctx, deps)) as { name: string }[];
check('find_events: "theta nu xi" finds the TNX event', viaOrg.some((e) => /tnx/i.test(e.name)), JSON.stringify(viaOrg.map((e) => e.name)));

const details = JSON.parse(runTool('event_details', { event_id: retreatId }, ctx, deps)) as { going: string[]; maybe: string[]; required: number };
check(
  'event_details: Retreat going list + required 8',
  details.required === 8 && ['David', 'Elias', 'James', 'Charley', 'Nader'].every((n) => details.going.includes(n)),
  JSON.stringify(details),
);

const mine = runTool('my_events', { days: 30 }, ctx, deps);
check('my_events (as Alejandro) includes TNX Cosponsor', /tnx/i.test(mine), mine);
check('my_events with unknown sender says so', /unknown sender/i.test(runTool('my_events', {}, { ...ctx, senderName: null }, deps)));

const window = JSON.parse(runTool('find_events', { from: '2026-11-03', days: 1 }, ctx, deps)) as { name: string; date: string }[];
check('find_events date window (11/3-11/4)', window.length > 0 && window.every((e) => e.date >= '2026-11-03' && e.date <= '2026-11-04'), JSON.stringify(window));

// ---------- 2. privacy filter ----------
const retreatSearch = runTool('search_minutes', { query: 'retreat dress code' }, ctx, deps);
check('search_minutes finds the dress code line', /business casual/i.test(retreatSearch), retreatSearch);
const fineSearch = runTool('search_minutes', { query: 'bradley fines owes' }, ctx, deps);
check('search_minutes never returns fines / $ lines', !/\$|owes|fine/i.test(fineSearch), fineSearch);
const advisor = runTool('search_minutes', { query: 'advisor contact smith' }, ctx, deps);
check('search_minutes never returns phones / emails', !/555-1234|@ufl\.edu/.test(advisor), advisor);
check('isSensitive catches phones, $, emails, dues', ['call 352 555 1234', 'dues are $50', 'x@y.com', 'owes dues'].every(isSensitive));
check('isSensitive leaves normal lines alone', !['MGC Retreat Sun 11/15 12pm', 'event 2026-11-15-mgc-retreat'].some(isSensitive));
check('scrub drops only the bad line', scrub('hi\ncall 352-555-1234\nbye') === 'hi\nbye');

// ---------- 3. rate limit ----------
for (let i = 0; i < 20; i++) store.bumpAsk('15550000000', '2026-11-02');
check('rate limit: 20 questions counted', store.askCount('15550000000', '2026-11-02') === 20);
check('rate limit: other people / days unaffected', store.askCount('15550000001', '2026-11-02') === 0 && store.askCount('15550000000', '2026-11-03') === 0);

// ---------- 4. reply -> event context ----------
store.recordSent('MSG_TOMORROW', 'tomorrow', [retreatId]);
check('sent message remembers its event ids', store.sentMessage('MSG_TOMORROW')?.eventIds[0] === retreatId);
check('unknown message id has no context', store.sentMessage('NOPE') === undefined);

// ---------- 5. the agent loop, with a fake model ----------
/** Build a fake Claude response. */
const msg = (content: Anthropic.ContentBlock[], stop: Anthropic.StopReason): Anthropic.Message =>
  ({ id: 'm', type: 'message', role: 'assistant', model: 'fake', content, stop_reason: stop, stop_sequence: null, usage: {} }) as unknown as Anthropic.Message;
const toolUse = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input }) as unknown as Anthropic.ContentBlock;
const text = (t: string) => ({ type: 'text', text: t, citations: null }) as unknown as Anthropic.ContentBlock;

// Scripted conversation: "where is this?" as a reply to the Retreat reminder.
const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
const fake: ModelClient = {
  messages: {
    async create(p) {
      calls.push(structuredClone(p));
      if (calls.length === 1) {
        // A real model would read the event id from the prompt; the fake checks it's actually there.
        const prompt = String(p.messages[0].content);
        const id = /event id\(s\): (\S+)/.exec(prompt)?.[1] ?? 'missing';
        return msg([toolUse('t1', 'event_details', { event_id: id })], 'tool_use');
      }
      return msg([text('*MGC Retreat* is Sun 11/15, 12-2pm at Arredondo Cafe. Call 352-555-1234 for help.')], 'end_turn');
    },
  },
};
const steps: AskStep[] = [];
const out = await answer('where is this?', { ...ctx, quotedEventIds: [retreatId] }, { ...deps, client: fake, model: 'fake', maxRounds: 4, onStep: (s) => steps.push(s) });
check('reply context reaches the model (event id in the prompt)', String(calls[0].messages[0].content).includes(retreatId));
check('loop: tool result sent back on the 2nd call', calls.length === 2 && JSON.stringify(calls[1].messages[2]).includes('tool_result'));
check('tool result came from our DB (Arredondo Cafe)', steps.some((s) => s.type === 'tool' && /Arredondo/i.test(s.output)));
check('final answer returned', /Arredondo Cafe/.test(out), out);
check('final answer: phone hidden, rest of the sentence kept', !/555-1234/.test(out) && /\[hidden\]/.test(out), out);
check('redact drops fines lines entirely', redact('ok line\nBradley owes $20 in fines') === 'ok line');

// A model that never stops calling tools: the loop must end, with tools turned off on the last round.
let n = 0;
const greedy: ModelClient = {
  messages: {
    async create(p) {
      n++;
      if (p.tool_choice?.type === 'none') return msg([text('best guess with what I have')], 'end_turn');
      return msg([toolUse(`t${n}`, 'find_events', { query: 'retreat' })], 'tool_use');
    },
  },
};
const forced = await answer('loop forever', ctx, { ...deps, client: greedy, model: 'fake', maxRounds: 3 });
check('max rounds: stops after 3 tool rounds + 1 forced answer', n === 4 && forced === 'best guess with what I have', `calls=${n} out=${forced}`);

// Unknown tool / bad input doesn't crash.
check('unknown tool handled', /Unknown tool/.test(runTool('drop_tables', {}, ctx, deps)));
check('missing event handled', /No event/.test(runTool('event_details', { event_id: 'zzz-nothing' }, ctx, deps)));

store.db.close();
clean();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
