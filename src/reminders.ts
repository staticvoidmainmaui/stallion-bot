import cron from 'node-cron';
import { config } from './config.js';
import type { Store } from './db.js';
import { addDays, localDate, shortfall, todayISO, upcoming } from './events.js';
import type { Bot } from './bot.js';

const HOUR = 3_600_000;

/**
 * Schedules (chapter time zone):
 * - every 15 min: "Tomorrow" reminder (24h before timed events; EVENING_REMINDER_HOUR the night before
 *   date-only events) and "Starting soon" (2h before timed events). Each is sent once per event.
 * - optional auto follow-up poll ~2 days out for events that are short or have unanswered maybes.
 * - DAILY_DIGEST_CRON (default 9am Tue-Sun): today + tomorrow.
 * - WEEKLY_DIGEST_CRON (default noon Monday): UF Betas sticker + chapter tonight + the week.
 * - hourly: re-read the minutes (extraction only re-runs when the doc changed).
 */
export function startReminders(store: Store, bot: Bot, refreshTick: () => Promise<void>): void {
  const tz = config.tz;
  const live = () => config.remindersEnabled && !!config.groupJid && !!bot.sock;

  const reminderTick = async () => {
      if (!live()) return;
      const now = new Date();
      for (const v of upcoming(store, 3, now)) {
        const start = v.hasTime && v.start ? v.start.getTime() : null;

        // "Starting soon" (timed events only).
        if (start && start > now.getTime() && start - now.getTime() <= 2 * HOUR && !store.reminderSent(v.id, '2h')) {
          store.markReminder(v.id, '2h');
          store.markReminder(v.id, '24h'); // too late for "tomorrow"
          await bot.remindSoon(config.groupJid, v);
          continue;
        }

        // "Tomorrow": timed events 2-24h out; date-only events from EVENING_REMINDER_HOUR the night before.
        const tomorrowWindow = start
          ? start - now.getTime() <= 24 * HOUR && start > now.getTime()
          : v.date === todayISO(addDays(now, 1)) && now.getHours() >= config.eveningReminderHour;
        if (tomorrowWindow && !store.reminderSent(v.id, '24h')) {
          store.markReminder(v.id, '24h');
          await bot.remindTomorrow(config.groupJid, v);
          continue;
        }

        // Auto follow-up poll, ~2 days out (36-60h), once per event.
        if (config.autoFollowup && v.date && !store.reminderSent(v.id, 'followup')) {
          const t = (start ?? localDate(v.date).getTime()) - now.getTime();
          const needsChasing = shortfall(v) > 0 || [...v.tentative, ...v.excused].some((a) => !a.from_poll);
          if (t > 36 * HOUR && t <= 60 * HOUR && needsChasing) {
            store.markReminder(v.id, 'followup');
            await bot.followupPoll(config.groupJid, v);
          }
        }
      }
  };
  cron.schedule('*/15 * * * *', reminderTick, { timezone: tz });
  // Also check shortly after startup, so a restart right on :00/:15/:30/:45 can't skip a reminder.
  // Off for now (testing the :00/:15/:30/:45 schedule on its own). Uncomment to re-enable.
  // setTimeout(() => void reminderTick().catch((e) => console.error('[reminders] startup check failed', e)), 30_000);

  cron.schedule(
    config.dailyDigestCron,
    async () => {
      if (!live()) return;
      const key = `daily-${todayISO()}`;
      if (store.reminderSent(key, 'digest')) return;
      store.markReminder(key, 'digest');
      await bot.postDigest(config.groupJid, 2);
    },
    { timezone: tz },
  );

  cron.schedule(
    config.weeklyDigestCron,
    async () => {
      if (!live()) return;
      const key = `weekly-${todayISO()}`;
      if (store.reminderSent(key, 'digest')) return;
      store.markReminder(key, 'digest');
      await bot.postWeekly(config.groupJid);
    },
    { timezone: tz },
  );

  // Hourly: re-read the doc; extraction only re-runs if the doc revision changed.
  cron.schedule('5 * * * *', () => void refreshTick(), { timezone: tz });
}
