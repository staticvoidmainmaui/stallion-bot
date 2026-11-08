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
import { answer, capAnswer, composeReply, HEADER_ONLY, headerEventId, isSensitive, linkedDocs, redact, runTool, scrub, type AskStep, type ModelClient } from '../src/ask.js';
import { DocReader, parseGoogleUrl, type FetchLike } from '../src/docread.js';
import { route, type RouteInput } from '../src/route.js';
import * as M from '../src/messages.js';
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
  'MGC E-Board Elections: details in [MGC elections info](https://docs.google.com/document/d/ELECT1234567/edit) and [Market slots](https://docs.google.com/spreadsheets/d/SHEET1234567/edit#gid=42).',
  'Private notes: [Exec only doc](https://docs.google.com/document/d/PRIVATE12345/edit)',
  'Sign up here: [Retreat RSVP form](https://docs.google.com/forms/d/e/FORM12345678/viewform)',
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
const found = JSON.parse(await runTool('find_events', { query: 'mgc retreat' }, ctx, deps)) as { id: string; name: string; date: string; required: number }[];
check('find_events finds MGC Retreat first', found[0]?.name === 'MGC Retreat' && found[0]?.date === '2026-11-15', JSON.stringify(found[0]));
const retreatId = found[0]?.id;

const viaOrg = JSON.parse(await runTool('find_events', { query: 'theta nu xi' }, ctx, deps)) as { name: string }[];
check('find_events: "theta nu xi" finds the TNX event', viaOrg.some((e) => /tnx/i.test(e.name)), JSON.stringify(viaOrg.map((e) => e.name)));

const details = JSON.parse(await runTool('event_details', { event_id: retreatId }, ctx, deps)) as { going: string[]; maybe: string[]; required: number };
check(
  'event_details: Retreat going list + required 8',
  details.required === 8 && ['David', 'Elias', 'James', 'Charley', 'Nader'].every((n) => details.going.includes(n)),
  JSON.stringify(details),
);

const mine = await runTool('my_events', { days: 30 }, ctx, deps);
check('my_events (as Alejandro) includes TNX Cosponsor', /tnx/i.test(mine), mine);
check('my_events with unknown sender says so', /unknown sender/i.test(await runTool('my_events', {}, { ...ctx, senderName: null }, deps)));

const window = JSON.parse(await runTool('find_events', { from: '2026-11-03', days: 1 }, ctx, deps)) as { name: string; date: string }[];
check('find_events date window (11/3-11/4)', window.length > 0 && window.every((e) => e.date >= '2026-11-03' && e.date <= '2026-11-04'), JSON.stringify(window));

// ---------- 2. privacy filter ----------
const retreatSearch = await runTool('search_minutes', { query: 'retreat dress code' }, ctx, deps);
check('search_minutes finds the dress code line', /business casual/i.test(retreatSearch), retreatSearch);
const fineSearch = await runTool('search_minutes', { query: 'bradley fines owes' }, ctx, deps);
check('search_minutes never returns fines / $ lines', !/\$|owes|fine/i.test(fineSearch), fineSearch);
const advisor = await runTool('search_minutes', { query: 'advisor contact smith' }, ctx, deps);
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
const res = await answer('where is this?', { ...ctx, quotedEventIds: [retreatId] }, { ...deps, client: fake, model: 'fake', maxRounds: 4, onStep: (s) => steps.push(s) });
check('reply context reaches the model (event id in the prompt)', String(calls[0].messages[0].content).includes(retreatId));
check('loop: tool result sent back on the 2nd call', calls.length === 2 && JSON.stringify(calls[1].messages[2]).includes('tool_result'));
check('tool result came from our DB (Arredondo Cafe)', steps.some((s) => s.type === 'tool' && /Arredondo/i.test(s.output)));
const out = res.text;
check('final answer returned', /Arredondo Cafe/.test(out), out);
check('final answer: phone hidden, rest of the sentence kept', !/555-1234/.test(out) && /\[hidden\]/.test(out), out);
check('answer remembers which event it opened (for the header)', res.detailIds.length === 1 && res.detailIds[0] === retreatId, JSON.stringify(res.detailIds));
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
check('max rounds: stops after 3 tool rounds + 1 forced answer', n === 4 && forced.text === 'best guess with what I have', `calls=${n} out=${forced.text}`);

// Unknown tool / bad input doesn't crash.
check('unknown tool handled', /Unknown tool/.test(await runTool('drop_tables', {}, ctx, deps)));
check('missing event handled', /No event/.test(await runTool('event_details', { event_id: 'zzz-nothing' }, ctx, deps)));

