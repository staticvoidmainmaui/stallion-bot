/**
 * "Ask" — a small question-answering agent over the chapter's own data.
 *
 * How it works (the agent loop):
 *   1. We send Claude the question + a few facts (today, who's asking, which event they replied to)
 *      and a list of TOOLS it may call. Claude can't see our database; it can only ask for things.
 *   2. Claude answers either with text (done) or with tool_use blocks ("call find_events with ...").
 *   3. We run those tools locally against SQLite / the minutes text and send the results back.
 *   4. Repeat until Claude answers, or MAX_ROUNDS is hit (then we force a final answer with no tools).
 *
 * Everything here is plain functions with the model client passed in, so tests can swap in a fake.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { Store } from './db.js';
import { addDays, between, findEvents, shortfall, todayISO, upcoming, view, type EventView } from './events.js';
import type { Glossary } from './glossary.js';
import type { Roster } from './roster.js';

// ---------- types ----------

/** The one method we need from the Anthropic client. Tests pass a fake with the same shape. */
export interface ModelClient {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
}

export interface AskContext {
  /** Roster name of whoever asked, if known. */
  senderName: string | null;
  /** Event ids from the bot message they replied to (empty for !ask / DMs). */
  quotedEventIds: string[];
  now?: Date;
}

export interface AskDeps {
  store: Store;
  roster: Roster;
  glossary: Glossary;
  client: ModelClient;
  model: string;
  maxRounds: number;
  /** Optional: called for every step, for the CLI's step-by-step printout. */
  onStep?: (step: AskStep) => void;
}

export type AskStep =
  | { type: 'model'; round: number; stopReason: string | null; text: string; toolCalls: { name: string; input: unknown }[] }
  | { type: 'tool'; name: string; input: unknown; output: string };

// ---------- privacy filter ----------

/**
 * Lines that must never reach the group: fines, dues, money owed, dollar amounts, phone numbers, emails.
 * Applied to tool output (so Claude never even sees them) AND to the final answer (defense in depth).
 */
const SENSITIVE = [
  /\b(fines?|dues|owes?|owed|owing|balance|overdue|payment plans?|venmo|zelle|cash ?app)\b/i,
  /\$\s?\d/,
  /\(?\b\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/, // 352-555-1234, (352) 555 1234, 3525551234
  /\b1?\d{10}\b/, // 15615551234
  /[\w.+-]+@[\w-]+\.[\w.]+/, // emails
];
export const isSensitive = (line: string) => SENSITIVE.some((re) => re.test(line));

/** Drop any sensitive line from a block of text. */
export function scrub(text: string): string {
  return text
    .split('\n')
    .filter((l) => !isSensitive(l))
    .join('\n');
}

/** JSON.stringify that hides any sensitive string value (keeps the rest of the object). */
export const safeJson = (v: unknown) => JSON.stringify(v, (_k, val) => (typeof val === 'string' && isSensitive(val) ? '[hidden]' : val));

// ---------- tools ----------

const cleanText = (s: string) => s.replace(/[​ ]/g, ' ').replace(/\s+/g, ' ').trim();

function compact(v: EventView) {
  return {
    id: v.id,
    name: v.name,
    date: v.date,
    time: v.start_time,
    place: v.location,
    going: v.going.length,
    maybe: v.tentative.length,
    required: v.required_count,
    short_by: shortfall(v) || undefined,
    approved: v.approved === null ? undefined : !!v.approved,
  };
}

const names = (rows: { roster_name: string | null; raw_name: string }[]) => rows.map((r) => r.roster_name ?? r.raw_name);

/** Tool definitions Claude sees. The descriptions ARE the instructions: Claude picks tools by reading them. */
export const TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: 'find_events',
    description:
      'Find chapter events. With a query, searches names (org names like "theta nu xi" and "tnx" both work). ' +
      'Without one, lists events in a date window. Returns ids, dates, times, places and headcounts.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words from the event name, e.g. "mgc retreat"' },
        from: { type: 'string', description: 'Start date YYYY-MM-DD (default today)' },
        days: { type: 'integer', description: 'How many days from `from` to include (default 14)' },
      },
    },
  },
  {
    name: 'event_details',
    description:
      'Everything known about one event: who is going / maybe / excused, required headcount, owner (who runs it), ' +
      'approval, notes and links. Use an id from find_events or from the replied-to message.',
    input_schema: {
      type: 'object',
      properties: { event_id: { type: 'string' } },
      required: ['event_id'],
    },
  },
  {
    name: 'my_events',
    description: 'Upcoming events the person asking is signed up for (going, maybe or excused).',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'integer', description: 'How many days ahead (default 14)' } },
    },
  },
  {
    name: 'search_minutes',
    description:
      "Keyword search over this week's meeting minutes text. Use for decisions, deadlines, rules, dress code, " +
      "anything not in the event list. Returns matching lines with a line of context.",
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'list_goals',
    description: 'Directors\' "goals for next meeting" from the minutes, optionally for one person.',
    input_schema: {
      type: 'object',
      properties: { person: { type: 'string' } },
    },
  },
];

