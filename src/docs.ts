import { google, type docs_v1 } from 'googleapis';
import { readFileSync } from 'node:fs';
import { config } from './config.js';

export interface MinutesSource {
  text: string;
  /** Google Docs revisionId, or a hash-ish marker for text files. Used to skip re-extraction. */
  revision: string;
}

/** Remove zero-width chars and other junk Google Docs/PDF exports leave behind. */
export function cleanText(s: string): string {
  return s
    .replace(/[​-‍﻿]/g, '')
    .replace(/\u000B/g, '\n') // vertical tab = soft line break in Docs
    .replace(/\t/g, '    ');
}

/** Plain-text path (PDF->text export, pasted minutes, fixtures). */
export function fromText(text: string): string {
  return cleanText(text)
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function renderElements(elements: docs_v1.Schema$ParagraphElement[] | undefined): string {
  let out = '';
  for (const el of elements ?? []) {
    if (el.textRun?.content) {
      const text = el.textRun.content.replace(/\n$/, '');
      const url = el.textRun.textStyle?.link?.url;
      out += url && text.trim() ? `[${text.trim()}](${url})` : text;
    } else if (el.richLink?.richLinkProperties) {
      // Smart chips (e.g. "Fines Google Sheet") carry their URL here.
      const p = el.richLink.richLinkProperties;
      out += `[${p.title ?? 'link'}](${p.uri ?? ''})`;
    } else if (el.person?.personProperties) {
      out += `@${el.person.personProperties.name ?? el.person.personProperties.email ?? 'person'}`;
    } else if (el.dateElement) {
      // Date chips: Docs API exposes the display text in dateElementProperties.
      const d = (el.dateElement as { dateElementProperties?: { displayText?: string } }).dateElementProperties;
      if (d?.displayText) out += d.displayText;
    }
  }
  return cleanText(out);
}

function flattenContent(content: docs_v1.Schema$StructuralElement[] | undefined, lines: string[]): void {
  for (const se of content ?? []) {
    if (se.paragraph) {
      const text = renderElements(se.paragraph.elements).trimEnd();
      const bullet = se.paragraph.bullet;
      if (bullet) {
        const level = bullet.nestingLevel ?? 0;
        // Keep blank bullets: an empty "v." under a signup list means an open slot.
        lines.push(`${'  '.repeat(level)}- ${text.trim() || '(blank)'}`);
      } else if (text.trim()) {
        const style = se.paragraph.paragraphStyle?.namedStyleType ?? '';
        const h = /^HEADING_(\d)$/.exec(style);
        lines.push(h ? `${'#'.repeat(Number(h[1]))} ${text.trim()}` : text.trim());
      } else {
        lines.push('');
      }
    } else if (se.table) {
      for (const row of se.table.tableRows ?? []) {
        const cells = (row.tableCells ?? []).map((c) => {
          const inner: string[] = [];
          flattenContent(c.content, inner);
          return inner.filter(Boolean).join(' / ');
        });
        lines.push(`| ${cells.join(' | ')} |`);
      }
    }
  }
}

/**
 * Flatten a Docs API document into indented text. Bullet nesting becomes two
 * spaces per level and hyperlinks become [text](url) so the extractor sees them.
 */
export function flattenDocument(doc: docs_v1.Schema$Document): string {
  const lines: string[] = [];
  const tabs = doc.tabs ?? [];
  if (tabs.length) {
    const walk = (t: docs_v1.Schema$Tab) => {
      if (tabs.length > 1 && t.tabProperties?.title) lines.push(`# [Tab] ${t.tabProperties.title}`);
      flattenContent(t.documentTab?.body?.content, lines);
      for (const c of t.childTabs ?? []) walk(c);
    };
    for (const t of tabs) walk(t);
  } else {
    flattenContent(doc.body?.content, lines);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function fetchMinutes(): Promise<MinutesSource> {
  if (config.minutesDocId) {
    const auth = new google.auth.GoogleAuth({
      keyFile: config.googleCredentials || undefined,
      scopes: ['https://www.googleapis.com/auth/documents.readonly'],
    });
    const docs = google.docs({ version: 'v1', auth });
    const res = await docs.documents.get({ documentId: config.minutesDocId, includeTabsContent: true });
    return { text: flattenDocument(res.data), revision: res.data.revisionId ?? String(Date.now()) };
  }
  if (config.minutesTextFile) {
    const raw = readFileSync(config.minutesTextFile, 'utf8');
    return { text: fromText(raw), revision: `file:${raw.length}:${raw.slice(-200)}` };
  }
  throw new Error('Set MINUTES_DOC_ID (Google Doc) or MINUTES_TEXT_FILE (offline) in .env');
}
