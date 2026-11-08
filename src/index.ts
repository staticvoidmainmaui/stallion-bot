import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { Store } from './db.js';
import { Roster } from './roster.js';
import { Glossary } from './glossary.js';
import { refresh } from './refresh.js';
import { Bot } from './bot.js';
import { startReminders } from './reminders.js';

// One bot at a time: a second copy on the same WhatsApp login fights the first (code 428 disconnects)
// and could double-post. The lock holds the running copy's process id.
const LOCK = join(dirname(config.dbPath), 'bot.lock');
mkdirSync(dirname(LOCK), { recursive: true });
if (existsSync(LOCK)) {
  const pid = Number(readFileSync(LOCK, 'utf8'));
  let alive = false;
  try {
    if (pid && pid !== process.pid) process.kill(pid, 0), (alive = true);
  } catch {
    /* not running: stale lock */
  }
  if (alive) {
    console.error(`[stallion] another copy of the bot is already running (pid ${pid}). Stop it first (Ctrl+C in its window).`);
    process.exit(1);
  }
}
writeFileSync(LOCK, String(process.pid));
const unlock = () => {
  try {
    if (Number(readFileSync(LOCK, 'utf8')) === process.pid) unlinkSync(LOCK);
  } catch {
    /* already gone */
  }
};
process.on('exit', unlock);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(0));

const store = new Store(config.dbPath);
const roster = Roster.load(config.rosterPath);
const glossary = Glossary.load(config.glossaryPath);

const doRefresh = (force: boolean) => refresh(store, roster, glossary, force);

async function refreshTick(): Promise<void> {
  try {
    const r = await doRefresh(false);
    if (r.changed) {
      console.log(`[minutes] updated: ${r.events} events, meeting ${r.meetingDate}`);
      if (r.unknown.length) console.log('[minutes] names not in roster:', r.unknown.join(', '));
    }
  } catch (e) {
    console.error('[minutes] refresh failed:', (e as Error).message);
  }
}

async function main(): Promise<void> {
  // Re-apply glossary/roster to the last extraction so name edits show up without a paid re-read.
  const re = store.reapplyLatest(roster, glossary);
  if (re?.unknown.length) console.log('[minutes] names not in roster:', re.unknown.join(', '));
  console.log(`[stallion] tz=${config.tz} model=${config.model} mode=${config.botMode} reminders=${config.remindersEnabled ? 'on' : 'off'} group=${config.groupJid || '(unset — only !groupid works)'}`);
  await refreshTick();
  const bot = new Bot(store, roster, glossary, doRefresh);
  await bot.start();
  startReminders(store, bot, refreshTick);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
