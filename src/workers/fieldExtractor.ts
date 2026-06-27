import type { Config } from './config';

export interface Sprint {
  id: number;
  name: string;
  state: string;
}

export function columnLetterToIndex(letter: string): number {
  const upper = letter.toUpperCase();
  let index = 0;
  for (let i = 0; i < upper.length; i++) {
    const code = upper.charCodeAt(i);
    if (code < 65 || code > 90) throw new Error('Invalid column letter: ' + letter);
    index = index * 26 + (code - 64);
  }
  if (index === 0) throw new Error('Invalid column letter: ' + letter);
  return index;
}

export function indexToColumnLetter(index: number): string {
  let letter = '';
  while (index > 0) {
    index--;
    letter = String.fromCharCode(65 + (index % 26)) + letter;
    index = Math.floor(index / 26);
  }
  return letter;
}

function parseSprint(entry: unknown): Sprint | null {
  if (entry == null) return null;
  if (typeof entry === 'object') {
    const e = entry as Record<string, unknown>;
    if (e.id == null) return null;
    return {
      id: Number(e.id),
      name: e.name == null ? '' : String(e.name),
      state: String(e.state || '').toLowerCase(),
    };
  }
  if (typeof entry === 'string') {
    const idMatch = entry.match(/\bid=(\d+)/);
    if (!idMatch) return null;
    const stateMatch = entry.match(/\bstate=(\w+)/);
    const nameMatch = entry.match(/\bname=([^,\]]+)/);
    return {
      id: Number(idMatch[1]),
      name: nameMatch ? nameMatch[1] : '',
      state: stateMatch ? stateMatch[1].toLowerCase() : '',
    };
  }
  return null;
}

export function pickSprint(sprintField: unknown): Sprint | null {
  if (!Array.isArray(sprintField) || sprintField.length === 0) return null;
  const sprints = sprintField.map(parseSprint).filter((s): s is Sprint => s !== null);
  if (sprints.length === 0) return null;
  const active = sprints.find((s) => s.state === 'active');
  return active || sprints[sprints.length - 1];
}

export function pickSprintId(sprintField: unknown): string {
  const sprint = pickSprint(sprintField);
  return sprint ? String(sprint.id) : '';
}

function formatJiraDate(isoString: string | null | undefined, config: Config): string {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

export interface JiraIssue {
  key: string;
  fields: Record<string, unknown>;
}

export const EXTRACTORS: Record<string, (issue: JiraIssue, config: Config) => string> = {
  issueKey: (issue) => issue.key,
  issueType: (issue) => (issue.fields.issuetype as Record<string, unknown> | undefined)?.name as string ?? '',
  priority: (issue) => (issue.fields.priority as Record<string, unknown> | undefined)?.name as string ?? '',
  summary: (issue) => String(issue.fields.summary ?? ''),
  status: (issue) => (issue.fields.status as Record<string, unknown> | undefined)?.name as string ?? '',
  createdDate: (issue, config) => formatJiraDate(issue.fields.created as string, config),
  storyPoints: (issue, config) => {
    const v = issue.fields[config.CUSTOM_FIELDS.storyPoints];
    return v == null ? '' : String(v);
  },
  assignee: (issue) => (issue.fields.assignee as Record<string, unknown> | undefined)?.displayName as string ?? '',
  sprintId: (issue, config) => pickSprintId(issue.fields[config.CUSTOM_FIELDS.sprint]),
};

export function extractField(name: string, issue: JiraIssue, config: Config): string {
  const fn = EXTRACTORS[name];
  if (!fn) {
    console.log('Unknown extractor in COLUMN_MAP: ' + name);
    return '';
  }
  try {
    const value = fn(issue, config);
    return value == null ? '' : String(value);
  } catch (err) {
    console.log('Extractor "' + name + '" failed: ' + err);
    return '';
  }
}
