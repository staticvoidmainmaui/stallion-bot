import { existsSync, readFileSync } from 'node:fs';

export interface RosterEntry {
  /** Canonical name used in bot messages. */
  name: string;
  /** Other ways the minutes write this brother: nicknames, full name, last-name initial. */
  aliases: string[];
  /** Phone number, digits only, country code first (e.g. 15615551234). */
  phone: string;
  /** Optional explicit WhatsApp JID override (e.g. a 123...@lid id from !members). */
  jid?: string;
  isExec?: boolean;
  /** Officer/director role, informational. */
  role?: string;
}

/** Common nicknames -> full first name. Extend in roster aliases for anything chapter-specific. */
const NICKNAMES: Record<string, string> = {
  ant: 'anthony',
  tony: 'anthony',
  dave: 'david',
  matt: 'matthew',
  mike: 'michael',
  nick: 'nicholas',
  chris: 'christopher',
  alex: 'alejandro',
  ale: 'alejandro',
  jim: 'james',
  jimmy: 'james',
  will: 'william',
  dan: 'daniel',
  danny: 'daniel',
  josh: 'joshua',
  jon: 'jonathan',
  brad: 'bradley',
  eli: 'elias',
};

export function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\((?:t|e|l|a)\)/g, ' ')
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface Resolution {
  entry: RosterEntry | null;
  /** When null entry: other roster names that partially matched. */
  candidates: string[];
}

export class Roster {
  constructor(public readonly entries: RosterEntry[]) {}

  static load(path: string): Roster {
    if (!existsSync(path)) {
      console.warn(`[roster] ${path} not found — names will not resolve to @mentions. Copy roster.example.json to ${path}.`);
      return new Roster([]);
    }
    const data = JSON.parse(readFileSync(path, 'utf8')) as RosterEntry[];
    return new Roster(data.map((e) => ({ ...e, aliases: e.aliases ?? [], phone: (e.phone ?? '').replace(/\D/g, '') })));
  }

  private keys(e: RosterEntry): string[] {
    return [e.name, ...e.aliases].map(norm).filter(Boolean);
  }

  resolve(raw: string): Resolution {
    const n = norm(raw);
    if (!n) return { entry: null, candidates: [] };

    // 1. exact name / alias
    const exact = this.entries.filter((e) => this.keys(e).includes(n));
    if (exact.length === 1) return { entry: exact[0], candidates: [] };

    // 2. first token (expanding nicknames) against first tokens of name/aliases
    const tokens = n.split(' ');
    const first = NICKNAMES[tokens[0]] ?? tokens[0];
    const byFirst = this.entries.filter((e) =>
      this.keys(e).some((k) => {
        const kt = k.split(' ')[0];
        return kt === first || kt === tokens[0] || (NICKNAMES[kt] ?? kt) === first;
      }),
    );
    if (byFirst.length === 1) return { entry: byFirst[0], candidates: [] };

    // 3. disambiguate with the second token (last name or initial)
    if (byFirst.length > 1 && tokens[1]) {
      const second = tokens[1];
      const narrowed = byFirst.filter((e) =>
        this.keys(e).some((k) => k.split(' ').slice(1).some((t) => t.startsWith(second) || second.startsWith(t))),
      );
      if (narrowed.length === 1) return { entry: narrowed[0], candidates: [] };
    }
    return { entry: null, candidates: byFirst.map((e) => e.name) };
  }

  isExec(phone: string): boolean {
    return this.entries.some((e) => e.isExec && e.phone && e.phone === phone);
  }

  byName(name: string): RosterEntry | undefined {
    return this.entries.find((e) => e.name === name);
  }
}
