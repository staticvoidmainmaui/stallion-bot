// Runs the real Claude extraction on the saved minutes and prints the JSON + roster misses.
// Needs ANTHROPIC_API_KEY in .env (costs a few cents with Haiku).
//   npm run parse-fixture                 -> fixtures/minutes-2026-11-02.txt
//   npm run parse-fixture -- path/to.txt  -> any text export of the minutes
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { Glossary } from '../src/glossary.js';
import { config } from '../src/config.js';
import { fromText } from '../src/docs.js';
import { extractMinutes } from '../src/extract.js';
import { Roster } from '../src/roster.js';

const path = process.argv[2] ?? 'fixtures/minutes-2026-11-02.txt';
const text = fromText(readFileSync(path, 'utf8'));
const ex = await extractMinutes(text, new Date(), Glossary.load(config.glossaryPath).promptBlock());

mkdirSync('data', { recursive: true });
// Latest run (used by render-samples) + a dated copy per minutes file.
writeFileSync('data/parse-fixture.json', JSON.stringify(ex, null, 2));
writeFileSync(`data/parse-${basename(path, '.txt').replace(/^minutes-/, '')}.json`, JSON.stringify(ex, null, 2));
console.log(`meetingDate: ${ex.meetingDate}`);
console.log(`events: ${ex.events.length}, directorGoals: ${ex.directorGoals.length}, summaryItems: ${ex.summaryItems.length}\n`);
for (const e of ex.events) {
  const going = e.attendees.filter((a) => a.status === 'confirmed' || a.status === 'late').length;
  const tags = e.attendees.filter((a) => a.status !== 'confirmed').map((a) => `${a.rawName}(${a.status[0].toUpperCase()})`);
  console.log(
    `${e.date ?? '????-??-??'} ${e.startTime ?? '--:--'}  ${e.title}${e.shortTitle ? ` [${e.shortTitle}]` : ''}  ✅${going}${e.requiredCount ? `/${e.requiredCount}` : ''}${e.openSlots ? ` open:${e.openSlots}` : ''}${tags.length ? `  ${tags.join(' ')}` : ''}`,
  );
}

const roster = Roster.load(config.rosterPath);
if (roster.entries.length) {
  const misses = new Set<string>();
  for (const e of ex.events) for (const a of e.attendees) if (!roster.resolve(a.rawName).entry) misses.add(a.rawName);
  console.log(`\nroster misses: ${[...misses].join(', ') || 'none'}`);
}
const leak = JSON.stringify(ex).match(/\$\d|\(\d{3}\)-?\d{3}/);
console.log(leak ? `\n⚠️ possible fines/phone leak: ${leak[0]}` : '\n✅ no $ amounts or phone numbers in output');
console.log('\nFull JSON written to data/parse-fixture.json');
