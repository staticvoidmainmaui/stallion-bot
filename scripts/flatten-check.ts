// Offline sanity check — no API keys needed.  Run: npm run flatten-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { docs_v1 } from 'googleapis';
import { flattenDocument, fromText } from '../src/docs.js';
import { Roster } from '../src/roster.js';

// 1. A fake Docs API document with nesting, a hyperlink, a smart chip and a blank bullet.
const para = (text: string, level?: number, url?: string): docs_v1.Schema$StructuralElement => ({
  paragraph: {
    bullet: level === undefined ? undefined : { listId: 'l1', nestingLevel: level },
    elements: [{ textRun: { content: `${text}\n`, textStyle: url ? { link: { url } } : {} } }],
  },
});
const doc: docs_v1.Schema$Document = {
  body: {
    content: [
      para('CHAPTER MEETING MINUTES'),
      para('MGC Retreat', 0),
      para('Date: Sunday, Nov. 15th', 1),
      para('51% chapter attendance required (8 bros)', 1),
      para('Michael', 2),
      para('Frank (T)', 2),
      para('', 2),
      {
        paragraph: {
          bullet: { listId: 'l1', nestingLevel: 1 },
          elements: [{ richLink: { richLinkProperties: { title: 'Fines Google Sheet', uri: 'https://docs.google.com/x' } } }],
        },
      },
      para('Excuse Form', 1, 'https://forms.gle/abc'),
    ],
  },
};
const flat = flattenDocument(doc);
console.log('--- flattened fake doc ---\n' + flat + '\n');
assert.match(flat, /^- MGC Retreat$/m);
assert.match(flat, /^ {2}- Date: Sunday, Nov\. 15th$/m);
assert.match(flat, /^ {4}- Frank \(T\)$/m);
assert.match(flat, /^ {4}- \(blank\)$/m, 'blank bullets must survive as open slots');
assert.match(flat, /\[Fines Google Sheet\]\(https:\/\/docs\.google\.com\/x\)/);
assert.match(flat, /\[Excuse Form\]\(https:\/\/forms\.gle\/abc\)/);

// 2. The real minutes fixture (PDF text export) cleans up.
const fixture = fromText(readFileSync(new URL('../fixtures/minutes-2026-10-25.txt', import.meta.url), 'utf8'));
assert.ok(!/​/.test(fixture), 'zero-width spaces removed');
assert.match(fixture, /BXO 2 PM/);
console.log(`fixture: ${fixture.split('\n').length} lines, ~${Math.round(fixture.length / 4)} tokens`);

// 3. Roster alias resolution.
const roster = new Roster([
  { name: 'Ethan', aliases: ['Eth'], phone: '1' },
  { name: 'Michael', aliases: [], phone: '2' },
  { name: 'Ian', aliases: ['Ian Brooks'], phone: '3' },
  { name: 'Henry', aliases: ['Henry Adams Cole'], phone: '4', isExec: true },
  { name: 'Sam H', aliases: [], phone: '5' },
  { name: 'Sam M', aliases: [], phone: '6' },
]);
assert.equal(roster.resolve('Eth').entry?.name, 'Ethan');
assert.equal(roster.resolve('Mike').entry?.name, 'Michael');
assert.equal(roster.resolve('Ian Brooks').entry?.name, 'Ian');
assert.equal(roster.resolve('henry(T)').entry?.name, 'Henry');
assert.equal(roster.resolve('Sam H').entry?.name, 'Sam H');
assert.equal(roster.resolve('Sam').entry, null, 'ambiguous first name stays unresolved');
assert.deepEqual(roster.resolve('Sam').candidates.sort(), ['Sam H', 'Sam M']);
assert.equal(roster.resolve('Zed').entry, null);

console.log('✅ flatten-check passed');
