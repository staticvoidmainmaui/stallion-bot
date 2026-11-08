import cron from 'node-cron';
import { config } from './config.js';
import type { Store } from './db.js';
import { todayISO, upcoming } from './events.js';
import type { Bot } from './bot.js';

const HOUR = 3_600_000;

/**
 * Automatic posts (chapter time zone). Full write-up in SCHEDULE.md.
 * - WEEKLY_DIGEST_CRON (Mon 9 PM): sticker + this week + need bros, held until the minutes are from today.
 * - TOMORROW_CRON (8 PM, every night but Monday): one post with all of tomorrow's events + tags.
 * - every 15 min: "Starting soon" SOON_HOURS before events with a sign-up list or required headcount.
 * - NEED_BROS_CRON (Thu 6 PM): need-bros list + a follow-up poll per short event (Fri - next Tue).
 * - hourly :05: re-read the minutes (only calls Claude when the file changed).
 */
export function startReminders(store: Store, bot: Bot, refreshTick: () => Promise<void>): void {
  const tz = config.tz;
  const live = () => config.remindersEnabled && !!config.groupJid && !!bot.sock;
  const once = (key: string, kind: string) => {
    if (store.reminderSent(key, kind)) return false;
    store.markReminder(key, kind);
    return true;
  };

  // ---- Starting soon (every 15 min) ----
  const soonTick = async () => {
    if (!live()) return;
    const now = Date.now();
    for (const v of upcoming(store, 1)) {
      if (!v.hasTime || !v.start) continue;
      // Only events people signed up for or that need a headcount (skip e.g. nominations).
      if (!v.required_count && !v.attendees.length) continue;
      const until = v.start.getTime() - now;
      if (until <= 0 || until > config.soonHours * HOUR) continue;
      if (!once(v.id, '2h')) continue;
      await bot.remindSoon(config.groupJid, v);
    }
  };
  cron.schedule('*/15 * * * *', soonTick, { timezone: tz });
  // Optional: also check 30s after startup, so a restart on :00/:15/:30/:45 can't skip one.
  // setTimeout(() => void soonTick().catch((e) => console.error('[reminders] startup check failed', e)), 30_000);

  // ---- Tomorrow (8 PM, every night but Monday) ----
  cron.schedule(
    config.tomorrowCron,
    async () => {
      if (!live()) return;
      if (!once(`tomorrow-${todayISO()}`, 'post')) return;
      await bot.postTomorrow(config.groupJid);
    },
    { timezone: tz },
  );

  // ---- Monday digest (9 PM, held until the new minutes are in) ----
  let weeklyPending = false;
  const tryWeekly = async (): Promise<void> => {
    if (!weeklyPending || !live()) return;
    if (!bot.minutesFromToday()) {
      console.log("[weekly] waiting: the minutes aren't from today's meeting yet");
      return;
    }
    weeklyPending = false;
    if (!once(`weekly-${todayISO()}`, 'post')) return;
    await bot.postWeekly(config.groupJid);
  };
  cron.schedule(
    config.weeklyDigestCron,
    async () => {
      weeklyPending = true;
      await tryWeekly();
    },
    { timezone: tz },
  );
  // ---- Thursday need-bros nudge (6 PM) ----
  cron.schedule(
    config.needBrosCron,
    async () => {
      if (!config.needBrosNudge || !live()) return;
      if (!once(`needbros-${todayISO()}`, 'post')) return;
      await bot.postNeedBrosNudge(config.groupJid);
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
