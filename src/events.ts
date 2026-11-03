import type { AttendeeRow, EventRow, Store } from './db.js';
import type { AttendeeStatus } from './extract.js';
import type { Glossary } from './glossary.js';

export interface EventView extends EventRow {
  /** Display name (short name, falls back to the minutes title). */
  name: string;
  attendees: AttendeeRow[];
  /** Local start (or noon on the date if no time given). */
  start: Date | null;
  hasTime: boolean;
  going: AttendeeRow[]; // confirmed + late
  tentative: AttendeeRow[];
  excused: AttendeeRow[];
  absent: AttendeeRow[];
}

/** Poll answers -> attendance status. Older polls used "Tentative". */
export const POLL_STATUS: Record<string, AttendeeStatus> = {
  Going: 'confirmed',
  Maybe: 'tentative',
  Tentative: 'tentative',
  "Can't": 'absent',
};

export function localDate(date: string, time?: string | null): Date {
  // TZ is pinned in config.ts, so this parses as chapter-local time.
  return new Date(`${date}T${time && /^\d{1,2}:\d{2}$/.test(time) ? time.padStart(5, '0') : '12:00'}:00`);
}

export function todayISO(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 86_400_000);
}

/**
 * Attendance = the minutes' list, overridden by poll votes.
 * A poll answer replaces that bro's status from the minutes; bros who vote but weren't listed are added.
 */
export function view(store: Store, e: EventRow): EventView {
  const rows = new Map<string, AttendeeRow>();
  for (const a of store.attendees(e.id)) rows.set(a.roster_name ?? a.raw_name, a);
  for (const v of store.eventVotes(e.id)) {
    const status = POLL_STATUS[v.option];
    if (!status || !v.voter_name) continue;
    rows.set(v.voter_name, { event_id: e.id, raw_name: v.voter_name, roster_name: v.voter_name, status, from_poll: true });
  }
  const attendees = [...rows.values()];
  return {
    ...e,
    name: e.short_title || e.title,
    attendees,
    start: e.date ? localDate(e.date, e.start_time) : null,
    hasTime: !!e.start_time,
    going: attendees.filter((a) => a.status === 'confirmed' || a.status === 'late'),
    tentative: attendees.filter((a) => a.status === 'tentative'),
    excused: attendees.filter((a) => a.status === 'excused'),
    absent: attendees.filter((a) => a.status === 'absent'),
  };
}

/** Events dated today through today+days (inclusive). Denied events are skipped; timed events drop 3h after start. */
export function upcoming(store: Store, days = 7, now = new Date()): EventView[] {
  return between(store, todayISO(now), todayISO(addDays(now, days)), now);
}

/** Events with dates in [from, to] (ISO, inclusive) that haven't already happened. */
export function between(store: Store, from: string, to: string, now = new Date()): EventView[] {
  return store
    .allEvents()
    .filter((e) => e.date && e.date >= from && e.date <= to && e.approved !== 0)
    .map((e) => view(store, e))
    .filter((v) => !v.hasTime || !v.start || v.start.getTime() > now.getTime() - 3 * 3_600_000);
}

export function shortfall(v: EventView): number {
  return v.required_count ? Math.max(0, v.required_count - v.going.length) : 0;
}

/**
 * Search by name. Matches in the short name count most, then the minutes title, then the section.
 * Org names are interchangeable ("theta nu xi" finds "TNX ..."). Upcoming events win ties, soonest first.
 */
export function findEvents(store: Store, query: string, glossary: Glossary, now = new Date()): EventView[] {
  const variants = glossary.expand(query).map((q) => q.split(/\s+/).filter(Boolean));
  if (!variants.some((w) => w.length)) return [];
  const today = todayISO(now);
  const score = (e: EventRow): number => {
    const short = (e.short_title ?? '').toLowerCase();
    const title = e.title.toLowerCase();
    const hay = `${short} ${title} ${e.section} ${e.date ?? ''}`.toLowerCase();
    let best = 0;
    for (const words of variants) {
      if (!words.every((w) => hay.includes(w))) continue;
      const s = words.reduce((acc, w) => acc + (short.includes(w) ? 3 : title.includes(w) ? 2 : 1), 0);
      best = Math.max(best, s);
    }
    return best;
  };
  const hits = store
    .allEvents()
    .map((e) => ({ e, s: score(e) }))
    .filter((x) => x.s > 0);
  hits.sort((a, b) => {
    const au = (a.e.date ?? '') >= today ? 0 : 1;
    const bu = (b.e.date ?? '') >= today ? 0 : 1;
    return au - bu || b.s - a.s || (a.e.date ?? '').localeCompare(b.e.date ?? '');
  });
  return hits.map((x) => view(store, x.e));
}
