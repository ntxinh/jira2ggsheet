import { getAccessToken } from './auth';
import type { Config } from './config';
import type { Sprint, JiraIssue } from './fieldExtractor';
import { columnLetterToIndex, indexToColumnLetter, pickSprint, extractField } from './fieldExtractor';

interface SheetInfo {
  sheetId: number;
  title: string;
}

async function apiFetch(token: string, url: string, options: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sheets API ${res.status}: ${text}`);
  }
  return res.json();
}

function sprintSheetName(sprint: Sprint): string {
  const safeName = String(sprint.name ?? '').replace(/[\[\]:\\/?*]/g, '-');
  return `${sprint.id}_${safeName}`.slice(0, 100);
}

async function getSheets(spreadsheetId: string, token: string): Promise<SheetInfo[]> {
  const data = await apiFetch(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`,
  ) as { sheets: Array<{ properties: { sheetId: number; title: string } }> };
  return data.sheets.map(s => ({ sheetId: s.properties.sheetId, title: s.properties.title }));
}

async function getOrCreateSprintSheet(
  spreadsheetId: string,
  sprint: Sprint,
  token: string,
  config: Config,
): Promise<SheetInfo> {
  const target = sprintSheetName(sprint);
  const prefix = sprint.id + '_';
  const sheets = await getSheets(spreadsheetId, token);

  for (const sheet of sheets) {
    if (sheet.title === config.TEMPLATE_SHEET) continue;
    if (sheet.title.startsWith(prefix)) {
      if (sheet.title !== target) {
        await apiFetch(
          token,
          `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
          {
            method: 'POST',
            body: JSON.stringify({
              requests: [{
                updateSheetProperties: {
                  properties: { sheetId: sheet.sheetId, title: target },
                  fields: 'title',
                },
              }],
            }),
          },
        );
      }
      return sheet;
    }
  }

  const template = sheets.find(s => s.title === config.TEMPLATE_SHEET);
  if (!template) throw new Error(`Template tab "${config.TEMPLATE_SHEET}" not found`);

  const dupResult = await apiFetch(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      method: 'POST',
      body: JSON.stringify({
        requests: [{
          duplicateSheet: {
            sourceSheetId: template.sheetId,
            newSheetName: target,
          },
        }],
      }),
    },
  ) as { replies: Array<{ duplicateSheet: { properties: { sheetId: number; title: string } } }> };

  return {
    sheetId: dupResult.replies[0].duplicateSheet.properties.sheetId,
    title: dupResult.replies[0].duplicateSheet.properties.title,
  };
}

async function readColumn(
  spreadsheetId: string,
  sheetTitle: string,
  column: string,
  token: string,
): Promise<string[]> {
  const range = encodeURIComponent(`${sheetTitle}!${column}:${column}`);
  const data = await apiFetch(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`,
  ).catch(() => ({ values: [] as string[][] })) as { values?: string[][] };
  return (data.values ?? []).map(r => r[0] ?? '');
}

function findRowIndex(values: string[], issueKey: string, headerRows: number): number | null {
  for (let i = headerRows; i < values.length; i++) {
    if (values[i] === issueKey) return i + 1;
  }
  return null;
}

function buildRowMap(issue: JiraIssue, config: Config): Map<number, string> {
  const map = new Map<number, string>();
  for (const [letter, fieldName] of Object.entries(config.COLUMN_MAP)) {
    const col = columnLetterToIndex(letter);
    map.set(col, extractField(fieldName, issue, config));
  }
  return map;
}

async function writeRowRange(
  spreadsheetId: string,
  sheetTitle: string,
  row: number,
  colMap: Map<number, string>,
  token: string,
): Promise<void> {
  const cols = [...colMap.keys()].sort((a, b) => a - b);
  const minCol = cols[0];
  const maxCol = cols[cols.length - 1];
  const values = new Array(maxCol - minCol + 1).fill('');
  for (const [col, val] of colMap) {
    values[col - minCol] = val;
  }
  const range = encodeURIComponent(
    `${sheetTitle}!${indexToColumnLetter(minCol)}${row}:${indexToColumnLetter(maxCol)}${row}`,
  );
  await apiFetch(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`,
    { method: 'PUT', body: JSON.stringify({ values: [values] }) },
  );
}

async function deleteRowByIndex(
  spreadsheetId: string,
  sheetId: number,
  row: number,
  token: string,
): Promise<void> {
  await apiFetch(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      method: 'POST',
      body: JSON.stringify({
        requests: [{
          deleteDimension: {
            range: { sheetId, dimension: 'ROWS', startIndex: row - 1, endIndex: row },
          },
        }],
      }),
    },
  );
}

async function markStatus(
  spreadsheetId: string,
  sheetTitle: string,
  row: number,
  token: string,
  config: Config,
): Promise<void> {
  for (const [letter, name] of Object.entries(config.COLUMN_MAP)) {
    if (name !== 'status') continue;
    const range = encodeURIComponent(`${sheetTitle}!${letter}${row}`);
    await apiFetch(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=RAW`,
      { method: 'PUT', body: JSON.stringify({ values: [['Deleted']] }) },
    );
    return;
  }
  throw new Error('DELETE_MODE "mark" requires a status column in COLUMN_MAP');
}

export async function upsertIssue(
  spreadsheetId: string,
  issue: JiraIssue,
  token: string,
  config: Config,
): Promise<void> {
  const sprint = pickSprint(issue.fields[config.CUSTOM_FIELDS.sprint]);
  if (!sprint) {
    console.log(`Skipped ${issue.key}: no sprint`);
    return;
  }

  const sheet = await getOrCreateSprintSheet(spreadsheetId, sprint, token, config);

  const allSheets = await getSheets(spreadsheetId, token);
  for (const s of allSheets) {
    if (s.title === config.TEMPLATE_SHEET) continue;
    if (!/^\d+_/.test(s.title)) continue;
    if (s.sheetId === sheet.sheetId) continue;
    const keyCol = await readColumn(spreadsheetId, s.title, config.KEY_COLUMN, token);
    const row = findRowIndex(keyCol, issue.key, config.HEADER_ROWS);
    if (row !== null) {
      await deleteRowByIndex(spreadsheetId, s.sheetId, row, token);
    }
  }

  const keyCol = await readColumn(spreadsheetId, sheet.title, config.KEY_COLUMN, token);
  let row = findRowIndex(keyCol, issue.key, config.HEADER_ROWS);
  if (row === null) {
    row = Math.max(keyCol.length, config.HEADER_ROWS) + 1;
  }

  const colMap = buildRowMap(issue, config);
  await writeRowRange(spreadsheetId, sheet.title, row, colMap, token);
}

export async function deleteIssue(
  spreadsheetId: string,
  issue: JiraIssue,
  token: string,
  config: Config,
): Promise<void> {
  const sheets = await getSheets(spreadsheetId, token);

  for (const s of sheets) {
    if (s.title === config.TEMPLATE_SHEET) continue;
    if (!/^\d+_/.test(s.title)) continue;
    const keyCol = await readColumn(spreadsheetId, s.title, config.KEY_COLUMN, token);
    const row = findRowIndex(keyCol, issue.key, config.HEADER_ROWS);
    if (row === null) continue;

    if (config.DELETE_MODE === 'delete') {
      await deleteRowByIndex(spreadsheetId, s.sheetId, row, token);
    } else {
      await markStatus(spreadsheetId, s.title, row, token, config);
    }
  }
}

export async function withToken(
  email: string,
  privateKey: string,
  fn: (token: string) => Promise<void>,
): Promise<void> {
  const token = await getAccessToken(email, privateKey);
  await fn(token);
}
