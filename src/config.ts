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
  digestSticker: process.env.DIGEST_STICKER ?? 'assets/ufbetas-sticker.webp',
  /** Cron schedules (chapter time zone). */
  weeklyDigestCron: process.env.WEEKLY_DIGEST_CRON || '0 12 * * 1',
  dailyDigestCron: process.env.DAILY_DIGEST_CRON || '0 9 * * 2-7',
  /** Date-only events (no clock time) get their "tomorrow" reminder at this hour the day before. */
  eveningReminderHour: Number(process.env.EVENING_REMINDER_HOUR || 19),
  /** Auto-post a follow-up poll ~2 days before events that are short or have unanswered maybes. */
  autoFollowup: bool(process.env.AUTO_FOLLOWUP, false),
  /** Minimum gap between outgoing WhatsApp messages. */
  sendGapMs: Number(process.env.SEND_GAP_MS || 1500),
};

export type Config = typeof config;
