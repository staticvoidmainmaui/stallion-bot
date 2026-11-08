import 'dotenv/config';

// Everything in the bot runs on chapter time. Set before any Date math happens.
process.env.TZ = process.env.TZ || 'America/New_York';

function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.replace(/\D/g, ''))
    .filter(Boolean);
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  model: process.env.MODEL || 'claude-haiku-5-5',

  /** Path to the Google service-account JSON key. */
  googleCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '',
  /** The ID in the minutes doc URL: docs.google.com/document/d/<ID>/edit */
  minutesDocId: process.env.MINUTES_DOC_ID ?? '',
  /** Offline/testing fallback: read minutes from a text file instead of Google Docs. */
  minutesTextFile: process.env.MINUTES_TEXT_FILE ?? '',

  /** e.g. 120363000000000000@g.us — get it with !groupid. Empty = bot only answers !groupid. */
  groupJid: process.env.CHAPTER_GROUP_JID ?? '',
  /** Phone numbers (digits, country code first) allowed to run mass-tag commands. */
  execNumbers: list(process.env.EXEC_NUMBERS),

  tz: process.env.TZ,
  rosterPath: process.env.ROSTER_PATH || 'roster.json',
  dbPath: process.env.DB_PATH || 'data/stallion.db',
  authDir: process.env.AUTH_DIR || 'auth',

  remindersEnabled: bool(process.env.REMINDERS_ENABLED, true),
  /** all = every command; digest = only the digest/reminder commands (demo mode). */
  botMode: (process.env.BOT_MODE || 'all').toLowerCase() as 'all' | 'digest',
  glossaryPath: process.env.GLOSSARY_PATH || 'glossary.json',

  /** Chapter meeting line for the Monday digest. */
  chapterTime: process.env.CHAPTER_TIME || '18:30',
  chapterLocation: process.env.CHAPTER_LOCATION || 'McCarty B G108',
  /** 512x512 WebP sent before the Monday digest. Empty = no sticker. */
  digestSticker: process.env.DIGEST_STICKER ?? 'assets/ufbetas-summary-sticker.webp',
  /** 512x512 WebP (Stallion's face) sent right before every automated post. Empty = none. */
  botSticker: process.env.BOT_STICKER ?? 'assets/stallion-sticker.webp',
  /** Automatic posting schedule (chapter time zone). See SCHEDULE.md. */
  /** Monday night, after chapter: sticker + this week + need bros (only once the new minutes are in). */
  weeklyDigestCron: process.env.WEEKLY_DIGEST_CRON || '0 21 * * 1',
  /** Every other night: one "Tomorrow" post with all of tomorrow's events + tags. */
  tomorrowCron: process.env.TOMORROW_CRON || '0 20 * * 0,2-6',
  /** "Starting soon" this many hours before events with a sign-up list or required headcount. */
  soonHours: Number(process.env.SOON_HOURS || 2),
  /** Thursday evening: need-bros nudge + follow-up polls for short weekend / early-next-week events. */
  needBrosCron: process.env.NEED_BROS_CRON || '0 18 * * 4',
  needBrosNudge: bool(process.env.NEED_BROS_NUDGE, true),
  /** Nothing automatic posts between these times; anything due waits until QUIET_END. */
  quietStart: process.env.QUIET_START || '22:30',
  quietEnd: process.env.QUIET_END || '08:00',
  /** Minimum gap between outgoing WhatsApp messages. */
  sendGapMs: Number(process.env.SEND_GAP_MS || 1500),
};

export type Config = typeof config;
