/**
 * Where does an incoming message go? A pure function (no WhatsApp, no database), so every rule is testable.
 *
 * Two chats:
 * - ALERTS (CHAPTER_GROUP_JID): the bot's posts + commands. A reply to one of the bot's messages, or !ask,
 *   is a question; the answer goes to the Q&A chat (tagging the asker) when one is set, else stays here.
 * - Q&A (ASK_GROUP_JID): every message is a question, no prefix needed. Only !help and !groupid work as commands.
 * - DMs: questions only when ASK_DMS=true. Any chat: !groupid (setup helper).
 */
export interface RouteInput {
  chat: string;
  isGroup: boolean;
  /** Sent from the bot's own WhatsApp account (counts in groups, never in DMs). */
  fromMe: boolean;
  text: string;
  /** Event ids of the bot message this one replies to; null when it isn't a reply to the bot. */
  quotedEventIds: string[] | null;
  alertsJid: string;
  askJid: string;
  askEnabled: boolean;
  askDms: boolean;
}

export type Route =
  | { kind: 'ignore' }
  /** Run the normal command router (alerts chat), or !help / !groupid elsewhere. */
  | { kind: 'command'; cmd: string; arg: string }
  | {
      kind: 'ask';
      question: string;
      eventIds: string[];
      /** Chat to post the answer in. */
      answerIn: string;
      /** Quote the question message (only possible when answering in the same chat). */
      quote: boolean;
      /** Tag the asker + repeat their question (answer moved to another chat). */
      tagAsker: boolean;
    };

const IGNORE: Route = { kind: 'ignore' };

export function route(i: RouteInput): Route {
  const text = i.text.trim();
  if (!text) return IGNORE;
  const isCmd = text.startsWith('!');
  const [rawCmd = '', ...rest] = isCmd ? text.slice(1).split(/\s+/) : [];
  const cmd = rawCmd.toLowerCase();
  const arg = rest.join(' ').trim();
  const eventIds = i.quotedEventIds ?? [];
  const qaChat = i.askJid && i.askJid !== i.alertsJid ? i.askJid : '';

  if (isCmd && cmd === 'groupid') return { kind: 'command', cmd, arg };

  // Q&A chat: everything is a question.
  if (qaChat && i.chat === qaChat) {
    if (isCmd && cmd === 'help') return { kind: 'command', cmd, arg };
    if (!i.askEnabled) return IGNORE;
    if (isCmd && cmd === 'ask') return arg ? { kind: 'ask', question: arg, eventIds, answerIn: qaChat, quote: true, tagAsker: false } : IGNORE;
    if (isCmd) return IGNORE; // other commands belong in the alerts chat
    return { kind: 'ask', question: text, eventIds, answerIn: qaChat, quote: true, tagAsker: false };
  }

  // Alerts chat: commands, plus questions (replies to the bot, !ask) answered in the Q&A chat.
  if (i.alertsJid && i.chat === i.alertsJid) {
    const toQa = qaChat
      ? { answerIn: qaChat, quote: false, tagAsker: true }
      : { answerIn: i.alertsJid, quote: true, tagAsker: false };
    if (isCmd && cmd === 'ask') {
      if (!i.askEnabled) return IGNORE;
      // An empty !ask still goes to the command router, which explains how to ask.
      return arg ? { kind: 'ask', question: arg, eventIds, ...toQa } : { kind: 'command', cmd, arg };
    }
    if (isCmd) return { kind: 'command', cmd, arg };
    if (i.quotedEventIds && i.askEnabled) return { kind: 'ask', question: text, eventIds, ...toQa };
    return IGNORE;
  }

  // Direct messages.
  if (!i.isGroup && !i.fromMe && i.askDms && i.askEnabled && !isCmd) {
    return { kind: 'ask', question: text, eventIds, answerIn: i.chat, quote: true, tagAsker: false };
  }
  return IGNORE;
}
