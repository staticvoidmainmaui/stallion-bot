# [\*STALLION_BOT\*🎠] automatic posting schedule

Goal: 1-2 automatic posts a day, 3 at most, so nobody mutes the group. Times are chapter time (America/New_York). All of them are .env settings.

## The schedule

- **Monday ~9:00 PM: weekly digest with the UF Betas sticker.** After chapter, once the new minutes are in, so "this week" and "need bros" are current. It only posts once the loaded minutes are from that day's meeting. If they aren't yet, it re-checks every hour (at :05, after re-reading the minutes) and posts as soon as they are. If they never come in before quiet hours, it skips that week. (`WEEKLY_DIGEST_CRON=0 21 * * 1`)
- **8:00 PM every other night: one "Tomorrow" message.** Lists all of tomorrow's events and tags whoever's signed up, in one post. Replaces the old 9 AM digest and the separate 24-hour reminders, which could say the same thing twice and sent one message per event. People plan the night before, so this is the one that gets read. No post when nothing is on tomorrow. (`TOMORROW_CRON=0 20 * * 0,2-6`, every night except Monday)
- **1-2 hours before: "Starting soon".** Only for events with a sign-up list or a required headcount. Skipped for things like nominations, where it's just noise. Checked every 15 minutes (:00, :15, :30, :45). (`SOON_HOURS=2`)
- **Thursday ~6:00 PM: "Need bros" nudge.** For weekend and early-next-week events (Friday through Tuesday) that are short: one list, then a follow-up poll for each (up to 3). This is the automatic follow-up we'd left turned off. No post when nothing is short. (`NEED_BROS_CRON=0 18 * * 4`, `NEED_BROS_NUDGE=true`)
- **Quiet hours, 10:30 PM to 8:00 AM.** Nothing automatic posts overnight. "Starting soon" checks resume at 8:00. The 12:30 AM post on 11/3 is exactly what this prevents. (`QUIET_START=22:30`, `QUIET_END=08:00`)

## Behind the scenes

- Every hour at :05 the bot re-reads the minutes. It only calls Claude when the minutes file changed.
- Every automatic post goes out once. It's marked sent in the database, so restarts never repeat it.
- Missed times don't catch up. If the laptop is asleep at 8:00 PM, that night's "Tomorrow" post is skipped. Keep it awake, or host it somewhere always-on.
- Commands still work any time, quiet hours and pause included: !weekly, !digest, !remind (same as the 8 PM post), !short.

## Safety: what stops a spam night

- **Every automatic post goes out once.** It's marked sent before it posts, so a crash or restart can't repeat it. Worst case a post is missed, never doubled.
- **No catch-up.** Times missed while the bot was off or asleep are skipped, never sent late. Turning it on after 2 weeks sends nothing old.
- **Stale or wrong minutes pause everything automatic.** If the minutes' meeting date is over 9 days old, or in the future (a typo like 12/2 instead of 11/2), automatic posts hold. The terminal says why, and `!refresh` shows a ⚠️ line. A wrong year counts as too old. (`STALE_MINUTES_DAYS=9`)
- **Daily cap.** At most 8 automatic posts a day. Anything past that is held and logged. (`MAX_AUTO_POSTS_PER_DAY=8`)
- **Kill switch.** `!pause` stops all automatic posts right away, and it survives restarts. `!resume` turns them back on. Commands keep working either way. For a hard stop: `REMINDERS_ENABLED=false` in .env.
- **Dry run.** `AUTO_DRY_RUN=true` logs what would post (`[auto] dry run, would post "..."`) without sending. Use it after changing settings or loading new minutes.
- **One copy at a time.** A second `npm start` refuses to run while one is already going, since two copies fight over the login and could double-post.
- **Quiet hours** (10:30 PM to 8:00 AM) apply to everything automatic.
- The terminal prints `[auto] posting "..."` or `[auto] held "...": reason` for every automatic post, so you can always see what happened and why.

## A normal week

- Mon: 9 PM weekly digest (after chapter)
- Tue-Sun: 8 PM "Tomorrow" post when something's on the next day
- Thu: 6 PM need-bros nudge, only if something's short
- Any day: "Starting soon" 2 hours before an event people signed up for

## Not yet decided

- Monday 8 PM "Tomorrow" post: off, since chapter is in person and the 9 PM digest covers the week. Add Monday to TOMORROW_CRON (0 20 * * *) if Tuesday events need tags the night before.
- A held Monday digest is skipped if the minutes come in after 10:30 PM. Could post it Tuesday 8 AM instead.
