import makeWASocket, {
  Browsers,
  BufferJSON,
  DisconnectReason,
  fetchLatestBaileysVersion,
  getAggregateVotesInPollMessage,
  isJidGroup,
  jidNormalizedUser,
  normalizeMessageContent,
  updateMessageWithPollUpdate,
  useMultiFileAuthState,
  type AnyMessageContent,
  type GroupMetadata,
  type WAMessage,
  type WASocket,
} from 'baileys';
import type { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { config } from './config.js';
import type { Store } from './db.js';
import { existsSync, readFileSync } from 'node:fs';
import { addDays, between, findEvents, POLL_STATUS, shortfall, todayISO, upcoming, type EventView } from './events.js';
import type { Glossary } from './glossary.js';
import * as M from './messages.js';
import type { RefreshResult } from './refresh.js';
import type { Roster } from './roster.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const digits = (jid: string | null | undefined) => (jid ?? '').split('@')[0].split(':')[0].replace(/\D/g, '');

/** Commands allowed when BOT_MODE=digest (demo). */
const DIGEST_MODE_COMMANDS = new Set(['help', 'digest', 'weekly', 'remind', 'groupid', 'refresh']);

export interface Mention {
  tag: string;
  jid: string | null;
}

export class Bot {
  sock: WASocket | null = null;
  private sendChain: Promise<unknown> = Promise.resolve();
  private meta: GroupMetadata | null = null;
  /** phone digits -> participant id as the group addresses it (pn or lid) */
  private phoneToId = new Map<string, string>();
  /** participant id (lid or pn) -> phone digits */
  private idToPhone = new Map<string, string>();
  /** ids of messages the bot itself sent, so its own replies are never read back as commands */
  private sentIds = new Set<string>();

  constructor(
    private store: Store,
    private roster: Roster,
    private glossary: Glossary,
    private doRefresh: (force: boolean) => Promise<RefreshResult>,
  ) {}

  // ---------- connection ----------

  async start(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
    let version: [number, number, number] | undefined;
    try {
      version = (await fetchLatestBaileysVersion()).version;
    } catch {
      /* fall back to the library default */
    }
    const sock = makeWASocket({
      auth: state,
      version,
      logger: pino({ level: 'warn' }),
      browser: Browsers.ubuntu('Stallion Bot'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      // Needed so Baileys can decrypt votes on polls we sent.
      getMessage: async (key) => {
        const p = key.id ? this.store.getPoll(key.id) : undefined;
        return p ? (JSON.parse(p.message_json, BufferJSON.reviver) as WAMessage).message ?? undefined : undefined;
      },
      cachedGroupMetadata: async (jid) => (this.meta && this.meta.id === jid ? this.meta : undefined),
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      if (u.qr) {
        console.log('\nScan this QR from the BOT phone: WhatsApp > Linked devices > Link a device\n');
        qrcode.generate(u.qr, { small: true });
      }
      if (u.connection === 'open') {
        console.log('[wa] connected as', sock.user?.id);
        await this.loadGroup().catch((e) => console.warn('[wa] group metadata failed:', e?.message));
      }
      if (u.connection === 'close') {
        const code = (u.lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          console.error(`[wa] logged out. Delete the ${config.authDir}/ folder and restart to re-link.`);
          return;
        }
        console.warn('[wa] connection closed (code', code, ') — reconnecting in 3s');
        await sleep(3000);
        this.start().catch((e) => console.error('[wa] reconnect failed', e));
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const m of messages) {
        // Live messages arrive as 'notify'. Your own messages typed on the phone can arrive as 'append':
        // accept those only if they're fresh (last 2 min), never old history.
        if (type !== 'notify') {
          const ts = Number(m.messageTimestamp ?? 0) * 1000;
          if (!m.key.fromMe || !ts || Date.now() - ts > 120_000) continue;
        }
        try {
          await this.onMessage(m);
        } catch (e) {
          console.error('[bot] command error', e);
        }
      }
    });

    sock.ev.on('messages.update', async (updates) => {
      for (const { key, update } of updates) {
        if (!update.pollUpdates?.length || !key.id) continue;
        try {
          this.recordPollUpdates(key.id, update.pollUpdates);
        } catch (e) {
          console.error('[poll] failed to record votes', e);
        }
      }
    });

    sock.ev.on('groups.update', () => void this.loadGroup().catch(() => {}));
    sock.ev.on('group-participants.update', () => void this.loadGroup().catch(() => {}));
  }

  async loadGroup(): Promise<void> {
    if (!config.groupJid || !this.sock) return;
    this.meta = await this.sock.groupMetadata(config.groupJid);
    this.phoneToId.clear();
    this.idToPhone.clear();
    for (const p of this.meta.participants) {
      const phone = digits(p.phoneNumber) || (p.id.endsWith('@s.whatsapp.net') ? digits(p.id) : '');
      if (!phone) continue;
      this.phoneToId.set(phone, p.id);
      this.idToPhone.set(p.id, phone);
      if (p.lid) this.idToPhone.set(p.lid, phone);
    }
    console.log(`[wa] group "${this.meta.subject}": ${this.meta.participants.length} members, ${this.phoneToId.size} with phone numbers`);
  }

  // ---------- sending ----------

  /** All outgoing messages go through one queue with a minimum gap (keeps volume human-like). */
  send(jid: string, content: AnyMessageContent): Promise<WAMessage | undefined> {
    const run = this.sendChain.then(async () => {
      if (!this.sock) throw new Error('not connected');
      const r = await this.sock.sendMessage(jid, content);
      if (r?.key.id) {
        this.sentIds.add(r.key.id);
        if (this.sentIds.size > 500) this.sentIds.delete(this.sentIds.values().next().value as string);
      }
      await sleep(config.sendGapMs);
      return r;
    });
    this.sendChain = run.catch(() => {});
    return run;
  }

  reply(jid: string, text: string, mentions: string[] = []): Promise<WAMessage | undefined> {
    return this.send(jid, { text: M.style(text), mentions });
  }

  mention(rosterName: string | null, rawName: string): Mention {
    const entry = rosterName ? this.roster.byName(rosterName) : undefined;
    if (!entry) return { tag: rawName, jid: null };
    // Only tag bros who are actually in the group; anyone else (or a placeholder number) shows as a plain name.
    const jid = entry.jid || (entry.phone && this.phoneToId.get(entry.phone)) || null;
    if (!jid) return { tag: entry.name, jid: null };
    return { tag: `@${jid.split('@')[0]}`, jid };
  }

  mentionList(rows: { roster_name: string | null; raw_name: string }[]): { text: string; jids: string[] } {
    const ms = rows.map((r) => this.mention(r.roster_name, r.raw_name));
    return { text: ms.map((m) => m.tag).join(' '), jids: ms.flatMap((m) => (m.jid ? [m.jid] : [])) };
  }

  // ---------- incoming ----------

  private senderPhone(m: WAMessage): string {
    const k = m.key;
    const alt = k.participantAlt || k.remoteJidAlt;
    if (alt && alt.endsWith('@s.whatsapp.net')) return digits(alt);
    const who = k.participant || k.remoteJid || '';
    if (who.endsWith('@s.whatsapp.net')) return digits(who);
    return this.idToPhone.get(who) ?? '';
  }

  private isExec(m: WAMessage): boolean {
    // Typed by whoever owns the bot's WhatsApp account (e.g. testing on your own number).
    if (m.key.fromMe) return true;
    const phone = this.senderPhone(m);
    return !!phone && (config.execNumbers.includes(phone) || this.roster.isExec(phone));
  }

  private async onMessage(m: WAMessage): Promise<void> {
    // Own-account messages count as commands (lets you test on your personal number),
    // but never the bot's own replies.
    if (m.key.fromMe && (!m.key.id || this.sentIds.has(m.key.id))) return;
    const chat = m.key.remoteJid;
    if (!chat) return;
    // Unwrap disappearing / view-once / edited wrappers before reading the text.
    const content = normalizeMessageContent(m.message);
    const text = (content?.conversation || content?.extendedTextMessage?.text || '').trim();
    if (!text.startsWith('!')) return;
    console.log(`[cmd] ${text.split(/\s+/)[0]} in ${chat}${m.key.fromMe ? ' (you)' : ''}${chat === config.groupJid ? '' : ' (not the configured group)'}`);
    const [rawCmd, ...rest] = text.slice(1).split(/\s+/);
    const cmd = rawCmd.toLowerCase();
    const arg = rest.join(' ').trim();

    // Setup helper: works in any chat so you can find the group's ID.
    if (cmd === 'groupid') return void (await this.reply(chat, M.groupId(chat)));
    if (!config.groupJid || chat !== config.groupJid || !isJidGroup(chat)) return;
    // Demo mode: everything outside the digest/reminder set stays silent.
    if (config.botMode === 'digest' && !DIGEST_MODE_COMMANDS.has(cmd)) return;

    const exec = this.isExec(m);
    const execOnly = () => this.reply(chat, M.execOnly());

    switch (cmd) {
      case 'help':
        return void (await this.reply(chat, M.help(config.botMode)));
      case 'events':
        return void (await this.reply(chat, M.events(upcoming(this.store, Number(arg) || 7), Number(arg) || 7)));
      case 'event':
        return void (await this.cmdEvent(chat, arg));
      case 'short':
        return void (await this.reply(chat, M.short(this.needBros(21))));
      case 'tag':
        return void (exec ? await this.cmdTag(chat, arg) : await execOnly());
      case 'followup':
        return void (exec ? await this.cmdFollowup(chat, arg) : await execOnly());
      case 'poll':
        return void (await this.cmdPoll(chat, arg));
      case 'votes':
        return void (await this.cmdVotes(chat, arg));
      case 'goals':
        return void (exec ? await this.cmdGoals(chat) : await execOnly());
      case 'summary':
        return void (await this.cmdSummary(chat));
      case 'digest':
        return void (exec ? await this.postDigest(chat, Number(arg) || 2, true) : await execOnly());
      case 'weekly':
        return void (exec ? await this.postWeekly(chat) : await execOnly());
      case 'remind':
        return void (exec ? await this.postTomorrowReminders(chat, true) : await execOnly());
      case 'refresh':
        return void (exec ? await this.cmdRefresh(chat) : await execOnly());
      case 'members':
        return void (exec ? await this.cmdMembers(chat) : await execOnly());
      default:
        return;
    }
  }

  // ---------- shared lookups ----------

  private async pickOne(chat: string, query: string): Promise<EventView | null> {
    if (!query) {
      await this.reply(chat, M.askWhich());
      return null;
    }
    const hits = findEvents(this.store, query, this.glossary);
    if (!hits.length) {
      await this.reply(chat, M.noMatch(query));
      return null;
    }
    return hits[0];
  }

  /** Upcoming events (next `days`) that are under their required headcount. */
  needBros(days: number): EventView[] {
    return upcoming(this.store, days).filter((v) => shortfall(v) > 0);
  }

  /** Bros listed as maybe/excused in the minutes who haven't answered a poll yet. */
  private unanswered(v: EventView) {
    return [...v.tentative, ...v.excused].filter((a) => !a.from_poll);
  }

  // ---------- commands ----------

  async cmdEvent(chat: string, query: string): Promise<void> {
    const v = await this.pickOne(chat, query);
    if (v) await this.reply(chat, M.eventDetail(v));
  }

  async cmdTag(chat: string, query: string): Promise<void> {
    const v = await this.pickOne(chat, query);
    if (!v) return;
    const rows = [...v.going, ...v.tentative];
    if (!rows.length) return void (await this.reply(chat, M.nobodySignedUp(v)));
    const m = this.mentionList(rows);
    await this.reply(chat, M.tag(v, m.text), m.jids);
  }

  /** Follow-up = tag the maybes/excused, then post a poll so answers land in the database. */
  async followupPoll(chat: string, v: EventView): Promise<void> {
    const m = this.mentionList(this.unanswered(v));
    await this.reply(chat, M.followup(v, m.text), m.jids);
    await this.sendPoll(chat, v);
  }

  async cmdFollowup(chat: string, query: string): Promise<void> {
    if (query) {
      const v = await this.pickOne(chat, query);
      if (v) await this.followupPoll(chat, v);
      return;
    }
    // No name: every event this week with unanswered maybes/excused or a shortfall (max 3, to keep the chat calm).
    const targets = upcoming(this.store, 7)
      .filter((v) => this.unanswered(v).length || shortfall(v) > 0)
      .slice(0, 3);
    if (!targets.length) return void (await this.reply(chat, M.nobodyToFollowUp()));
    for (const v of targets) await this.followupPoll(chat, v);
  }

  private async sendPoll(chat: string, v: EventView): Promise<void> {
    const sent = await this.send(chat, {
      poll: { name: M.style(M.pollTitle(v), { mono: false }), values: M.POLL_OPTIONS, selectableCount: 1 },
    });
    if (sent?.key.id) this.store.savePoll(sent.key.id, v.id, chat, JSON.stringify(sent, BufferJSON.replacer));
  }

  async cmdPoll(chat: string, query: string): Promise<void> {
    const v = await this.pickOne(chat, query);
    if (v) await this.sendPoll(chat, v);
  }

  private recordPollUpdates(msgId: string, updates: NonNullable<WAMessage['pollUpdates']>): void {
    const p = this.store.getPoll(msgId);
    if (!p) return;
    const stored = JSON.parse(p.message_json, BufferJSON.reviver) as WAMessage;
    for (const u of updates) updateMessageWithPollUpdate(stored, u);
    this.store.updatePollMessage(msgId, JSON.stringify(stored, BufferJSON.replacer));
    const meId = this.sock?.user?.id ? jidNormalizedUser(this.sock.user.id) : undefined;
    const agg = getAggregateVotesInPollMessage({ message: stored.message, pollUpdates: stored.pollUpdates }, meId);
    this.store.replaceVotes(
      msgId,
      agg.flatMap((o) => o.voters.map((voter) => ({ voter, option: o.name, voterName: this.rosterNameFor(voter) }))),
    );
  }

  private rosterNameFor(jid: string): string | null {
    const phone = jid.endsWith('@s.whatsapp.net') ? digits(jid) : this.idToPhone.get(jid);
    const e = phone ? this.roster.entries.find((r) => r.phone === phone) : undefined;
    return e?.name ?? null;
  }

  async cmdVotes(chat: string, query: string): Promise<void> {
    const v = await this.pickOne(chat, query);
    if (!v) return;
    const msgId = this.store.latestPollForEvent(v.id);
    if (!msgId) return void (await this.reply(chat, M.noPoll(v, query)));
    const votes = this.store.votes(msgId);
    const rows = M.POLL_OPTIONS.map((opt) => ({
      option: opt,
      who: votes
        .filter((x) => POLL_STATUS[x.option] === POLL_STATUS[opt] && x.voter_name)
        .map((x) => x.voter_name as string),
    }));
    await this.reply(chat, M.votes(v, rows, votes.filter((x) => !x.voter_name).length));
  }

  /** One line per director, goals merged across their sections. */
  async cmdGoals(chat: string): Promise<void> {
    const snap = this.store.latestSnapshot();
    const blocks = snap?.extraction.directorGoals.filter((g) => g.goals.length) ?? [];
    const goal = (g: string) => g.trim().replace(/\.$/, '');
    const byPerson = new Map<string, string[]>();
    for (const b of blocks) {
      for (const o of b.owners) {
        const name = this.roster.resolve(o).entry?.name ?? o;
        const list = byPerson.get(name) ?? [];
        for (const g of b.goals.map(goal)) if (!list.includes(g)) list.push(g);
        byPerson.set(name, list);
      }
    }
    const jids: string[] = [];
    const rows = [...byPerson.entries()].map(([name, goals]) => {
      const m = this.mention(name, name);
      if (m.jid) jids.push(m.jid);
      return { tag: m.tag, goals };
    });
    await this.reply(chat, M.goals(rows), jids);
  }

  /** Recap: who we need bros for, then the minutes' takeaways that are still ahead of us (max 5). */
  async cmdSummary(chat: string): Promise<void> {
    const snap = this.store.latestSnapshot();
    if (!snap) return void (await this.reply(chat, M.noMinutes()));
    const today = todayISO();
    const year = (snap.meeting_date ?? today).slice(0, 4);
    const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const iso = (m: number, d: number) => `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const staleMeeting = !!snap.meeting_date && snap.meeting_date < todayISO(addDays(new Date(), -6));
    const needBros = this.needBros(21);
    const stillAhead = (i: { text: string; date?: string | null }) => {
      if (i.date) return i.date >= today;
      // Older extractions have no date: read "11/2" and "Nov 1" style dates out of the text.
      const ds = [
        ...[...i.text.matchAll(/\b(\d{1,2})\/(\d{1,2})\b/g)].map((x) => iso(+x[1], +x[2])),
        ...[...i.text.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/gi)].map((x) =>
          iso(MONTHS.indexOf(x[1].toLowerCase().slice(0, 3)) + 1, +x[2]),
        ),
      ];
      if (ds.length) return ds.some((d) => d >= today);
      // "tonight" / "this Wednesday" only made sense the week of the meeting.
      return !(staleMeeting && /\b(tonight|tomorrow|this (week|mon|tue|wed|thu|fri|sat|sun)\w*)\b/i.test(i.text));
    };
    // The need-bros line already covers these events.
    const covered = (t: string) => needBros.some((v) => t.toLowerCase().includes(v.name.toLowerCase()) || t.includes(v.title));
    const rank = { high: 0, med: 1, low: 2 } as const;
    const items = snap.extraction.summaryItems
      .filter((i) => i.importance !== 'low' && stillAhead(i) && !covered(i.text))
      .sort((a, b) => rank[a.importance] - rank[b.importance])
      .slice(0, 5);
    await this.reply(chat, M.summary(snap.meeting_date, needBros, items));
  }

  // ---------- digests & reminders (also called by the scheduler) ----------

  /** Next `days` days. After 6pm "today" is over, so the window starts tomorrow (good for a post-chapter run). */
  async postDigest(chat: string, days = 2, manual = false): Promise<boolean> {
    const now = new Date();
    const start = now.getHours() >= 18 ? addDays(now, 1) : now;
    const evs = between(this.store, todayISO(start), todayISO(addDays(start, days - 1)), now);
    const text = M.digest(evs, now);
    if (!text) {
      if (manual) await this.reply(chat, M.events([], days));
      return false;
    }
    await this.reply(chat, text);
    return true;
  }

  /** Monday digest: UF Betas sticker, then chapter tonight + this week + who we need. */
  async postWeekly(chat: string): Promise<void> {
    const sticker = config.digestSticker;
    if (sticker && existsSync(sticker)) await this.send(chat, { sticker: readFileSync(sticker) });
    const now = new Date();
    // Today (whatever hasn't happened yet) through the next 6 days.
    const evs = between(this.store, todayISO(now), todayISO(addDays(now, 6)), now);
    await this.reply(chat, M.weekly(evs, this.needBros(21), config.chapterTime, config.chapterLocation, now));
  }

  /** "Tomorrow" reminder for one event, tagging everyone going or maybe. */
  async remindTomorrow(chat: string, v: EventView): Promise<void> {
    const m = this.mentionList([...v.going, ...v.tentative]);
    await this.reply(chat, M.reminderTomorrow(v, m.text), m.jids);
  }

  async remindSoon(chat: string, v: EventView): Promise<void> {
    const m = this.mentionList([...v.going, ...v.tentative]);
    await this.reply(chat, M.reminderSoon(v, m.text), m.jids);
  }

  /** !remind: send tomorrow's reminders right now (marks them sent so the scheduler doesn't repeat them). */
  async postTomorrowReminders(chat: string, manual = false): Promise<void> {
    const tmrw = todayISO(addDays(new Date(), 1));
    const evs = between(this.store, tmrw, tmrw);
    if (!evs.length) {
      if (manual) await this.reply(chat, M.digest([]) ?? `${M.SIG} Nothing on the calendar tomorrow.`);
      return;
    }
    for (const v of evs) {
      this.store.markReminder(v.id, '24h');
      await this.remindTomorrow(chat, v);
    }
  }

  async cmdRefresh(chat: string): Promise<void> {
    await this.reply(chat, M.refreshing());
    try {
      const r = await this.doRefresh(true);
      await this.reply(chat, M.refreshed(r.events, r.meetingDate, r.unknown));
    } catch (e) {
      await this.reply(chat, M.refreshFailed((e as Error).message));
    }
  }

  async cmdMembers(chat: string): Promise<void> {
    await this.loadGroup();
    // Phone numbers stay out of the group chat: print to the server console only.
    console.log('\n[members] id | phoneNumber | lid | admin');
    for (const p of this.meta?.participants ?? []) {
      console.log(`${p.id} | ${p.phoneNumber ?? ''} | ${p.lid ?? ''} | ${p.admin ?? ''}`);
    }
    await this.reply(chat, M.membersPrinted(this.meta?.participants.length ?? 0));
  }
}
