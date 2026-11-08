# [\*STALLION_BOT\*🎠] ask (Q&A), feature branch

Brothers ask, the bot answers from the minutes. It lives on the `feature/ask` branch; `main` stays as it is until you keep it.

---

## Two chats

Alerts chat (`CHAPTER_GROUP_JID`): reminders and commands, same as now.

Stallion Q&A (`ASK_GROUP_JID`): every message is a question. Only `!help` and `!groupid` work there; other commands are ignored.

Reply to a bot message in alerts, or `!ask <question>` there → the answer goes to Stallion Q&A, tagging you, with a "re:" line.

No `ASK_GROUP_JID` set → answers stay in the alerts chat, like before.

`!members` only works in alerts.

DMs: only with `ASK_DMS=true`. ⚠️ Keep it false while the bot runs on your personal number.

---

## What answers look like

Answer about one event → the bot writes the first line itself: `name · day time · place`. Claude adds only what that line doesn't say.

Most answers are 1-3 lines. Code cuts anything longer.

Bylaws questions → "ask the Judicial Chancellor".

Off-topic → one line saying it only does chapter stuff.

---

## Linked docs

The bot can open Google Docs, Sheets (the linked tab) and Slides linked in the minutes. Only links in the minutes, nothing else.

Forms and other Drive files: it says it can't and gives the link title.

Private docs: share them with the service account email (in service-account.json), or set them to "anyone with the link". Otherwise it says "couldn't open (not shared with the bot)".

Same filter as everything else: no phones, emails, fines or dues.

---

## Set up the Q&A chat

1. Make a WhatsApp group "Stallion Q&A" and add the bot's number.
2. Send `!groupid` in it.
3. Put that id in .env: `ASK_GROUP_JID=...@g.us`
4. Restart: `npm start`

---

## Try it without WhatsApp

`npm run ask-test`: free offline test (fake model, no API key).

`npm run ask -- "who's going to mgc retreat?" --as Alejandro`: real Claude, prints every step.

`npm run ask -- "who else is going?" --about "mgc retreat"`: pretend you replied to that event's reminder.

`npm run ask-eval`: 16 saved questions through real Claude, checks short and correct (about $0.02).

---

## Apply the branch (PowerShell, in the stallion_bot folder)

If you never applied the old patch:

1. `git add -A` then `git commit -m "before ask"`
2. `git checkout -b feature/ask`
3. `git am --keep-cr patches/feature-ask.patch`
4. `npm run typecheck` then `npm run ask-test`

If you already applied the old patch (feature/ask exists):

1. `git checkout main`
2. `git branch -D feature/ask`
3. `git checkout -b feature/ask`
4. `git am --keep-cr patches/feature-ask.patch`
5. `npm run typecheck` then `npm run ask-test`

`--keep-cr` matters: extract.ts has Windows line endings and plain `git am` fails on it.

If `git am` stops: `git am --abort` and send me the error.

---

## Drop it / switch back

Back to the old bot: `git checkout main`, then `npm start`

Keep it for good: `git checkout main` then `git merge feature/ask`

Off but stay on the branch: `ASK_ENABLED=false` in .env

---

## Settings (.env)

`ASK_ENABLED=true`: Q&A on/off

`ASK_GROUP_JID=`: the Stallion Q&A group (empty = answer in alerts)

`ASK_DMS=false`: answer DMs (spare number only)

`ASK_DAILY_LIMIT=20`: questions per person per day

`ASK_MAX_ROUNDS=4`: most lookups before it must answer

---

## Known limits

Only the latest minutes, not past weeks.

Keyword search: "attire" won't find "dress code".

Reply context only works for bot messages sent after this branch is running.

Long docs are cut at about 60k characters.

A doc read is cached 10 minutes, so an edit can take that long to show up.
