# Moving the bot to a different WhatsApp group

The bot only answers in **one** group: whichever ID is on the `CHAPTER_GROUP_JID=` line in `.env`.
Swapping groups means replacing that ID. Nothing else changes: the WhatsApp login, the database and the minutes stay the same.

## Steps

1. **Make the new group** on the phone the bot runs on (or add the bot's number to it).
2. **Get the new group's ID.** Send this in the new group:
   ```
   !groupid
   ```
   This works in any chat, even while `.env` still points at the old group. The bot replies:
   ```
   This chat's ID:
   120363XXXXXXXXXXXX@g.us
   ```
3. **Swap it in `.env`.** Replace the old ID with the new one (one line only):
   ```
   CHAPTER_GROUP_JID=120363OLD...@g.us   <- delete this
   CHAPTER_GROUP_JID=120363NEW...@g.us   <- with this
   ```
4. **Restart the bot.** In PowerShell, in the `stallion_bot` folder:
   ```
   Ctrl+C
   npm start
   ```
   No QR scan needed. Check the terminal shows the new group:
   ```
   [wa] group "<new group name>": N members
   ```
5. **Test it.** Send `!help` in the new group. The old group now gets no replies.

## Good to know

- **Reminders already sent won't repeat.** Automatic "Tomorrow" and "Starting soon" reminders are sent once per event, even if they went to the old group. Use `!remind` to send tomorrow's reminders again in the new group.
- **Tags only reach people in the new group** whose real phone numbers are in `roster.json`.
- **Old polls stay in the old group.** Votes on them still count toward attendance, but start new polls in the new group with `!poll <event>`.
- **To go back,** put the old ID back on the `CHAPTER_GROUP_JID=` line and restart.
