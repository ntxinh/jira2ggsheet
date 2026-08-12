import type { Env } from '../config'
import type { SyncCoordinator, SyncStatus, KickResult } from '../syncCoordinator'

// Fake Durable Object namespace for tests. Override kick/getStatus per test via
// makeCoordinatorNamespace to control the DO's behavior without a real DO runtime.
export function makeCoordinatorNamespace(overrides: {
  kick?: (sprintId?: string) => Promise<KickResult>
  getStatus?: () => Promise<SyncStatus>
} = {}): DurableObjectNamespace<SyncCoordinator> {
  const kick = overrides.kick ?? (async () => ({ status: 'started', sprintId: '42' }))
  const getStatus = overrides.getStatus ?? (async () => ({ running: false }))
  return {
    idFromName: () => 'test-coordinator',
    get: () => ({ kick, getStatus }),
  } as unknown as DurableObjectNamespace<SyncCoordinator>
}

export const testEnv: Env = {
  SECRET_TOKEN: 'test-token',
  GOOGLE_SERVICE_ACCOUNT_EMAIL: 'test@test.iam.gserviceaccount.com',
  GOOGLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nMOCK\n-----END PRIVATE KEY-----',
  SPREADSHEET_ID: 'fake-spreadsheet-id',
  PROJECT_KEY: 'TEST',
  SPRINT_ID: '42',
  JIRA_EMAIL: 'jira@example.com',
  JIRA_API_TOKEN: 'jira-token',
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
  SYNC_COORDINATOR: makeCoordinatorNamespace(),
}
