import cron from 'node-cron';
import { config } from './config.js';
import type { Store } from './db.js';
import { addDays, todayISO, upcoming } from './events.js';
import type { Bot } from './bot.js';

const HOUR = 3_600_000;

/** "22:30" -> minutes after midnight. */
const mins = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
};

/** Quiet hours (default 10:30 PM - 8:00 AM): nothing automatic posts. Handles windows that cross midnight. */
export function isQuiet(now = new Date()): boolean {
  const t = now.getHours() * 60 + now.getMinutes();
  const a = mins(config.quietStart);
  const b = mins(config.quietEnd);
  return a <= b ? t >= a && t < b : t >= a || t < b;
}

/** Why the loaded minutes shouldn't drive automatic posts right now, or null if they're fine. */
export function minutesProblem(store: Store, now = new Date()): string | null {
  const md = store.latestSnapshot()?.meeting_date;
  if (!md) return 'no minutes loaded';
  if (md > todayISO(now)) return `meeting date ${md} is in the future (check the DATE line in the minutes)`;
  if (md < todayISO(addDays(now, -config.staleMinutesDays)))
    return `minutes are from ${md}, over ${config.staleMinutesDays} days old (load this week's minutes)`;
  return null;
}

/**
 * Automatic posts (chapter time zone). Full write-up in SCHEDULE.md.
 * - WEEKLY_DIGEST_CRON (Mon 9 PM): sticker + this week + need bros, held until the minutes are from today.
 * - TOMORROW_CRON (8 PM, every night but Monday): one post with all of tomorrow's events + tags.
 * - every 15 min: "Starting soon" SOON_HOURS before events with a sign-up list or required headcount.
 * - NEED_BROS_CRON (Thu 6 PM): need-bros list + a follow-up poll per short event (Fri - next Tue).
 * - Quiet hours QUIET_START - QUIET_END: nothing posts; anything due waits.
 * - hourly :05: re-read the minutes (only calls Claude when the file changed).
 */
export function startReminders(store: Store, bot: Bot, refreshTick: () => Promise<void>): void {
  const tz = config.tz;
  const live = () => config.remindersEnabled && !!config.groupJid && !!bot.sock;
  const midnightIso = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  };

  /** Every automatic post passes these checks. Commands typed in the group don't. */
  const blocked = (): string | null => {
    if (!live()) return 'not connected or REMINDERS_ENABLED=false';
    if (isQuiet()) return 'quiet hours';
    if (store.getState('paused')) return 'paused (send !resume to turn back on)';
    const mp = minutesProblem(store);
    if (mp) return mp;
    if (store.autoPostsSince(midnightIso()) >= config.maxAutoPostsPerDay)
      return `daily limit of ${config.maxAutoPostsPerDay} automatic posts reached`;
    return null;
  };

  /**
   * Post once per (key, kind), only if nothing blocks it. Marked sent *before* posting, so a crash
   * mid-send can never cause a repeat (worst case a post is missed, never doubled).
   */
  const post = async (what: string, key: string, kind: string, send: () => Promise<unknown>): Promise<void> => {
    if (store.reminderSent(key, kind)) return;
    const why = blocked();
    if (why) return void console.log(`[auto] held "${what}": ${why}`);
    if (config.autoDryRun) return void console.log(`[auto] dry run, would post "${what}"`);
    store.markReminder(key, kind);
    console.log(`[auto] posting "${what}"`);
    await send();
  };

  // ---- Starting soon (every 15 min) ----
  const soonTick = async () => {
    const now = Date.now();
    for (const v of upcoming(store, 1)) {
      if (!v.hasTime || !v.start) continue;
      // Only events people signed up for or that need a headcount (skip e.g. nominations).
      if (!v.required_count && !v.attendees.length) continue;
      const until = v.start.getTime() - now;
      if (until <= 0 || until > config.soonHours * HOUR) continue;
      await post(`starting soon: ${v.name}`, v.id, '2h', () => bot.remindSoon(config.groupJid, v));
    }
  };
  cron.schedule('*/15 * * * *', soonTick, { timezone: tz });
  // Optional: also check 30s after startup, so a restart on :00/:15/:30/:45 can't skip one.
  // setTimeout(() => void soonTick().catch((e) => console.error('[reminders] startup check failed', e)), 30_000);

  // ---- Tomorrow (8 PM, every night but Monday) ----
  cron.schedule(
    config.tomorrowCron,
    async () => {
      await post('tomorrow', `tomorrow-${todayISO()}`, 'post', () => bot.postTomorrow(config.groupJid));
    },
    { timezone: tz },
  );

  // ---- Monday digest (9 PM, held until the new minutes are in) ----
  let weeklyPending = false;
  const tryWeekly = async (): Promise<void> => {
    if (!weeklyPending) return;
    if (!bot.minutesFromToday()) {
      console.log("[weekly] waiting: the minutes aren't from today's meeting yet");
      return;
    }
    weeklyPending = false;
    await post('weekly digest', `weekly-${todayISO()}`, 'post', () => bot.postWeekly(config.groupJid));
  };
  cron.schedule(
    config.weeklyDigestCron,
    async () => {
      weeklyPending = true;
      await tryWeekly();
    },
    { timezone: tz },
  );
  // Give up on a held digest at quiet hours (it would be stale by morning).
  cron.schedule(
    `${config.quietStart.split(':')[1] ?? '0'} ${config.quietStart.split(':')[0]} * * 1`,
    () => {
      if (weeklyPending) console.log('[weekly] skipped: new minutes never came in Monday night');
      weeklyPending = false;
    },
    { timezone: tz },
  );

  // ---- Thursday need-bros nudge (6 PM) ----
  cron.schedule(
    config.needBrosCron,
    async () => {
      if (!config.needBrosNudge) return;
      await post('need-bros nudge', `needbros-${todayISO()}`, 'post', () => bot.postNeedBrosNudge(config.groupJid));
    },
    { timezone: tz },
  );

  // ---- Hourly: re-read the minutes; if a held Monday digest was waiting on them, post it now ----
  cron.schedule(
    '5 * * * *',
    async () => {
      await refreshTick();
      await tryWeekly();
    },
    { timezone: tz },
  );
}