// ---------- 6. routing: which chat asks, which chat answers ----------
const ALERTS = 'alerts@g.us', QA = 'qa@g.us';
const base: RouteInput = { chat: ALERTS, isGroup: true, fromMe: false, text: '', quotedEventIds: null, alertsJid: ALERTS, askJid: QA, askEnabled: true, askDms: false };
const r = (o: Partial<RouteInput>) => route({ ...base, ...o });
check('route: Q&A chat, plain text -> question answered in Q&A, quoted', JSON.stringify(r({ chat: QA, text: 'where is retreat?' })) === JSON.stringify({ kind: 'ask', question: 'where is retreat?', eventIds: [], answerIn: QA, quote: true, tagAsker: false }));
check('route: Q&A chat, !help works', r({ chat: QA, text: '!help' }).kind === 'command');
check('route: Q&A chat, other commands ignored', r({ chat: QA, text: '!weekly' }).kind === 'ignore');
check('route: !groupid works anywhere', r({ chat: 'other@g.us', text: '!groupid' }).kind === 'command' && r({ chat: QA, text: '!groupid' }).kind === 'command');
const redirected = r({ text: 'who else is going?', quotedEventIds: [retreatId] });
check('route: reply to the bot in alerts -> answered in Q&A, asker tagged', redirected.kind === 'ask' && redirected.answerIn === QA && redirected.tagAsker && !redirected.quote && redirected.eventIds[0] === retreatId, JSON.stringify(redirected));
check('route: !ask in alerts -> answered in Q&A', (() => { const x = r({ text: '!ask when is market?' }); return x.kind === 'ask' && x.answerIn === QA && x.question === 'when is market?'; })());
check('route: normal chatter in alerts ignored', r({ text: 'lol see yall there' }).kind === 'ignore');
check('route: commands in alerts still commands', (() => { const x = r({ text: '!weekly' }); return x.kind === 'command' && x.cmd === 'weekly'; })());
check('route: no Q&A chat set -> answer stays in alerts, quoted', (() => { const x = route({ ...base, askJid: '', text: 'where?', quotedEventIds: [retreatId] }); return x.kind === 'ask' && x.answerIn === ALERTS && x.quote && !x.tagAsker; })());
check('route: other groups ignored', r({ chat: 'random@g.us', text: 'where is retreat?' }).kind === 'ignore');
check('route: DMs ignored while ASK_DMS=false', r({ chat: '1555@s.whatsapp.net', isGroup: false, text: 'where?' }).kind === 'ignore');
check('route: DMs answered when ASK_DMS=true, never your own outgoing DMs', r({ chat: '1555@s.whatsapp.net', isGroup: false, askDms: true, text: 'where?' }).kind === 'ask' && r({ chat: '1555@s.whatsapp.net', isGroup: false, askDms: true, fromMe: true, text: 'hey' }).kind === 'ignore');
check('route: ASK_ENABLED=false silences the Q&A chat', r({ chat: QA, text: 'where?', askEnabled: false }).kind === 'ignore');

// ---------- 7. header + output cap ----------
const long = 'a'.repeat(120);
check('cap: max 3 lines', capAnswer('one\ntwo\nthree\nfour') === 'one\ntwo\nthree');
check('cap: ~300 chars, cut on a line boundary', capAnswer([long, long, long].join('\n')) === [long, long].join('\n'));
const oneLong = `word `.repeat(70) + 'https://docs.google.com/document/d/ABCDEFGHIJKL/edit';
const cut = capAnswer(oneLong);
check('cap: one long line cut at a space, never inside a link', cut.length <= 300 && cut.endsWith('…') && !/https?:/.test(cut), cut);
check('header event: one event_details -> that event', headerEventId({ detailIds: ['x'] }, []) === 'x');
check('header event: none opened, reply about one -> that one', headerEventId({ detailIds: [] }, ['q']) === 'q');
check('header event: several -> no header', headerEventId({ detailIds: ['a', 'b'] }, []) === null && headerEventId({ detailIds: [] }, ['a', 'b']) === null);
const composed = composeReply({ text: 'going: david, elias', detailIds: [retreatId], docsRead: [] }, { store, quotedEventIds: [], now: NOW });
check('compose: code header first, then Claude text', /\n\nMGC Retreat · Sun 11\/15 12p · Arredondo Cafe\ngoing: david, elias$/.test(composed.text), composed.text);
const headerOnly = composeReply({ text: '', detailIds: [retreatId], docsRead: [] }, { store, quotedEventIds: [], now: NOW });
check(`compose: ${HEADER_ONLY} -> just the header line`, /\n\nMGC Retreat · Sun 11\/15 12p · Arredondo Cafe$/.test(headerOnly.text), headerOnly.text);
const moved = composeReply({ text: 'going: david', detailIds: [], docsRead: [] }, { store, quotedEventIds: [retreatId], now: NOW, asker: { tag: '@15550000001', question: 'who else is going?' } });
check('compose: moved to Q&A -> tag + question + "re:" header', /@15550000001 asked: "who else is going\?"\nre: MGC Retreat · Sun 11\/15/.test(moved.text), moved.text);
check('compose: style() keeps the tag line outside monospace', M.style(moved.text).split('\n').some((l) => l.startsWith('@15550000001') && !l.includes('```')));

