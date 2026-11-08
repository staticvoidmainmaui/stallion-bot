/**
 * Ask the agent a question from the terminal and watch it work, step by step.
 * Uses the real Claude API (your ANTHROPIC_API_KEY) and the bot's local database. Never touches WhatsApp.
 *
 *   npm run ask -- "who's going to mgc retreat?" --as Alejandro
 *   npm run ask -- "what's the dress code for the retreat?"
 *   npm run ask -- "where is this?" --about "mgc retreat"     (pretend you replied to a message about that event)
 *   npm run ask -- "what room are mgc elections in?"           (may open a doc linked in the minutes)
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../src/config.js';
import { Store } from '../src/db.js';
import { Roster } from '../src/roster.js';
import { Glossary } from '../src/glossary.js';
import { findEvents } from '../src/events.js';
import { answer, composeReply, scrub } from '../src/ask.js';
import { DocReader, serviceAccountToken } from '../src/docread.js';
import * as M from '../src/messages.js';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const as = flag('as') ?? null;
const about = flag('about');
const question = args.join(' ').trim();
if (!question) {
  console.log('Usage: npm run ask -- "your question" [--as Name] [--about "event name"]');
  process.exit(1);
}
if (!config.anthropicApiKey) {
  console.log('Set ANTHROPIC_API_KEY in .env first. (For a free offline check, run: npm run ask-test)');
  process.exit(1);
}

const store = new Store(config.dbPath);
const roster = Roster.load(config.rosterPath);
const glossary = Glossary.load(config.glossaryPath);
if (!store.latestSnapshot()) {
  console.log('No minutes in the database yet. Start the bot once (npm start) or run !refresh.');
  process.exit(1);
}
const senderName = as ? (roster.resolve(as).entry?.name ?? as) : null;
const quoted = about ? findEvents(store, about, glossary).slice(0, 1).map((v) => v.id) : [];

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
console.log(bold(`\nQ: ${question}`));
console.log(dim(`asked by: ${senderName ?? '(unknown)'}${quoted.length ? ` · replying about: ${quoted.join(', ')}` : ''} · model: ${config.model}\n`));

const t0 = Date.now();
const result = await answer(
  question,
  { senderName, quotedEventIds: quoted },
  {
    store,
    roster,
    glossary,
    client: new Anthropic({ apiKey: config.anthropicApiKey }),
    model: config.model,
    maxRounds: config.askMaxRounds,
    docs: new DocReader({ getToken: serviceAccountToken(config.googleCredentials), scrub }),
    onStep: (s) => {
      if (s.type === 'model') {
        const what = s.toolCalls.length ? `asks for ${s.toolCalls.map((t) => `${t.name}(${JSON.stringify(t.input)})`).join(', ')}` : 'answers';
        console.log(`${bold(`[round ${s.round}] Claude`)} ${what}  ${dim(`stop_reason=${s.stopReason}`)}`);
        if (s.text && s.toolCalls.length) console.log(dim(`  thinking out loud: ${s.text}`));
      } else {
        const out = s.output.length > 400 ? `${s.output.slice(0, 400)}… (${s.output.length} chars)` : s.output;
        console.log(`  ${bold('→ our code runs')} ${s.name}: ${dim(out)}`);
      }
    },
  },
);
const out = composeReply(result, { store, quotedEventIds: quoted });
console.log(dim(`\nheader event: ${result.detailIds.length === 1 ? result.detailIds[0] : quoted.length === 1 && !result.detailIds.length ? quoted[0] : '(none)'} · docs read: ${result.docsRead.join(', ') || 'none'}`));
console.log(`\n${bold('What the Q&A chat would see:')}\n${M.style(out.text)}`);
console.log(dim(`\n(${((Date.now() - t0) / 1000).toFixed(1)}s)`));
store.db.close();
