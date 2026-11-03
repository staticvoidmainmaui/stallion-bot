/**
 * Every message the bot sends lives here. Change wording or layout in this file only;
 * the rest of the code decides *when* to send, this file decides *what it says*.
 *
 * WhatsApp formatting: *bold*  _italic_  ~strike~  "> " quote line, "- " list line.
 * Bold = titles only (section headers, day labels). Event names in lists stay plain.
 * House style: SIG opens every bot message on its own line; list lines read "- *Name* · when · count"
 * ("> " in the Monday digest).
 */
import { addDays, shortfall, todayISO, type EventView } from './events.js';
import type { Extraction } from './extract.js';

/** Opens every bot message, on its own line. */
// ``` = WhatsApp monospace. Inside it, * and _ show as-is (no bold/italics), so the real stars stay visible.
export const SIG = '```[*STALLION_BOT*🎠]```';
/** Normal list lines. */
export const LIST = '- ';
/**
 * List lines in the Monday digest only. "> " = WhatsApp quote line (grey bar on the left).
 * Other options: '▸ ', '➤ ', '┃ ', '◆ '.
 */
export const WEEKLY_BULLET = '> ';
/** List lines in the daily / on-demand digest (!digest). */
export const DIGEST_BULLET = '▸ ';
export const POLL_OPTIONS = ['Going', 'Maybe', "Can't"];

// ---------- small formatters ----------

/** "18:00" -> "6p", "18:30" -> "6:30p", "12:00" -> "12p". */
export function fmtTime(t: string | null): string {
  if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return '';
  const [h, m] = t.split(':').map(Number);
  const hh = h % 12 || 12;
  return `${hh}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'a' : 'p'}`;
}

/** "Today", "Tmrw", "Tue" (this week) or "Mon 11/9" (further out). */
export function fmtDay(date: string | null, now = new Date()): string {
  if (!date) return 'TBD';
  if (date === todayISO(now)) return 'Today';
  if (date === todayISO(addDays(now, 1))) return 'Tmrw';
  const d = new Date(`${date}T12:00:00`);
  const wd = d.toLocaleDateString('en-US', { weekday: 'short' });
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return date <= todayISO(addDays(now, 6)) ? wd : `${wd} ${md}`;
}

/** Long form for headers: "Tue 11/3". */
export function fmtDate(date: string | null): string {
  if (!date) return 'TBD';
  const d = new Date(`${date}T12:00:00`);
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.getMonth() + 1}/${d.getDate()}`;
}

export function when(v: EventView, now = new Date()): string {
  return [fmtDay(v.date, now), fmtTime(v.start_time)].filter(Boolean).join(' ');
}

/** Hide placeholder locations. */
export function place(v: EventView): string {
  const l = (v.location ?? '').trim();
  return !l || /^(tba|tbd|not yet decided|n\/a)\.?$/i.test(l) ? '' : l;
}

/** "3/4 ⚠️" when a headcount is required, "3 going" otherwise, plus "1 maybe". Empty when nothing to show. */
export function count(v: EventView): string {
  const parts: string[] = [];
  if (v.required_count) parts.push(`${v.going.length}/${v.required_count} ${shortfall(v) ? '⚠️' : '✅'}`);
  else if (v.going.length) parts.push(`${v.going.length} going`);
  if (v.tentative.length) parts.push(`${v.tentative.length} maybe`);
  return parts.join(' · ');
}

const names = (rows: { roster_name: string | null; raw_name: string }[]) => rows.map((r) => r.roster_name ?? r.raw_name).join(', ');

/** "> *TNX Cosponsor* · Tue 6p · 3/4 ⚠️" */
export function line(v: EventView, now = new Date(), opts: { day?: boolean; bullet?: string } = {}): string {
  const w = opts.day === false ? fmtTime(v.start_time) : when(v, now);
  return [`${opts.bullet ?? LIST}${v.name}`, w, count(v)].filter(Boolean).join(' · ');
}

// ---------- commands ----------

export function help(mode: 'all' | 'digest'): string {
  if (mode === 'digest') {
    return `${SIG}\n\n*Commands*
${LIST}!digest · next 2 days
${LIST}!weekly · this week (Monday digest)
${LIST}!remind · send tomorrow's reminders now`;
  }
  return `${SIG}\n\n*Commands*
${LIST}!events · this week
${LIST}!event <name> · details + who's going
${LIST}!short · events that need bros
${LIST}!poll <name> · attendance poll
${LIST}!votes <name> · poll results
${LIST}!summary · chapter recap
Exec: !tag · !followup · !goals · !digest · !weekly · !remind · !refresh · !members`;
}

export function events(evs: EventView[], days: number, now = new Date()): string {
  if (!evs.length) return `${SIG}\n\nNothing on the calendar for the next ${days} days.`;
  const head = days === 7 ? 'This week' : `Next ${days} days`;
  return `${SIG}\n\n*${head}*\n${evs.map((v) => line(v, now)).join('\n')}`;
}

