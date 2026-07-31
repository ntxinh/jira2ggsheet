import type { Env } from '../config'

export const testEnv: Env = {
  SECRET_TOKEN: 'test-token',
  GOOGLE_SERVICE_ACCOUNT_EMAIL: 'test@test.iam.gserviceaccount.com',
  GOOGLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nMOCK\n-----END PRIVATE KEY-----',
  SPREADSHEET_ID: 'fake-spreadsheet-id',
  PROJECT_KEY: 'TEST',
  JIRA_SUBDOMAIN: 'acme',
  TEMPLATE_SHEET: 'Template',
  KEY_COLUMN: 'C',
  HEADER_ROWS: '1',
  DELETE_MODE: 'delete',
  TIMEZONE: 'UTC',
  DATE_FORMAT: 'yyyy-MM-dd',
  CUSTOM_FIELDS_SPRINT: 'customfield_10016',
  CUSTOM_FIELDS_STORY_POINTS: 'customfield_10021',
  COLUMN_MAP_JSON: '{"B":"issueKey","C":"issueLink","L":"labels"}',
}
