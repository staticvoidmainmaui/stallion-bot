import { existsSync, readFileSync } from 'node:fs';

/** One org and every way it gets written. `short` is what the bot shows. */
export interface Org {
  short: string;
  full: string;
  aliases: string[];
  confirmed?: boolean;
}

interface GlossaryFile {
  orgs: Org[];
  /** Minutes title (or a distinctive part of it) -> pinned short name. */
  eventNames: Record<string, string>;
  /** Filler phrases -> shorter phrasing, applied to every title. */
  words: Record<string, string>;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9α-ω]+/g, ' ').trim();

export class Glossary {
  constructor(private g: GlossaryFile) {}

  static load(path: string): Glossary {
    if (!existsSync(path)) return new Glossary({ orgs: [], eventNames: {}, words: {} });
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<GlossaryFile>;
    return new Glossary({ orgs: raw.orgs ?? [], eventNames: raw.eventNames ?? {}, words: raw.words ?? {} });
  }

  get orgs(): Org[] {
    return this.g.orgs;
  }

  /** Swap every org alias/full name for its short code, then shorten filler words. */
  normalize(text: string): string {
    let out = text;
    // Longest phrases first so "Theta Nu Xi Multicultural Sorority, Inc." wins over "Theta Nu Xi".
    const pairs = this.g.orgs
      .flatMap((o) => [o.full, ...o.aliases].filter((a) => a && !a.includes('??')).map((a) => [a, o.short] as const))
      .sort((a, b) => b[0].length - a[0].length);
    for (const [from, to] of pairs) {
      if (from.toLowerCase() === to.toLowerCase()) continue;
      out = out.replace(new RegExp(`(?<![\\w])${esc(from)}(?![\\w])`, 'gi'), to);
    }
    for (const [from, to] of Object.entries(this.g.words).sort((a, b) => b[0].length - a[0].length)) {
      out = out.replace(new RegExp(`(?<![\\w])${esc(from)}(?![\\w])`, 'gi'), to);
    }
    return out.replace(/\s{2,}/g, ' ').trim();
  }

  /** Pinned name from eventNames: exact title match first, then the longest pin contained in the title. */
  pinned(title: string): string | null {
    const t = key(title);
    let best: [string, string] | null = null;
    for (const [from, to] of Object.entries(this.g.eventNames)) {
      const f = key(from);
      if (t === f) return to;
      if (t.includes(f) && (!best || f.length > key(best[0]).length)) best = [from, to];
    }
    return best ? best[1] : null;
  }

  /** Display name: pinned name > model's short name > title, always org-normalized. */
  shortName(title: string, modelShort?: string | null): string {
    return this.normalize(this.pinned(title) ?? modelShort ?? title);
  }

  /** Extra search words for a query: "theta nu xi" also searches "tnx", "tnx" also searches "theta nu xi". */
  expand(query: string): string[] {
    const q = key(query);
    const out = new Set<string>([q]);
    for (const o of this.g.orgs) {
      const names = [o.short, o.full, ...o.aliases].filter((n) => n && !n.includes('??')).map(key).filter(Boolean);
      for (const hit of names) {
        if (!` ${q} `.includes(` ${hit} `)) continue;
        for (const n of names) out.add(q.replace(hit, n));
      }
    }
    return [...out];
  }

  /** Block appended to the extraction prompt so the model uses the same short codes. */
  promptBlock(): string {
    const orgs = this.g.orgs
      .filter((o) => !o.full.includes('??'))
      .map((o) => `- ${o.short} = ${[o.full, ...o.aliases].join(' / ')}`)
      .join('\n');
    return orgs ? `\nORG SHORT CODES (use these in shortTitle):\n${orgs}\n` : '';
  }
}
