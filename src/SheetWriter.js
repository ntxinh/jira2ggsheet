function sprintSheetName_(sprint) {
  const safeName = String(sprint.name == null ? '' : sprint.name).replace(/[\[\]:\\/?*]/g, '-');
  return (sprint.id + '_' + safeName).slice(0, 100);
}

function getSprintSheet_(sprint) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const target = sprintSheetName_(sprint);
  const prefix = sprint.id + '_';
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    const name = sheets[i].getName();
    if (name === CONFIG.TEMPLATE_SHEET) continue;
    if (name.indexOf(prefix) === 0) {
      if (name !== target) sheets[i].setName(target);
      return sheets[i];
    }
  }
  const template = ss.getSheetByName(CONFIG.TEMPLATE_SHEET);
  if (!template) throw new Error('Template tab not found: ' + CONFIG.TEMPLATE_SHEET);
  return template.copyTo(ss).setName(target);
}

function isSprintTab_(sheet) {
  if (sheet.getName() === CONFIG.TEMPLATE_SHEET) return false;
  return /^\d+_/.test(sheet.getName());
}

function removeKeyFromAllSprintTabs_(issueKey, exceptSheet) {
  const sheets = SpreadsheetApp.getActiveSpreadsheet().getSheets();
  for (let i = 0; i < sheets.length; i++) {
    const sheet = sheets[i];
    if (!isSprintTab_(sheet)) continue;
    if (exceptSheet && sheet.getName() === exceptSheet.getName()) continue;
    const row = findRowByKey_(sheet, issueKey);
    if (row) sheet.deleteRow(row);
  }
}

function findRowByKey_(sheet, issueKey) {
  const keyCol = columnLetterToIndex(CONFIG.KEY_COLUMN);
  const lastRow = sheet.getLastRow();
  if (lastRow <= CONFIG.HEADER_ROWS) return null;
  const numRows = lastRow - CONFIG.HEADER_ROWS;
  const values = sheet.getRange(CONFIG.HEADER_ROWS + 1, keyCol, numRows, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][0] === issueKey) return CONFIG.HEADER_ROWS + 1 + i;
  }
  return null;
}

function upsertIssue(issue) {
  const sprint = pickSprint(issue.fields[CONFIG.CUSTOM_FIELDS.sprint]);
  if (!sprint) {
    console.log('Skipped ' + issue.key + ': no sprint');
    return;
  }
  const sheet = getSprintSheet_(sprint);
  removeKeyFromAllSprintTabs_(issue.key, sheet);
  let row = findRowByKey_(sheet, issue.key);
  if (!row) row = Math.max(sheet.getLastRow(), CONFIG.HEADER_ROWS) + 1;
  for (const letter in CONFIG.COLUMN_MAP) {
    const value = extractField(CONFIG.COLUMN_MAP[letter], issue, CONFIG);
    sheet.getRange(row, columnLetterToIndex(letter)).setValue(value);
  }
}

function deleteIssue(issue) {
  const sheet = getSheet_();
  const row = findRowByKey_(sheet, issue.key);
  if (!row) return;
  if (CONFIG.DELETE_MODE === 'delete') {
    sheet.deleteRow(row);
  } else {
    sheet.getRange(row, statusColumnIndex_()).setValue('Deleted');
  }
}

function statusColumnIndex_() {
  for (const letter in CONFIG.COLUMN_MAP) {
    if (CONFIG.COLUMN_MAP[letter] === 'status') return columnLetterToIndex(letter);
  }
  throw new Error('DELETE_MODE "mark" requires a status column in COLUMN_MAP');
}
