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
import { parseGoogleUrl, sameDoc, urlsIn, type DocReader } from './docread.js';
import * as M from './messages.js';

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
  /** Opens Google Docs/Sheets/Slides linked in the minutes (read_doc). Omitted = read_doc says it can't. */
  docs?: DocReader;
  /** Optional: called for every step, for the CLI's step-by-step printout. */
  onStep?: (step: AskStep) => void;
}

/** What answer() returns: the model's text plus what it looked at (so code can build the header). */
export interface AskResult {
  /** Claude's text after the privacy filter and the length cap. May be '' when the header alone answers it. */
  text: string;
  /** Event ids Claude opened with event_details, in order, no repeats. */
  detailIds: string[];
  /** Doc links Claude opened with read_doc. */
  docsRead: string[];
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

/**
 * For Claude's final answer: hide phone numbers, emails and dollar amounts in place (keep the rest of
 * the sentence), and drop any line that's about fines/dues/money owed.
 */
export function redact(text: string): string {
  return scrub(
    text
      .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[hidden]')
      .replace(/\(?\b\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[hidden]')
      .replace(/\b1?\d{10}\b/g, '[hidden]')
      .replace(/\$\s?\d[\d,.]*/g, '[hidden]'),
  );
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
      'approval, notes and links (title: url). Use an id from find_events or from the replied-to message. ' +
      "If the answer isn't here or in the minutes, open the event's links with read_doc.",
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
    name: 'read_doc',
    description:
      'Open a Google Doc / Sheet / Slides deck that the minutes link to (from event_details links or the minutes text) ' +
      'and read it whole. Use it when the minutes point to a doc for details: room, agenda, sign-up slots, requirements. ' +
      'Only links written in the minutes work. Forms and private docs can\'t be read: then give the link title instead.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The link exactly as given by event_details or the minutes' } },
      required: ['url'],
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

/** Google links the minutes contain (event links first, so they keep their titles), for read_doc's allowlist. */
export function linkedDocs(store: Store): { url: string; title: string | null; ref: NonNullable<ReturnType<typeof parseGoogleUrl>> }[] {
  const out: { url: string; title: string | null; ref: NonNullable<ReturnType<typeof parseGoogleUrl>> }[] = [];
  const add = (url: string, title: string | null) => {
    const ref = parseGoogleUrl(url);
    if (ref && !out.some((o) => sameDoc(o.ref, ref))) out.push({ url, title, ref });
  };
  for (const e of store.allEvents()) {
    for (const l of JSON.parse(e.links_json) as { text: string; url: string }[]) add(l.url, l.text || null);
  }
  const raw = store.latestRawText();
  for (const m of raw.matchAll(/\[([^\]]{1,120})\]\((https?:\/\/[^)\s]+)\)/g)) add(m[2], m[1]);
  for (const u of urlsIn(raw)) add(u, null);
  return out;
}

