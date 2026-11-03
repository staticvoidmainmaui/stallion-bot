import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AttendeeStatus, Extraction } from './extract.js';
import { eventId } from './extract.js';
import type { Roster } from './roster.js';
import type { Glossary } from './glossary.js';

export interface EventRow {
  id: string;
  title: string;
  short_title: string | null;
  section: string;
  owner: string | null;
  date: string | null;
  start_time: string | null;
  time_raw: string | null;
  location: string | null;
  approved: number | null;
  required_count: number | null;
  required_raw: string | null;
  open_slots: number;
  links_json: string;
  notes: string | null;
}

export interface AttendeeRow {
  event_id: string;
  raw_name: string;
  roster_name: string | null;
  status: AttendeeStatus;
  /** Set when this row comes from (or was overridden by) a poll vote. */
  from_poll?: boolean;
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
/** "Wednesdays, 8:30 PM" -> the next Wednesday (today counts). Null if no plural weekday is written. */
function nextWeekday(text: string, now = new Date()): string | null {
  const m = /\b(sun|mon|tues|wednes|thurs|fri|satur)days\b/i.exec(text);
  if (!m) return null;
  const target = WEEKDAYS.indexOf(m[1].toLowerCase().slice(0, 3));
  const d = new Date(now.getTime() + ((target - now.getDay() + 7) % 7) * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class Store {
  db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fetched_at TEXT NOT NULL,
        revision TEXT NOT NULL,
        meeting_date TEXT,
        raw_text TEXT NOT NULL,
        extraction_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        snapshot_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        section TEXT NOT NULL,
        owner TEXT,
        date TEXT,
        start_time TEXT,
        time_raw TEXT,
        location TEXT,
        approved INTEGER,
        required_count INTEGER,
        required_raw TEXT,
        open_slots INTEGER NOT NULL DEFAULT 0,
        links_json TEXT NOT NULL DEFAULT '[]',
        notes TEXT
      );
      CREATE TABLE IF NOT EXISTS attendees (
        event_id TEXT NOT NULL,
        raw_name TEXT NOT NULL,
        roster_name TEXT,
        status TEXT NOT NULL,
        PRIMARY KEY (event_id, raw_name)
      );
      CREATE TABLE IF NOT EXISTS polls (
        msg_id TEXT PRIMARY KEY,
        event_id TEXT,
        chat_jid TEXT NOT NULL,
        created_at TEXT NOT NULL,
        message_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS poll_votes (
        msg_id TEXT NOT NULL,
        voter_jid TEXT NOT NULL,
        option TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (msg_id, voter_jid)
      );
      CREATE TABLE IF NOT EXISTS reminders_sent (
        event_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (event_id, kind)
      );
      CREATE TABLE IF NOT EXISTS short_names (
        title_key TEXT PRIMARY KEY,
        short TEXT NOT NULL
      );
    `);
    // Columns added after v1 (existing databases get them on startup).
    const cols = (t: string) => (this.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols('events').includes('short_title')) this.db.exec('ALTER TABLE events ADD COLUMN short_title TEXT');
    if (!cols('poll_votes').includes('voter_name')) this.db.exec('ALTER TABLE poll_votes ADD COLUMN voter_name TEXT');
  }

  latestSnapshot(): { id: number; revision: string; meeting_date: string | null; extraction: Extraction } | undefined {
    const row = this.db
      .prepare('SELECT id, revision, meeting_date, extraction_json FROM snapshots ORDER BY id DESC LIMIT 1')
      .get() as { id: number; revision: string; meeting_date: string | null; extraction_json: string } | undefined;
    return row && { id: row.id, revision: row.revision, meeting_date: row.meeting_date, extraction: JSON.parse(row.extraction_json) };
  }

  /** Replace current events/attendees with a new extraction. Returns names that didn't match the roster. */
  saveSnapshot(revision: string, rawText: string, ex: Extraction, roster: Roster, glossary: Glossary): { unknown: string[]; events: number } {
    const snap = this.db
      .prepare('INSERT INTO snapshots (fetched_at, revision, meeting_date, raw_text, extraction_json) VALUES (?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), revision, ex.meetingDate, rawText, JSON.stringify(ex));
    return this.writeEvents(Number(snap.lastInsertRowid), ex, roster, glossary);
  }

  /** Rebuild events from the latest snapshot (no API call). Picks up glossary.json / roster.json edits on restart. */
  reapplyLatest(roster: Roster, glossary: Glossary): { unknown: string[]; events: number } | null {
    const last = this.latestSnapshot();
    return last ? this.writeEvents(last.id, last.extraction, roster, glossary) : null;
  }

  private writeEvents(snapshotId: number, ex: Extraction, roster: Roster, glossary: Glossary): { unknown: string[]; events: number } {
    const unknown = new Set<string>();
    const tx = this.db.transaction(() => {
      this.db.exec('DELETE FROM attendees; DELETE FROM events;');
      const insE = this.db.prepare(`INSERT OR REPLACE INTO events
        (id, snapshot_id, title, short_title, section, owner, date, start_time, time_raw, location, approved, required_count, required_raw, open_slots, links_json, notes)
        VALUES (@id, @snapshot_id, @title, @short_title, @section, @owner, @date, @start_time, @time_raw, @location, @approved, @required_count, @required_raw, @open_slots, @links_json, @notes)`);
      const getShort = this.db.prepare('SELECT short FROM short_names WHERE title_key = ?');
      const putShort = this.db.prepare('INSERT OR REPLACE INTO short_names (title_key, short) VALUES (?, ?)');
      const insA = this.db.prepare('INSERT OR REPLACE INTO attendees (event_id, raw_name, roster_name, status) VALUES (?, ?, ?, ?)');
      const seen = new Map<string, number>();
      // Short names are sticky: once an event has one, later weeks reuse it. glossary.json pins always win.
      const shortFor = (title: string, modelShort?: string | null): string => {
        const k = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const pin = glossary.pinned(title);
        const prev = (getShort.get(k) as { short: string } | undefined)?.short;
        // normalize() again so later glossary.json org edits still apply to remembered names.
        const short = glossary.normalize(pin ?? prev ?? glossary.shortName(title, modelShort));
        putShort.run(k, short);
        return short;
      };
      for (const e of ex.events) {
        let id = eventId(e);
        const n = (seen.get(id) ?? 0) + 1;
        seen.set(id, n);
        if (n > 1) id = `${id}-${n}`;
        insE.run({
          id,
          snapshot_id: snapshotId,
          title: e.title,
          short_title: shortFor(e.title, e.shortTitle),
          section: e.section,
          owner: e.owner,
          date: e.date ?? nextWeekday(`${e.timeRaw ?? ''} ${e.title} ${e.notes ?? ''}`),
          start_time: e.startTime,
          time_raw: e.timeRaw,
          location: e.location,
          approved: e.approved === null ? null : e.approved ? 1 : 0,
          required_count: e.requiredCount,
          required_raw: e.requiredRaw,
          open_slots: e.openSlots,
          links_json: JSON.stringify(e.links),
          notes: e.notes,
        });
        for (const a of e.attendees) {
          const r = roster.resolve(a.rawName);
          if (!r.entry) unknown.add(a.rawName);
          insA.run(id, a.rawName, r.entry?.name ?? null, a.status);
        }
      }
    });
    tx();
    return { unknown: [...unknown], events: ex.events.length };
  }

  allEvents(): EventRow[] {
    return this.db.prepare('SELECT * FROM events ORDER BY date, start_time').all() as EventRow[];
  }

  attendees(eventIdValue: string): AttendeeRow[] {
    return this.db.prepare('SELECT * FROM attendees WHERE event_id = ?').all(eventIdValue) as AttendeeRow[];
  }

  getEvent(id: string): EventRow | undefined {
    return this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined;
  }

  savePoll(msgId: string, eventIdValue: string | null, chatJid: string, messageJson: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO polls (msg_id, event_id, chat_jid, created_at, message_json) VALUES (?, ?, ?, ?, ?)')
      .run(msgId, eventIdValue, chatJid, new Date().toISOString(), messageJson);
  }

  getPoll(msgId: string): { msg_id: string; event_id: string | null; message_json: string } | undefined {
    return this.db.prepare('SELECT msg_id, event_id, message_json FROM polls WHERE msg_id = ?').get(msgId) as
      | { msg_id: string; event_id: string | null; message_json: string }
      | undefined;
  }

  latestPollForEvent(eventIdValue: string): string | undefined {
    const r = this.db
      .prepare('SELECT msg_id FROM polls WHERE event_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(eventIdValue) as { msg_id: string } | undefined;
    return r?.msg_id;
  }

  updatePollMessage(msgId: string, messageJson: string): void {
    this.db.prepare('UPDATE polls SET message_json = ? WHERE msg_id = ?').run(messageJson, msgId);
  }

  replaceVotes(msgId: string, votes: { voter: string; option: string; voterName?: string | null }[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM poll_votes WHERE msg_id = ?').run(msgId);
      const ins = this.db.prepare(
        'INSERT OR REPLACE INTO poll_votes (msg_id, voter_jid, option, updated_at, voter_name) VALUES (?, ?, ?, ?, ?)',
      );
      const now = new Date().toISOString();
      for (const v of votes) ins.run(msgId, v.voter, v.option, now, v.voterName ?? null);
    });
    tx();
  }

  votes(msgId: string): { voter_jid: string; option: string; voter_name: string | null }[] {
    return this.db.prepare('SELECT voter_jid, option, voter_name FROM poll_votes WHERE msg_id = ?').all(msgId) as {
      voter_jid: string;
      option: string;
      voter_name: string | null;
    }[];
  }

  /** Each voter's most recent answer across every poll for this event. */
  eventVotes(eventIdValue: string): { voter_jid: string; option: string; voter_name: string | null }[] {
    const rows = this.db
      .prepare(
        `SELECT v.voter_jid, v.option, v.voter_name FROM poll_votes v JOIN polls p ON p.msg_id = v.msg_id
         WHERE p.event_id = ? ORDER BY p.created_at ASC, v.updated_at ASC`,
      )
      .all(eventIdValue) as { voter_jid: string; option: string; voter_name: string | null }[];
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) latest.set(r.voter_name ?? r.voter_jid, r);
    return [...latest.values()];
  }

  reminderSent(eventIdValue: string, kind: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM reminders_sent WHERE event_id = ? AND kind = ?').get(eventIdValue, kind);
  }

  markReminder(eventIdValue: string, kind: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO reminders_sent (event_id, kind, sent_at) VALUES (?, ?, ?)')
      .run(eventIdValue, kind, new Date().toISOString());
  }
}
