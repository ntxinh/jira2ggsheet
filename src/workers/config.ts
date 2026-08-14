import type { SyncCoordinator } from './syncCoordinator';

export interface Config {
  SPREADSHEET_ID: string;
  TEMPLATE_SHEET: string;
  KEY_COLUMN: string;
  HEADER_ROWS: number;
  DELETE_MODE: 'delete' | 'mark';
  PROJECT_KEY: string;
  SPRINT_IDS: string[]; // parsed from the comma-separated SPRINT_ID var
  JIRA_SUBDOMAIN: string;
  COLUMN_MAP: Record<string, string>;
  CUSTOM_FIELDS: {
    sprint: string;
    storyPoints: string;
  };
  DATE_FORMAT: string;
  TIMEZONE: string;
}

export interface Env {
  SECRET_TOKEN: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
  SPREADSHEET_ID: string;
  PROJECT_KEY: string;
  SPRINT_ID: string;
  JIRA_EMAIL: string;
  JIRA_API_TOKEN: string;
  JIRA_SUBDOMAIN: string;
  TEMPLATE_SHEET: string;
  KEY_COLUMN: string;
  HEADER_ROWS: string;
  DELETE_MODE: string;
  TIMEZONE: string;
  DATE_FORMAT: string;
  CUSTOM_FIELDS_SPRINT: string;
  CUSTOM_FIELDS_STORY_POINTS: string;
  COLUMN_MAP_JSON: string;
  SYNC_COORDINATOR: DurableObjectNamespace<SyncCoordinator>; // DO binding (wrangler.jsonc)
  SENTRY_DSN?: string;
  GOOGLE_CHAT_WEBHOOK?: string; // Google Chat incoming webhook; posts a notification per Jira webhook when set
}

// SPRINT_ID is a comma-separated list of sprint IDs (e.g. "690,691"); the cron syncs
// each one fully, one after another. Empty entries and whitespace are ignored.
export function parseSprintIds(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
}

export function getConfig(env: Env): Config {
  return {
    SPREADSHEET_ID: env.SPREADSHEET_ID,
    TEMPLATE_SHEET: env.TEMPLATE_SHEET,
    KEY_COLUMN: env.KEY_COLUMN,
    HEADER_ROWS: parseInt(env.HEADER_ROWS, 10),
    DELETE_MODE: env.DELETE_MODE as 'delete' | 'mark',
    PROJECT_KEY: env.PROJECT_KEY,
    SPRINT_IDS: parseSprintIds(env.SPRINT_ID),
    JIRA_SUBDOMAIN: env.JIRA_SUBDOMAIN,
    COLUMN_MAP: JSON.parse(env.COLUMN_MAP_JSON),
    CUSTOM_FIELDS: {
      sprint: env.CUSTOM_FIELDS_SPRINT,
      storyPoints: env.CUSTOM_FIELDS_STORY_POINTS,
    },
    DATE_FORMAT: env.DATE_FORMAT,
    TIMEZONE: env.TIMEZONE,
  };
}
