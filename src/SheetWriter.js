function getSheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) throw new Error('Sheet tab not found: ' + CONFIG.SHEET_NAME);
  return sheet;
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
  const sheet = getSheet_();
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
