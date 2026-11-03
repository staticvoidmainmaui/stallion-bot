import { fetchMinutes } from './docs.js';
import { extractMinutes } from './extract.js';
import type { Store } from './db.js';
import type { Roster } from './roster.js';
import type { Glossary } from './glossary.js';

export interface RefreshResult {
  changed: boolean;
  events: number;
  unknown: string[];
  meetingDate: string | null;
}

/** Pull the minutes; only re-run the (paid) extraction when the doc revision changed or force=true. */
export async function refresh(store: Store, roster: Roster, glossary: Glossary, force = false): Promise<RefreshResult> {
  const src = await fetchMinutes();
  const last = store.latestSnapshot();
  if (!force && last && last.revision === src.revision) {
    store.reapplyLatest(roster, glossary); // free: keeps weekly items on their next date
    return { changed: false, events: store.allEvents().length, unknown: [], meetingDate: last.meeting_date };
  }
  const ex = await extractMinutes(src.text, new Date(), glossary.promptBlock());
  const { unknown, events } = store.saveSnapshot(src.revision, src.text, ex, roster, glossary);
  return { changed: true, events, unknown, meetingDate: ex.meetingDate };
}
