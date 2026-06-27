export interface Config {
  SPREADSHEET_ID: string;
  TEMPLATE_SHEET: string;
  KEY_COLUMN: string;
  HEADER_ROWS: number;
  DELETE_MODE: 'delete' | 'mark';
  PROJECT_KEY: string;
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
  TEMPLATE_SHEET: string;
  KEY_COLUMN: string;
  HEADER_ROWS: string;
  DELETE_MODE: string;
  TIMEZONE: string;
  DATE_FORMAT: string;
  CUSTOM_FIELDS_SPRINT: string;
  CUSTOM_FIELDS_STORY_POINTS: string;
  COLUMN_MAP_JSON: string;
}

export function getConfig(env: Env): Config {
  return {
    SPREADSHEET_ID: env.SPREADSHEET_ID,
    TEMPLATE_SHEET: env.TEMPLATE_SHEET,
    KEY_COLUMN: env.KEY_COLUMN,
    HEADER_ROWS: parseInt(env.HEADER_ROWS, 10),
    DELETE_MODE: env.DELETE_MODE as 'delete' | 'mark',
    PROJECT_KEY: env.PROJECT_KEY,
    COLUMN_MAP: JSON.parse(env.COLUMN_MAP_JSON),
    CUSTOM_FIELDS: {
      sprint: env.CUSTOM_FIELDS_SPRINT,
      storyPoints: env.CUSTOM_FIELDS_STORY_POINTS,
    },
    DATE_FORMAT: env.DATE_FORMAT,
    TIMEZONE: env.TIMEZONE,
  };
}
