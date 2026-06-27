var CONFIG = {
  TEMPLATE_SHEET: 'Template',
  SPREADSHEET_ID: '',
  KEY_COLUMN: 'C',
  HEADER_ROWS: 1,
  DELETE_MODE: 'delete',
  PROJECT_KEY: 'ABC',
  SECRET_TOKEN: 'long-random-string',

  COLUMN_MAP: {
    A: 'sprintId',
    C: 'issueKey',
    D: 'issueType',
    E: 'priority',
    F: 'summary',
    G: 'status',
    L: 'createdDate',
    P: 'storyPoints',
    U: 'assignee',
  },

  CUSTOM_FIELDS: {
    sprint: 'customfield_10016',
    storyPoints: 'customfield_10021',
  },

  DATE_FORMAT: 'yyyy-MM-dd HH:mm',
  TIMEZONE: 'Asia/Ho_Chi_Minh',
};