export function eventDetail(v: EventView, now = new Date()): string {
  const s = shortfall(v);
  const links = (JSON.parse(v.links_json) as { text: string; url: string }[]).map((l) => `🔗 ${l.text}: ${l.url}`);
  return [
    `${SIG}\n\n*${v.name}* · ${[fmtDate(v.date), fmtTime(v.start_time)].filter(Boolean).join(' · ')}`,
    v.name !== v.title ? `_${v.title}_` : '',
    place(v) ? `📍 ${place(v)}` : '',
    v.going.length ? `Going (${v.going.length}): ${names(v.going)}` : 'Going: nobody yet',
    v.tentative.length ? `Maybe: ${names(v.tentative)}` : '',
    v.excused.length ? `Excused: ${names(v.excused)}` : '',
    s ? `⚠️ Need ${s} more (${v.required_count} requested)` : v.required_count ? `✅ Covered (${v.required_count} requested)` : '',
    v.notes ? `_${v.notes}_` : '',
    ...links,
  ]
    .filter(Boolean)
    .join('\n');
}

export const askWhich = () => `${SIG}\n\nWhich event? Try \`!event retreat\``;
export const noMatch = (q: string) => `${SIG}\n\nNo event matching "${q}". Try \`!events 14\``;
export const execOnly = () => `🔒 Exec only.`;

/** "> *MGC Retreat* · Sun 11/15 12p · 5/8 · need 3" (used by !short, !weekly, !summary). */
export function needLines(evs: EventView[], now = new Date(), bullet = LIST): string {
  return evs.map((v) => `${bullet}${v.name} · ${when(v, now)} · ${v.going.length}/${v.required_count} · need ${shortfall(v)}`).join('\n');
}

export function short(evs: EventView[], now = new Date()): string {
  if (!evs.length) return `${SIG}\n\nEvery event coming up has enough bros ✅`;
  return `${SIG}\n\n*Need bros*\n${needLines(evs, now)}`;
}

export function tag(v: EventView, mentions: string, now = new Date()): string {
  const head = [`${SIG}\n\n*${v.name}*`, when(v, now), place(v)].filter(Boolean).join(' · ');
  return `${head}\n${mentions}`;
}

export const nobodySignedUp = (v: EventView) => `${SIG}\n\nNobody's signed up for ${v.name} yet.`;

/** Text that goes right before a follow-up poll. */
export function followup(v: EventView, mentions: string, now = new Date()): string {
  const s = shortfall(v);
  const head = [`${SIG}\n\n*${v.name}*`, when(v, now), s ? `need ${s} more` : ''].filter(Boolean).join(' · ');
  return mentions ? `${head}\nStill a maybe? Vote below 👇 ${mentions}` : `${head}\nVote below 👇`;
}

export const nobodyToFollowUp = () => `${SIG}\n\nNo maybes or excused bros to chase this week.`;

/** Polls stay in the chat, so they use the real date ("Tue 11/3"), never "Tmrw". Polls don't render *bold*, so no SIG. */
export const pollTitle = (v: EventView) =>
  `🎠 ${v.name} · ${[fmtDate(v.date), fmtTime(v.start_time)].filter(Boolean).join(' ')}`.slice(0, 250);

export function votes(v: EventView, rows: { option: string; who: string[] }[], unknown: number): string {
  const body = rows.map((r) => `${r.option} (${r.who.length}): ${r.who.join(', ') || '—'}`).join('\n');
  return `${SIG}\n\n*${v.name}* poll\n${body}${unknown ? `\n_${unknown} vote(s) from numbers not in the roster_` : ''}`;
}

export const noPoll = (v: EventView, q: string) => `${SIG}\n\nNo poll yet for ${v.name}. Start one: \`!poll ${q}\``;

/** One line per director: every goal, merged across their sections. */
export function goals(rows: { tag: string; goals: string[] }[]): string {
  if (!rows.length) return `${SIG}\n\nNo "Goals for next meeting" in the minutes.`;
  return `${SIG}\n\n*Goals for next meeting*\n${rows.map((r) => `${LIST}${r.tag}: ${r.goals.join(' · ')}`).join('\n')}`;
}

export function summary(meetingDate: string | null, needBros: EventView[], items: Extraction['summaryItems']): string {
  const head = `${SIG}\n\n*Chapter recap${meetingDate ? ` · ${fmtDate(meetingDate)}` : ''}*`;
  const need = needBros.length ? `⚠️ *Need bros*\n${needLines(needBros)}` : '';
  const body = items.length ? `📌 *Heads up*\n${items.map((i) => `${LIST}${i.text.replace(/\.$/, '')}`).join('\n')}` : '';
  return [head, need, body].filter(Boolean).join('\n\n');
}

export const noMinutes = () => `${SIG}\n\nNo minutes loaded yet. An exec can run \`!refresh\`.`;
export const refreshing = () => `${SIG}\n\nReading the minutes…`;
export function refreshed(events: number, meetingDate: string | null, unknown: string[]): string {
  return `${SIG}\n\n✅ ${events} events loaded · meeting ${meetingDate ? fmtDate(meetingDate) : '?'}${
    unknown.length ? `\n❓ Not in roster: ${unknown.join(', ')}` : ''
  }`;
}
export const refreshFailed = (err: string) => `${SIG}\n\n❌ Couldn't read the minutes: ${err}`;
export const membersPrinted = (n: number) => `${SIG}\n\nPrinted ${n} members to the bot's console (not posted here).`;
export const groupId = (jid: string) => `This chat's ID:\n${jid}\nPut it in CHAPTER_GROUP_JID in .env and restart.`;