/** Run one tool locally. Always returns a string (JSON or a short message) for the tool_result block. */
export async function runTool(
  name: string,
  input: Record<string, unknown>,
  ctx: AskContext,
  deps: Pick<AskDeps, 'store' | 'roster' | 'glossary' | 'docs'>,
): Promise<string> {
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
    case 'read_doc': {
      const url = str('url');
      const ref = parseGoogleUrl(url);
      const linked = linkedDocs(store);
      const match = ref && linked.find((l) => sameDoc(l.ref, ref));
      if (!ref || !match) return M.docNotLinked();
      if (!deps.docs) return M.docNotShared();
      // Keep the tab the minutes linked to, unless Claude passed a specific tab of that same sheet.
      const got = await deps.docs.read(ref.gid ? ref : match.ref);
      if (!got.ok) return `${match.title ? `"${match.title}": ` : ''}${got.reason}`;
      return `Doc: ${match.title ?? url}\n${got.text}`;
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

// ---------- the agent loop ----------

/** The marker Claude returns when the code-built header line already answers the question. */
export const HEADER_ONLY = 'HEADER_ONLY';

export const SYSTEM = `You answer questions for brothers of a fraternity chapter (Sigma Lambda Beta, Zeta Beta) in their WhatsApp Q&A chat.

SCOPE: chapter events, deadlines, dates, times, places, who's going, and info in the minutes or the docs they link to.
- Bylaws, policies, judicial or discipline questions: one line saying to ask the Judicial Chancellor.
- Anything not about the chapter: one line saying you only answer chapter questions.

HOW TO ANSWER:
- Answer ONLY what was asked. One fact per line, at most 3 short lines. No extra details unless asked.
- Use only tool results. Never guess dates, times, places or names.
- Not in the minutes: open the event's linked doc with read_doc. Still nothing: say it's not in the minutes and name who to ask (the event's owner from event_details).
- When you used a linked doc, end with: 🔗 <its title>. A doc you couldn't open: give its title as 🔗 <title> so they can open it.
- Plain text. No greetings, no bullet symbols, no headers, no bold.
- Never share phone numbers, emails, fines, dues or money owed, even if asked.
- If the person replied to a bot message, "this", "it" and "that event" mean the replied-to event(s).

THE HEADER LINE: when you open exactly one event with event_details, the bot prints "name · day time · place" above your answer by itself. Never repeat that name, day, time or place. If that line alone answers the question (only when/where), reply with exactly ${HEADER_ONLY}.

EXAMPLES (question -> your whole reply):
- "what room are mgc elections in?" -> room: reitz union 2335 · 🔗 mgc elections info
- "who else is going?" (replied to a retreat reminder) -> going: david, elias, james, charley, nader\nmaybe: eavin, bradley\nneed 3 more
- "when is the mgc retreat?" -> ${HEADER_ONLY}
- "when are song cuts due?" -> song cuts due wed 11/18
- "can someone be removed from e-board?" -> that's a bylaws question: ask the judicial chancellor
- "what's the weather tomorrow?" -> i only answer chapter questions`;

/**
 * Hard cap on Claude's text, whatever it wrote: at most `maxLines` lines and `maxChars` characters.
 * Cuts on a line boundary; only a single over-long first line is cut mid-line, at a space, never inside a link.
 */
export function capAnswer(text: string, maxLines = 3, maxChars = 300): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const kept: string[] = [];
  let used = 0;
  for (const l of lines) {
    if (kept.length >= maxLines) break;
    const add = l.length + (kept.length ? 1 : 0);
    if (used + add > maxChars) {
      if (kept.length) break;
      // One very long first line: cut at the last space before the limit that isn't inside a URL.
      let cut = l.lastIndexOf(' ', maxChars - 1);
      const url = /https?:\/\/\S*$/.exec(l.slice(0, cut > 0 ? cut : maxChars));
      if (url) cut = url.index - 1;
      kept.push(`${l.slice(0, cut > 0 ? cut : maxChars - 1).trimEnd()}…`);
      break;
    }
    kept.push(l);
    used += add;
  }
  return kept.join('\n');
}

/**
 * Which ONE event the answer is about, for the code-built header: the single event Claude opened with
 * event_details, or (if it opened none) the single event the question replied to. Several -> none.
 */
export function headerEventId(result: Pick<AskResult, 'detailIds'>, quotedEventIds: string[]): string | null {
  if (result.detailIds.length === 1) return result.detailIds[0];
  if (result.detailIds.length === 0 && quotedEventIds.length === 1) return quotedEventIds[0];
  return null;
}

/** Answer one question. Returns Claude's text (filtered + capped) and what it looked at; the caller adds the header + house style. */
export async function answer(question: string, ctx: AskContext, deps: AskDeps): Promise<AskResult> {
  const now = ctx.now ?? new Date();
  const facts = [
    `Now: ${now.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`,
    `Asked by: ${ctx.senderName ?? 'unknown (not in roster)'}`,
    ctx.quotedEventIds.length ? `They replied to a bot message about event id(s): ${ctx.quotedEventIds.join(', ')}` : 'Not a reply to a bot message.',
    `Minutes loaded from the meeting on: ${deps.store.latestSnapshot()?.meeting_date ?? 'unknown'}`,
  ].join('\n');

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: `${facts}\n\nQuestion: ${question}` }];
  const detailIds: string[] = [];
  const docsRead: string[] = [];
  const done = (raw: string): AskResult => {
    const t = raw.trim() === HEADER_ONLY ? '' : capAnswer(redact(raw));
    return { text: t, detailIds, docsRead };
  };

  for (let round = 0; round <= deps.maxRounds; round++) {
    const lastRound = round === deps.maxRounds;
    const res = await deps.client.messages.create({
      model: deps.model,
      max_tokens: 400,
      system: SYSTEM,
      tools: TOOL_DEFS,
      // Out of rounds: tools off, so Claude must answer with what it has.
      ...(lastRound ? { tool_choice: { type: 'none' as const } } : {}),
      messages,
    });

    const toolCalls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    deps.onStep?.({ type: 'model', round, stopReason: res.stop_reason, text, toolCalls: toolCalls.map((t) => ({ name: t.name, input: t.input })) });

    if (res.stop_reason !== 'tool_use' || !toolCalls.length) {
      return done(text || "Couldn't find an answer in the minutes.");
    }

    // Echo Claude's turn back, then answer every tool call in ONE user turn (the API requires this pairing).
    messages.push({ role: 'assistant', content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const t of toolCalls) {
      const input = (t.input ?? {}) as Record<string, unknown>;
      let output: string;
      try {
        output = await runTool(t.name, input, { ...ctx, now }, deps);
      } catch (e) {
        output = `Tool error: ${(e as Error).message}`;
      }
      if (t.name === 'event_details' && !/^No event/.test(output)) {
        const id = (JSON.parse(output) as { id?: string }).id;
        if (id && !detailIds.includes(id)) detailIds.push(id);
      }
      if (t.name === 'read_doc' && output.startsWith('Doc: ')) docsRead.push(String(input.url ?? ''));
      deps.onStep?.({ type: 'tool', name: t.name, input: t.input, output });
      // Docs are read whole (chapter docs are small); everything else stays short.
      results.push({ type: 'tool_result', tool_use_id: t.id, content: output.slice(0, t.name === 'read_doc' ? 62_000 : 6000) });
    }
    messages.push({ role: 'user', content: results });
  }
  return done("Couldn't find an answer in the minutes.");
}

/**
 * The message that gets posted: code-built header (one event) + Claude's text, plus the asker's tag and
 * question when the answer was moved from the alerts chat to the Q&A chat. Returns the text (before style())
 * and every event it's about, so a reply to the answer keeps context.
 */
export function composeReply(
  result: AskResult,
  o: { store: Store; quotedEventIds: string[]; now?: Date; asker?: { tag: string; question: string } | null },
): { text: string; eventIds: string[] } {
  const id = headerEventId(result, o.quotedEventIds);
  const row = id ? o.store.getEvent(id) : undefined;
  const header = row ? M.answerHeader(view(o.store, row), o.now) : null;
  const body = result.text || (header ? '' : "Couldn't find an answer in the minutes.");
  const reNames = o.quotedEventIds
    .map((q) => o.store.getEvent(q))
    .filter((r): r is NonNullable<typeof r> => !!r)
    .map((r) => r.short_title || r.title);
  const re = !header && o.asker && reNames.length ? reNames.join(', ') : null;
  return {
    text: M.askAnswer({ body, header, re, asker: o.asker ?? null }),
    eventIds: [...new Set([...o.quotedEventIds, ...result.detailIds])],
  };
}
