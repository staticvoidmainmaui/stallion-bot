import { config } from './config.js';
import { Store } from './db.js';
import { Roster } from './roster.js';
import { Glossary } from './glossary.js';
import { refresh } from './refresh.js';
import { Bot } from './bot.js';
import { startReminders } from './reminders.js';

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