// ---------- automatic messages ----------

export function reminderTomorrow(v: EventView, mentions: string, now = new Date()): string {
  // If the bot only catches the event on the day itself, say "Today", not "Tomorrow".
  const label = v.date === todayISO(now) ? 'Today' : 'Tomorrow';
  const head = [`${SIG}\n\n*${label}* · ${v.name}`, fmtTime(v.start_time), place(v)].filter(Boolean).join(' · ');
  const s = shortfall(v);
  const cnt = [
    v.required_count ? `${v.going.length}/${v.required_count}${s ? '' : ' ✅'}` : v.going.length ? `${v.going.length} going` : '',
    s ? `⚠️ need ${s} more` : '',
    v.tentative.length ? `${v.tentative.length} maybe` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return [head, cnt, mentions].filter(Boolean).join('\n');
}

export function reminderSoon(v: EventView, mentions: string): string {
  const head = [`${SIG}\n\n⏰ *Starting soon* · ${v.name}`, fmtTime(v.start_time), place(v)].filter(Boolean).join(' · ');
  return [head, mentions].filter(Boolean).join('\n');
}

/** Day-grouped list: "*Tue 11/3*" then that day's events. */
function byDay(evs: EventView[], now: Date): string {
  const days = [...new Set(evs.map((v) => v.date ?? ''))];
  return days
    .map((d) => {
      const label = d === todayISO(now) ? 'Today' : d === todayISO(addDays(now, 1)) ? `Tomorrow · ${fmtDate(d)}` : fmtDate(d);
      return `*${label}*\n${evs
        .filter((v) => v.date === d)
        .map((v) => line(v, now, { day: false, bullet: DIGEST_BULLET }))
        .join('\n')}`;
    })
    .join('\n');
}

/** Daily / on-demand digest for the next couple of days. Null = nothing to post. */
export function digest(evs: EventView[], now = new Date()): string | null {
  if (!evs.length) return null;
  return `${SIG}\n\n*Coming up*\n${byDay(evs, now)}`;
}

/** Monday digest, sent after the UF Betas sticker: the week + who we still need. */
export function weekly(evs: EventView[], needBros: EventView[], _chapterTime: string, _chapterLocation: string, now = new Date()): string {
  const week = evs.length
    ? `*This week*\n${evs.map((v) => line(v, now, { bullet: WEEKLY_BULLET })).join('\n')}`
    : '*This week*\n_Nothing on the calendar._';
  const need = needBros.length ? `⚠️ *Need bros*\n${needLines(needBros, now, WEEKLY_BULLET)}` : '';
  return `${SIG}\n\n${[week, need].filter(Boolean).join('\n\n')}`;
}

// ---------- final pass ----------

/**
 * House style, applied to every message right before it's sent (Bot.reply):
 * - LOWERCASE: everything lowercase except titles, @tags, links, `code`.
 * - MONO: the whole message in a ``` monospace block. WhatsApp ignores *bold* inside it,
 *   so *titles* become CAPS. Lines with @tags or links stay outside the block so they still work.
 */
export const LOWERCASE = true;
export const MONO = true;

const KEEP = /(\*[^*\n]+\*|```[^`]*```|`[^`\n]*`|@\S+|https?:\/\/\S+)/g;
const OUTSIDE = /@\d|@\w+|https?:\/\//; // tags and links must stay outside monospace

function lower(text: string): string {
  return text
    .split('\n')
    .map((l) => l.split(KEEP).map((part, i) => (i % 2 ? part : part.toLowerCase())).join(''))
    .join('\n');
}

function monoLine(l: string): string {
  if (l === SIG) return SIG.replace(/```/g, ''); // stars stay visible inside monospace
  return l
    .replace(/```/g, '')
    .replace(/\*([^*\n]+)\*/g, (_m, t: string) => t.toUpperCase()) // *Title* -> TITLE
    .replace(/(^|\s)_([^_\n]+)_(?=$|\s|[.,;:!?])/g, '$1$2') // _italic_ -> plain
    .replace(/`([^`\n]*)`/g, '$1');
}

export function style(text: string, opts: { mono?: boolean } = {}): string {
  const t = LOWERCASE ? lower(text) : text;
  if (!(opts.mono ?? MONO)) return t;
  const out: string[] = [];
  let block: string[] = [];
  const flush = () => {
    while (block.length && !block[0].trim()) block.shift();
    while (block.length && !block[block.length - 1].trim()) block.pop();
    if (block.length) out.push('```' + block.join('\n') + '```');
    block = [];
  };
  for (const l of t.split('\n')) {
    if (OUTSIDE.test(l)) {
      flush();
      out.push(l);
    } else block.push(monoLine(l));
  }
  flush();
  return out.join('\n');
}