/** Run one tool locally. Always returns a string (JSON or a short message) for the tool_result block. */
export function runTool(name: string, input: Record<string, unknown>, ctx: AskContext, deps: Pick<AskDeps, 'store' | 'roster' | 'glossary'>): string {
  const { store, roster, glossary } = deps;
  const now = ctx.now ?? new Date();
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '');
  const int = (k: string, d: number) => (Number.isFinite(Number(input[k])) && Number(input[k]) > 0 ? Math.min(Number(input[k]), 60) : d);

  switch (name) {
    case 'find_events': {
      const q = str('query');
      const evs = q
        ? findEvents(store, q, glossary, now).slice(0, 8)
        : between(store, str('from') || todayISO(now), todayISO(addDays(new Date(`${str('from') || todayISO(now)}T12:00:00`), int('days', 14))), now);
      return evs.length ? safeJson(evs.map(compact)) : 'No matching events.';
    }
    case 'event_details': {
      const id = str('event_id');
      const row = store.getEvent(id) ?? findEvents(store, id, glossary, now)[0];
      if (!row) return `No event with id "${id}". Use find_events first.`;
      const v = 'going' in row ? (row as EventView) : view(store, row);
      return safeJson({
          ...compact(v),
          full_title: v.title,
          section: v.section,
          owner: v.owner,
          time_as_written: v.time_raw,
          required_as_written: v.required_raw,
          going: names(v.going),
          maybe: names(v.tentative),
          excused: names(v.excused),
          notes: v.notes,
          links: (JSON.parse(v.links_json) as { text: string; url: string }[]).map((l) => `${l.text}: ${l.url}`),
      });
    }
    case 'my_events': {
      if (!ctx.senderName) return "Unknown sender (not in the roster), so I can't look up their events.";
      const mine = upcoming(store, int('days', 14), now)
        .map((v) => ({ v, me: v.attendees.find((a) => a.roster_name === ctx.senderName) }))
        .filter((x) => x.me && x.me.status !== 'absent')
        .map((x) => ({ ...compact(x.v), my_status: x.me!.status }));
      return mine.length ? safeJson(mine) : `${ctx.senderName} isn't signed up for anything in that window.`;
    }
    case 'search_minutes': {
      const words = glossary
        .expand(str('query'))
        .flatMap((q) => q.split(/\s+/))
        .filter((w) => w.length > 2);
      if (!words.length) return 'Empty query.';
      const lines = store.latestRawText().split('\n').map(cleanText);
      const scored = lines
        .map((l, i) => ({ i, score: words.filter((w) => l.toLowerCase().includes(w)).length }))
        .filter((x) => x.score > 0 && !isSensitive(lines[x.i]))
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
      if (!scored.length) return 'Nothing in the minutes matches that.';
      const out = scored.map(({ i }) =>
        [lines[i - 1], lines[i], lines[i + 1]]
          .filter((l) => l && !isSensitive(l))
          .join(' / '),
      );
      return out.join('\n');
    }
    case 'list_goals': {
      const all = store.latestSnapshot()?.extraction.directorGoals ?? [];
      const who = str('person');
      const target = who ? (roster.resolve(who).entry?.name ?? who).toLowerCase() : '';
      const rows = all.filter((g) => !target || g.owners.some((o) => (roster.resolve(o).entry?.name ?? o).toLowerCase() === target));
      return rows.length ? safeJson(rows) : 'No goals found.';
    }
    default:
      return `Unknown tool ${name}.`;
  }
}
