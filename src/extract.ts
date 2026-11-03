import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { config } from './config.js';

export const AttendeeStatus = z.enum(['confirmed', 'tentative', 'excused', 'late', 'absent']);
export type AttendeeStatus = z.infer<typeof AttendeeStatus>;

const EventSchema = z.object({
  title: z.string().describe('The event\'s own name as written, e.g. "BXO Probate" or "MGC Retreat". Never prepend a parent heading.'),
  shortTitle: z
    .string()
    .nullable()
    .optional()
    .describe('2-4 word display name using the org short codes, e.g. "TNX Cosponsor", "KPL Probate", "Nominations (Rd 1)"'),
  section: z.string().describe('Officer/director section it appears under, e.g. "President > MGC" or "VP of Programming > Social"'),
  owner: z.string().nullable().describe('Person running it if stated (name in parentheses on the section), else null'),
  date: z.string().nullable().describe('ISO date YYYY-MM-DD, year inferred from the meeting date; null if no date'),
  startTime: z.string().nullable().describe('24h start time HH:MM if a clock time is given (use call time only if no start time), else null'),
  timeRaw: z.string().nullable().describe('Time exactly as written, e.g. "6:22PM-8:00PM (5:45pm Call Time)"'),
  location: z.string().nullable(),
  approved: z.boolean().nullable().describe('true if tagged [APPROVED], false if [DENIED], else null'),
  requiredCount: z.number().int().nullable().describe('Number of brothers required/requested/needed, as an integer; null if none stated'),
  requiredRaw: z.string().nullable().describe('The requirement text as written, e.g. "51% chapter attendance required (8 bros)"'),
  attendees: z.array(
    z.object({
      rawName: z.string().describe('Name exactly as written, without the status tag'),
      status: AttendeeStatus,
    }),
  ),
  openSlots: z.number().int().describe('Count of blank list items under the attendee list (unfilled slots)'),
  links: z.array(z.object({ text: z.string(), url: z.string() })).describe('Hyperlinks inside this event block'),
  notes: z.string().nullable().describe('One short line of key details/deadlines, or null'),
});

const ExtractionSchema = z.object({
  meetingDate: z.string().nullable().describe('ISO date of the meeting from the DATE header'),
  events: z.array(EventSchema),
  directorGoals: z.array(
    z.object({
      owners: z.array(z.string()).describe('Names of the officer/directors responsible'),
      role: z.string().describe('e.g. "VP of Finance" or "Philanthropy"'),
      goals: z.array(z.string()),
    }),
  ),
  summaryItems: z.array(
    z.object({
      text: z.string().describe('One-line takeaway written for brothers'),
      importance: z.enum(['high', 'med', 'low']),
      category: z.string().describe('e.g. Deadline, Attendance, Elections, Fundraising, Info'),
      date: z
        .string()
        .nullable()
        .optional()
        .describe('ISO date of the LAST day this item matters (event day or deadline); null if undated'),
    }),
  ),
});

export type ExtractedEvent = z.infer<typeof EventSchema>;
export type Extraction = z.infer<typeof ExtractionSchema>;

const SYSTEM = `You extract structured data from a fraternity chapter's weekly meeting minutes (a Google Doc flattened to indented text; "- " bullets nest by indentation, links appear as [text](url)).

TITLES: an event's title is its own name. Do not borrow a neighbouring heading (e.g. nominations under "Chapter Elections" are "Chapter Elections Nominations (Round 1)", not "Brotherhood Retreat ..."). Use shortTitle for a 2-4 word name with org short codes.

EVENTS: every dated or scheduled activity brothers might attend or staff (probates, socials, service, MGC events, cosponsorships, tabling, practices, retreats, elections, trips). Include council (MGC/SFL) elections and nomination rounds even with no sign-up list. Recurring items ("Wednesdays, 8:30 PM") are one event dated the next occurrence on or after the meeting date; keep the weekday in timeRaw. Each probate/time slot is its own event. Keep past events too (the app filters by date). Skip committees, interest lists for officer positions, and items with no attendance or date.

DATES: infer the year from the meeting DATE header. "Thursday 10/29" -> that year. If a weekday and date disagree, trust the numeric date. "(CHANGED FROM 4 PM)" means use the new time.

ATTENDEES: names listed under an event's attendance / sign-up / interested / "need N" list. Status tags (case-insensitive):
- no tag -> confirmed
- (T) -> tentative
- (E) -> excused
- (L) -> late
- (A) -> absent
- "Nate (was Alex)" -> Nate is the attendee; ignore Alex.
- Names under an "Excuse List" -> excused.
Blank list items (empty, "(blank)", or just a numeral) are open slots: count them in openSlots, never as attendees. Write rawName as written (first name or full name), without the tag.

REQUIRED COUNT: convert any phrasing to an integer number of brothers: "need 7" -> 7; "51% chapter attendance required (8 bros)" -> 8; "Requesting 25% attendance (4)" -> 4; "Need 2 brothers minimum" -> 2; "(2 people)" -> 2; "Let's try for a minimum 6 bros. per probate" applies 6 to every probate slot under it; "(they requested 10)" -> 10. Point tiers ("10 POINTS - send at least 25% of members (4)", "15 POINTS ... (8)") -> requiredCount is the lowest tier's headcount (4); put all tiers in requiredRaw. If only a percentage is given, leave requiredCount null and keep requiredRaw.

DIRECTOR GOALS: each "Goals for next meeting" block, with the officer/director(s) who own that section (names in parentheses on the section header, or the officer named on the VP header).

SUMMARY: 6-10 one-line takeaways, each under 15 words, no fines/dues, with the date the item stops mattering. Only items still relevant on or after the meeting date. One-line takeaways for brothers, ranked: high = deadlines/required attendance in the next 7 days, elections, anything with consequences; med = upcoming plans needing sign-ups; low = FYI.

PRIVACY (strict): never output fines, dues, debts, amounts owed by any person, phone numbers, or personal email addresses. Do not create events or summary items about fines/dues.`;

const toolSchema = (() => {
  const s = z.toJSONSchema(ExtractionSchema) as Record<string, unknown>;
  delete s.$schema;
  return s;
})();

export async function extractMinutes(text: string, today = new Date(), glossaryBlock = ''): Promise<Extraction> {
  if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const stream = client.messages.stream({
    model: config.model,
    max_tokens: 16000,
    system: SYSTEM + glossaryBlock,
    tools: [
      {
        name: 'save_minutes',
        description: 'Save the structured extraction of the meeting minutes.',
        input_schema: toolSchema as Anthropic.Tool['input_schema'],
      },
    ],
    tool_choice: { type: 'tool', name: 'save_minutes' },
    messages: [
      {
        role: 'user',
        content: `Today is ${today.toDateString()}.\n\n<minutes>\n${text}\n</minutes>`,
      },
    ],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'max_tokens') throw new Error('Extraction hit max_tokens; minutes too long for one pass');
  const block = msg.content.find((b) => b.type === 'tool_use');
  if (!block || block.type !== 'tool_use') throw new Error('Model did not return a tool call');
  const parsed = ExtractionSchema.safeParse(block.input);
  if (!parsed.success) throw new Error(`Extraction failed validation: ${parsed.error.message}`);
  return parsed.data;
}

export function eventId(e: Pick<ExtractedEvent, 'title' | 'date'>): string {
  const slug = e.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${e.date ?? 'nodate'}-${slug}`;
}