// ---------- 8. read_doc: only linked docs, filtered, cached ----------
const fetched: string[] = [];
const fakeFetch: FetchLike = async (url, init) => {
  fetched.push(url);
  const html = { ok: true, status: 200, url: 'https://accounts.google.com/ServiceLogin', headers: { get: () => 'text/html' }, text: async () => '<html>sign in</html>' };
  if (url.includes('PRIVATE12345')) return html;
  const body = url.includes('ELECT1234567')
    ? 'MGC E-Board Elections\nRoom: Reitz Union 2335\nFines: late chapters owe $25\nQuestions? 352-555-9999 or mgc@ufl.edu'
    : url.includes('SHEET1234567')
      ? `slot,name\n4pm table,James\ngid=${/gid=(\d+)/.exec(url)?.[1] ?? 'none'}`
      : 'other';
  return { ok: true, status: 200, url, headers: { get: () => 'text/plain' }, text: async () => body, ...(init ? {} : {}) };
};
const docs = new DocReader({ fetch: fakeFetch, scrub });
const ddeps = { ...deps, docs };
check('allowlist: the minutes links are collected with titles', linkedDocs(store).some((l) => l.title === 'MGC elections info' && l.ref.id === 'ELECT1234567'));
const notLinked = await runTool('read_doc', { url: 'https://docs.google.com/document/d/NOTLINKED999/edit' }, ctx, ddeps);
check('read_doc: a doc not in the minutes is refused', notLinked === M.docNotLinked() && !fetched.some((u) => u.includes('NOTLINKED')), notLinked);
check('read_doc: a non-Google link is refused', (await runTool('read_doc', { url: 'https://evil.example.com/x' }, ctx, ddeps)) === M.docNotLinked());
const elect = await runTool('read_doc', { url: 'https://docs.google.com/document/d/ELECT1234567/edit' }, ctx, ddeps);
check('read_doc: linked doc read whole, with its title', /^Doc: MGC elections info/.test(elect) && /Reitz Union 2335/.test(elect), elect);
check('read_doc: fines / $ / phones / emails filtered out of the doc', !/\$|owe|555-9999|@ufl/.test(elect), elect);
check('read_doc: Docs fetched as .txt export', fetched.some((u) => u.includes('/document/d/ELECT1234567/export?format=txt')));
const sheet = await runTool('read_doc', { url: 'https://docs.google.com/spreadsheets/d/SHEET1234567/edit' }, ctx, ddeps);
check('read_doc: Sheets as csv, keeping the tab the minutes linked (gid=42)', /gid=42/.test(sheet) && fetched.some((u) => /SHEET1234567\/export\?format=csv&gid=42/.test(u)), sheet);
const form = await runTool('read_doc', { url: 'https://docs.google.com/forms/d/e/FORM12345678/viewform' }, ctx, ddeps);
check("read_doc: Forms can't be read (no fetch)", /Retreat RSVP form/.test(form) && form.includes(M.docCantRead()) && !fetched.some((u) => u.includes('FORM1234')), form);
const priv = await runTool('read_doc', { url: 'https://docs.google.com/document/d/PRIVATE12345/edit' }, ctx, ddeps);
check('read_doc: private doc (sign-in page) -> not shared', priv.includes(M.docNotShared()), priv);
const before = fetched.length;
await runTool('read_doc', { url: 'https://docs.google.com/document/d/ELECT1234567/edit?usp=sharing' }, ctx, ddeps);
check('read_doc: cached (same doc, different link form -> no second fetch)', fetched.length === before);
check('parseGoogleUrl: drive file + forms.gle', parseGoogleUrl('https://drive.google.com/file/d/FILE1234567890/view')?.kind === 'drive-file' && parseGoogleUrl('https://forms.gle/abc')?.kind === 'forms');

// A full loop where Claude reads the doc and answers with the room + link title.
let k = 0;
const docModel: ModelClient = {
  messages: {
    async create() {
      k++;
      if (k === 1) return msg([toolUse('d1', 'read_doc', { url: 'https://docs.google.com/document/d/ELECT1234567/edit' })], 'tool_use');
      return msg([text('room: reitz union 2335 · 🔗 mgc elections info')], 'end_turn');
    },
  },
};
const viaDoc = await answer('what room are mgc elections in?', ctx, { ...ddeps, client: docModel, model: 'fake', maxRounds: 4 });
check('loop: read_doc result used, doc recorded', viaDoc.text === 'room: reitz union 2335 · 🔗 mgc elections info' && viaDoc.docsRead.length === 1, JSON.stringify(viaDoc));

store.db.close();
clean();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
