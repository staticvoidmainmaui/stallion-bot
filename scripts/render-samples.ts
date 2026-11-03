/**
 * Renders every bot message against the saved extraction (data/parse-fixture.json) without
 * connecting to WhatsApp, so wording changes in src/messages.ts can be reviewed.
 *   npx tsx scripts/render-samples.ts > data/samples.json
 */
import { readFileSync, rmSync } from 'node:fs';
import { config } from '../src/config.js';
import { Store } from '../src/db.js';
import { Roster } from '../src/roster.js';
import { Glossary } from '../src/glossary.js';
import { Bot } from '../src/bot.js';
import { findEvents, upcoming } from '../src/events.js';
import * as M from '../src/messages.js';
import type { Extraction } from '../src/extract.js';

const GROUP = '120363000000000000@g.us';
(config as { groupJid: string }).groupJid = GROUP;

const dbPath = 'data/render-samples.db';
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });
const store = new Store(dbPath);
const roster = Roster.load('roster.json');
const glossary = Glossary.load(config.glossaryPath);
const ex = JSON.parse(readFileSync('data/parse-fixture.json', 'utf8')) as Extraction;
const saved = store.saveSnapshot('fixture', '', ex, roster, glossary);

const bot = new Bot(store, roster, glossary, async () => ({
  changed: true,
  events: saved.events,
  unknown: saved.unknown,
  meetingDate: ex.meetingDate,
}));

let captured: string[] = [];
let n = 0;
(bot as unknown as { send: (jid: string, c: Record<string, unknown>) => Promise<unknown> }).send = async (_jid, c) => {
  if (typeof c.text === 'string') captured.push(c.text);
  else if (c.sticker) captured.push('[UF Betas sticker]');
  else if (c.poll) {
    const p = c.poll as { name: string; values: string[] };
    captured.push(`[WhatsApp poll] ${p.name}\n${p.values.map((v) => `◯ ${v}`).join('\n')}`);
  }
  return { key: { id: `SAMPLE${++n}` } };
};

// Show tags as @Name instead of phone numbers.
const byPhone = new Map(roster.entries.map((e) => [e.phone, e.name] as const));
const pretty = (t: string) => t.replace(/@(\d{8,15})\b/g, (m, d) => (byPhone.has(d) ? `@${byPhone.get(d)}` : m));

const out: { id: string; group: string; command: string; when: string; text: string }[] = [];
let group = '';
async function sample(id: string, command: string, when: string, fn: () => Promise<unknown> | unknown) {
  captured = [];
  await fn();
  out.push({ id, group, command, when, text: pretty(captured.join('\n\n— next message —\n\n')) });
}
const B = bot as unknown as Record<string, (...a: unknown[]) => Promise<void>>;
const say = (t: string) => void captured.push(t);

group = 'Demo: digest & reminders (BOT_MODE=digest)';
await sample('weekly', '!weekly  (and auto: Monday noon)', 'Monday digest: sticker, chapter tonight, the week, who we need', () => bot.postWeekly(GROUP));
await sample('digest', '!digest  (and auto: 9am Tue-Sun)', 'Next 2 days. Run after 6pm it starts tomorrow, so Monday night shows Tue + Wed', () => bot.postDigest(GROUP, 2, true));
const tnx = findEvents(store, 'theta nu xi', glossary)[0];
await sample('remind-24h', '!remind  (and auto: 24h before)', "Tomorrow's events, tagging everyone going or maybe", () => bot.remindTomorrow(GROUP, tnx));
await sample('remind-2h', 'Auto: 2h before', 'Timed events only', () => bot.remindSoon(GROUP, tnx));
await sample('help-demo', '!help  (demo mode)', 'Only the digest commands answer in demo mode', () => say(M.help('digest')));

group = 'Commands anyone can run';
await sample('help', '!help', 'Full mode', () => say(M.help('all')));
await sample('events', '!events', 'Next 7 days', () => say(M.events(upcoming(store, 7), 7)));
await sample('event', '!event theta nu xi', 'Org names work either way: "tnx" or "theta nu xi"', () => B.cmdEvent(GROUP, 'theta nu xi'));
await sample('short', '!short', 'Next 21 days, under their headcount', () => say(M.short(bot.needBros(21))));
await sample('poll', '!poll mgc retreat', 'Native WhatsApp poll; votes update attendance', () => B.cmdPoll(GROUP, 'mgc retreat'));

// Fake votes so !votes and the poll-merged counts have something to show.
const retreat = findEvents(store, 'mgc retreat', glossary)[0];
const pollId = store.latestPollForEvent(retreat.id)!;
const voter = (name: string) => `${roster.entries.find((e) => e.name === name)?.phone ?? '15550000000'}@s.whatsapp.net`;
store.replaceVotes(pollId, [
  { voter: voter('Michael'), option: 'Going', voterName: 'Michael' },
  { voter: voter('Chris'), option: 'Going', voterName: 'Chris' },
  { voter: voter('George'), option: 'Maybe', voterName: 'George' },
  { voter: voter('Derek'), option: "Can't", voterName: 'Derek' },
]);
await sample('votes', '!votes mgc retreat', 'Sample votes: Chris voted Going, so Retreat is now 5/8', () => B.cmdVotes(GROUP, 'mgc retreat'));
await sample('summary', '!summary', 'Need-bros line + up to 5 takeaways still ahead of us', () => B.cmdSummary(GROUP));

group = 'Exec-only commands';
await sample('tag', '!tag mgc retreat', 'Tags everyone going + maybe', () => B.cmdTag(GROUP, 'mgc retreat'));
await sample('followup', '!followup tnx', 'Tags maybes who haven’t voted, then posts a poll', () => B.cmdFollowup(GROUP, 'tnx'));
await sample('goals', '!goals', 'One line per director, merged across sections', () => B.cmdGoals(GROUP, ''));
await sample('goals-one', '!goals julian', 'One director in full', () => B.cmdGoals(GROUP, 'julian'));
await sample('refresh', '!refresh', 'Re-reads the minutes', () => B.cmdRefresh(GROUP));
await sample('members', '!members', 'Member list goes to the server console', () => say(M.membersPrinted(16)));

group = 'Errors, empty states and setup';
await sample('events-empty', '!events (nothing scheduled)', '', () => say(M.events([], 7)));
await sample('short-ok', '!short (all covered)', '', () => say(M.short([])));
await sample('event-noarg', '!event (no name)', '', () => say(M.askWhich()));
await sample('event-nomatch', '!event zzz', '', () => say(M.noMatch('zzz')));
await sample('tag-empty', '!tag townhall', 'Nobody signed up yet', () => B.cmdTag(GROUP, 'townhall'));
await sample('followup-none', '!followup (nobody to chase)', '', () => say(M.nobodyToFollowUp()));
await sample('votes-none', '!votes townhall', 'No poll yet', () => B.cmdVotes(GROUP, 'townhall'));
await sample('refresh-fail', '!refresh (error)', '', () => say(`${M.refreshing()}\n\n— next message —\n\n${M.refreshFailed('<error>')}`));
await sample('execonly', 'Exec command by a non-exec', '', () => say(M.execOnly()));
await sample('groupid', '!groupid', 'Setup; works in any chat', () => say(M.groupId(GROUP)));

console.log(JSON.stringify(out, null, 1));
store.db.close();
process.exit(0);
