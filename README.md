# 🐎 Stallion Bot

WhatsApp bot for the Zeta Beta chapter. It reads the **Fall 2026 MASTER Minutes** Google Doc (read-only), pulls out every event, who's going, and how many bros are still needed, then works the chapter group chat: headcounts, @mention follow-ups, attendance polls, reminders and a summary.

```
Google Doc ──Docs API──▶ flatten (nesting + links) ──Claude──▶ JSON ──roster──▶ SQLite ──Baileys──▶ group chat
```

## Commands (in the chapter group)

| Command | Who | What |
|---|---|---|
| `!help` | anyone | List commands |
| `!events [days]` | anyone | Upcoming events + ✅going ❔tentative 🟡excused / need N (default 7 days) |
| `!event <name>` | anyone | Details, who's going, links from the minutes |
| `!short` | anyone | Events under their required headcount, "need N more" |
| `!poll <name>` | anyone | WhatsApp poll: Going / Tentative / Can't |
| `!votes <name>` | anyone | Poll results by name |
| `!summary` | anyone | Chapter summary grouped by importance |
| `!tag <name>` | exec | @mentions everyone signed up |
| `!followup [name]` | exec | @mentions (T) and (E) bros for the next 7 days (or one event) |
| `!goals` | exec | @mentions each director with their "Goals for next meeting" |
| `!refresh` | exec | Re-read the minutes now |
| `!members` | exec | Prints group members' IDs/phones to the **server console** (for filling the roster) |
| `!groupid` | anyone, any chat | Prints the chat's JID (setup) |

Automatic: hourly doc check (only re-extracts when the doc changed), 24h + 2h reminders with @mentions for timed events, 9 AM "today & tomorrow" digest.

`<name>` is fuzzy: `!event retreat`, `!poll bxo`, `!tag akdphi`.

## Setup checklist

1. **Spare number.** Get a SIM/eSIM or old phone that is *not* anyone's personal WhatsApp. Install WhatsApp on it.
2. **Test group first.** Make a group with the bot number + 2–3 bros. Move to the chapter group only after it behaves.
3. **Google Cloud** (console.cloud.google.com):
   - New project → enable **Google Docs API** (and Drive API for later RAG).
   - IAM → Service Accounts → create one → Keys → Add key → JSON. Save it here as `service-account.json`.
   - Open the minutes doc → Share → paste the service account's `client_email` → **Viewer**.
   - Copy the doc ID from the URL (`/document/d/<ID>/edit`).
4. **Anthropic API key** from console.anthropic.com.
5. **Install** (Node 22+):
   ```powershell
   npm install
   copy .env.example .env      # then fill in ANTHROPIC_API_KEY, MINUTES_DOC_ID
   copy roster.example.json roster.json
   npm run flatten-check       # offline test, no keys needed
   npm run parse-fixture       # optional: real extraction on the saved minutes (~cents)
   ```
6. **Link WhatsApp:** `npm start` → scan the QR **from the bot phone** (WhatsApp → Linked devices → Link a device). Login is saved in `auth/`.
7. **Find the group:** send `!groupid` in the group → paste into `CHAPTER_GROUP_JID` in `.env` → restart.
8. **Fill the roster** (`roster.json`): one entry per bro with phone (digits, country code first: `15615551234`), every nickname the minutes use (`Eth`, `Mike`, full names), and `"isExec": true` for officers. Run `!members` as an exec to print the group's member list to the console.
   - **LID quirk:** newer WhatsApp groups identify people by hidden `…@lid` IDs, not phone numbers. The bot maps phone → group ID from group metadata automatically. If a bro's mention doesn't render, copy his `@lid` ID from `!members` output into his roster entry as `"jid"`.
   - `!refresh` reports any names in the minutes that don't match the roster.

## Deploy (always-on)

Needs a long-lived process with a persistent disk. **Not serverless** (Lambda/Vercel will drop the WhatsApp session).

- **$5 VPS** (Hetzner/DigitalOcean/Lightsail): install Node 22, copy the folder (with `.env`, `roster.json`, `service-account.json`), `npm ci`, run under `pm2 start "npm start" --name stallion` or the Dockerfile.
- **Railway / Fly.io:** deploy the Dockerfile, mount **one volume at `/app/data`** (holds the WhatsApp login and the database), set env vars in the dashboard, and put the service-account JSON on the volume and point `GOOGLE_APPLICATION_CREDENTIALS` at it. First boot: open the logs and scan the QR.
- Easiest move from your laptop: copy your already-linked `auth/` folder to the server (into `data/auth` for Docker) so you don't re-scan.

## Safety rules (read before adding to the chapter group)

- **Unofficial client.** Baileys is not Meta's API and breaks WhatsApp's ToS. The bot number can get banned. Use a spare number, keep volume low (1.5 s minimum gap is built in), never bulk-DM, and only respond to `!` commands.
- **No money in the group.** The extractor is told to drop fines, dues and phone numbers, and the bot never posts them. Don't add commands that do.
- **Exec-only mass tags.** `!tag`, `!followup`, `!goals` require an exec number (`EXEC_NUMBERS` or `isExec` in the roster).
- **Read-only on the doc.** Poll votes are stored in the bot's database; the minutes stay the source of truth.

## Minutes conventions the bot understands

- Status tags: `(T)` tentative, `(E)` excused, `(L)` late, `(A)` absent. Case doesn't matter, but uppercase keeps it clean. No tag means going.
- `Nate (was Alex)` → Nate is going.
- Blank list items under a sign-up list count as open slots.
- Headcounts in any wording: "need 7", "51% … (8 bros)", "Requesting 25% attendance (4)", "minimum 6 bros per probate".
- **Update the DATE header every week.** Dates like "Thursday 10/29" are resolved against it.

## Layout

```
src/
  index.ts      boot: db, roster, first refresh, bot, schedulers
  config.ts     .env loading
  docs.ts       Google Docs fetch + flatten (nesting, links, smart chips); fromText() for exports
  extract.ts    Claude structured extraction (zod-validated)
  refresh.ts    fetch → extract only when the doc revision changed → save
  roster.ts     name/alias/nickname resolution
  db.ts         SQLite: snapshots, events, attendees, polls, poll_votes, reminders_sent
  events.ts     upcoming/shortfall/search/format helpers
  bot.ts        Baileys connection, commands, mentions, polls
  reminders.ts  15-min reminder loop, 9 AM digest, hourly doc check
scripts/
  flatten-check.ts   offline test (no keys)
  parse-fixture.ts   real extraction on fixtures/ (needs ANTHROPIC_API_KEY)
```
