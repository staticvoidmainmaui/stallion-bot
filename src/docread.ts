/**
 * read_doc: lets the ask agent open a Google Doc / Sheet / Slides deck that the minutes LINK to.
 *
 * Rules:
 * - Only links that appear in the loaded minutes can be opened (an allowlist), nothing else.
 * - Docs are read whole (chapter docs are small); capped at ~60k characters as a safety net.
 * - The same privacy filter as search_minutes runs on the text before Claude sees it.
 * - Results are cached for 10 minutes so a burst of questions about one event fetches the doc once.
 *
 * How it fetches: Google's "export" URLs (Docs -> .txt, Sheets -> .csv for the linked tab, Slides -> .txt).
 * If a service account is configured (GOOGLE_APPLICATION_CREDENTIALS), its access token is sent, so
 * anything shared with that account works. Without one, only "anyone with the link" docs open.
 */
import { existsSync } from 'node:fs';
import * as M from './messages.js';

export type DocKind = 'document' | 'spreadsheets' | 'presentation' | 'forms' | 'drive-file';

export interface DocRef {
  kind: DocKind;
  id: string;
  /** Sheets tab id (from #gid= / ?gid=), when the link points at one tab. */
  gid?: string;
}

/** Parse a Google link into kind + file id. Null for anything that isn't a Google Drive file. */
export function parseGoogleUrl(raw: string): DocRef | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '');
  if (host === 'docs.google.com') {
    const m = /^\/(document|spreadsheets|presentation|forms)\/d\/(?:e\/)?([\w-]{10,})/.exec(url.pathname);
    if (!m) return null;
    const gid = /(?:^|[#&?])gid=(\d+)/.exec(`${url.search}${url.hash}`)?.[1];
    return { kind: m[1] as DocKind, id: m[2], ...(m[1] === 'spreadsheets' && gid ? { gid } : {}) };
  }
  if (host === 'drive.google.com') {
    const id = /\/file\/d\/([\w-]{10,})/.exec(url.pathname)?.[1] ?? url.searchParams.get('id');
    return id ? { kind: 'drive-file', id } : null;
  }
  if (host === 'forms.gle') return { kind: 'forms', id: url.pathname.slice(1) || 'short' };
  return null;
}

/** Same file? (kind + id; a Sheets link to another tab of the same file still counts as linked.) */
export const sameDoc = (a: DocRef, b: DocRef) => a.kind === b.kind && a.id === b.id;

/** Every URL written in a block of text: markdown links [text](url) and bare links. */
export function urlsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) out.add(m[1]);
  for (const m of text.matchAll(/https?:\/\/[^\s)\]>"']+/g)) out.add(m[0]);
  return [...out];
}

export function exportUrl(ref: DocRef): string | null {
  switch (ref.kind) {
    case 'document':
      return `https://docs.google.com/document/d/${ref.id}/export?format=txt`;
    case 'spreadsheets':
      return `https://docs.google.com/spreadsheets/d/${ref.id}/export?format=csv${ref.gid ? `&gid=${ref.gid}` : ''}`;
    case 'presentation':
      return `https://docs.google.com/presentation/d/${ref.id}/export/txt`;
    default:
      return null; // Forms and other Drive files can't be read as text.
  }
}

export type DocResult = { ok: true; text: string } | { ok: false; reason: string };

/** Minimal fetch shape so tests can pass a fake. */
export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  url?: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface DocReaderOptions {
  fetch?: FetchLike;
  /** Returns a Google access token, or null to fetch without one (public links only). */
  getToken?: () => Promise<string | null>;
  /** Filter applied to the doc text (the ask module passes its privacy scrub). */
  scrub?: (text: string) => string;
  cacheMs?: number;
  maxChars?: number;
  timeoutMs?: number;
}

export class DocReader {
  private cache = new Map<string, { at: number; result: DocResult }>();
  private fetch: FetchLike;

  constructor(private opts: DocReaderOptions = {}) {
    this.fetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  async read(ref: DocRef): Promise<DocResult> {
    const url = exportUrl(ref);
    if (!url) return { ok: false, reason: M.docCantRead() };
    const hit = this.cache.get(url);
    const ttl = this.opts.cacheMs ?? 10 * 60_000;
    if (hit && Date.now() - hit.at < ttl) return hit.result;

    const result = await this.fetchText(url);
    this.cache.set(url, { at: Date.now(), result });
    return result;
  }

  private async fetchText(url: string): Promise<DocResult> {
    const timeout = this.opts.timeoutMs ?? 10_000;
    const attempt = async (token: string | null) => {
      const res = await this.fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(timeout),
      });
      // A private doc fetched without access lands on Google's sign-in page (200 + HTML), not an error.
      const html = /text\/html/i.test(res.headers.get('content-type') ?? '') || /accounts\.google\.com/.test(res.url ?? '');
      if (!res.ok || html) return null;
      return res.text();
    };
    try {
      let token: string | null = null;
      try {
        token = (await this.opts.getToken?.()) ?? null;
      } catch (e) {
        console.warn('[doc] service account token failed, trying the public link:', (e as Error).message);
      }
      let text = await attempt(token);
      if (text === null && token) text = await attempt(null); // maybe it's public but not shared with the account
      if (text === null) return { ok: false, reason: M.docNotShared() };
      const max = this.opts.maxChars ?? 60_000;
      const clean = (this.opts.scrub ?? ((t: string) => t))(text.replace(/\r\n/g, '\n'));
      return { ok: true, text: clean.length > max ? `${clean.slice(0, max)}\n[…cut, doc is longer]` : clean };
    } catch (e) {
      console.warn('[doc] fetch failed:', (e as Error).message);
      return { ok: false, reason: M.docNotShared() };
    }
  }
}

/** Token source from GOOGLE_APPLICATION_CREDENTIALS, or null when there's no usable key file. */
export function serviceAccountToken(keyFile: string): (() => Promise<string | null>) | undefined {
  if (!keyFile || !existsSync(keyFile)) return undefined;
  let auth: { getAccessToken(): Promise<string | null | undefined> } | null = null;
  return async () => {
    if (!auth) {
      const { google } = await import('googleapis');
      auth = new google.auth.GoogleAuth({ keyFile, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
    }
    return (await auth.getAccessToken()) ?? null;
  };
}
