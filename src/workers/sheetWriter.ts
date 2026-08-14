import { getAccessToken } from './auth';
import type { Config } from './config';
import type { Sprint, JiraIssue } from './fieldExtractor';
import { columnLetterToIndex, indexToColumnLetter, pickSprint, extractField } from './fieldExtractor';

export interface SheetInfo {
  sheetId: number;
  title: string;
}

async function apiFetch(token: string, url: string, options: RequestInit = {}): Promise<unknown> {
  let backoffMs = 1000;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    if (res.ok) return res.json();
    // 429 RESOURCE_EXHAUSTED: quota was rejected before the request was applied, so retrying is safe.
    if (res.status === 429 && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, backoffMs * (0.9 + Math.random() * 0.2))); // jitter: concurrent callers don't retry in lockstep
      backoffMs *= 2;
      continue;
    }
    const text = await res.text();
    throw new Error(`Sheets API ${res.status}: ${text}`);
  }
}

export function sprintSheetName(sprint: Sprint): string {
  const safeName = String(sprint.name ?? '').replace(/[\[\]:\\/?*]/g, '-');
  return `${sprint.id}_${safeName}`.slice(0, 100);
}

export async function getSheets(spreadsheetId: string, token: string): Promise<SheetInfo[]> {
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
  sheets: SheetInfo[],
): Promise<SheetInfo> {
  const target = sprintSheetName(sprint);
  const prefix = sprint.id + '_';

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
        return { sheetId: sheet.sheetId, title: target };
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

async function readKeyColumns(
  spreadsheetId: string,
  sheetTitles: string[],
  column: string,
  token: string,
): Promise<Map<string, string[]>> {
  const params = new URLSearchParams();
  for (const t of sheetTitles) {
    params.append('ranges', `${t}!${column}:${column}`);
  }
  // Strict: a failed key read must throw, not silently return empty — a page batch writes up to
  // 100 rows based on these keys, and treating them as empty would duplicate every row.
  const data = await apiFetch(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet?${params}`,
  ) as { valueRanges?: Array<{ values?: string[][] }> };
  const map = new Map<string, string[]>();
  sheetTitles.forEach((title, i) => {
    map.set(title, (data.valueRanges?.[i]?.values ?? []).map(r => r[0] ?? ''));
  });
  return map;
}

function findRowIndex(values: string[], issueKey: string, headerRows: number): number | null {
  for (let i = headerRows; i < values.length; i++) {
    if (values[i] === issueKey) return i + 1;
  }
  return null;
}

function buildRowMap(issue: JiraIssue, config: Config, row: number): Map<number, string> {
  const map = new Map<number, string>();
  for (const [letter, fieldName] of Object.entries(config.COLUMN_MAP)) {
    const col = columnLetterToIndex(letter);
    map.set(col, extractField(fieldName, issue, config, row));
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

export interface TabRename {
  sheetId: number;
  title: string;
}

// Renames all mismatched sprint tabs in ONE batchUpdate (same batched pattern as the
// page sync). No-op on an empty list so the sweep costs zero requests when nothing changed.
export async function renameSprintTabs(
  spreadsheetId: string,
  renames: TabRename[],
  token: string,
): Promise<void> {
  if (renames.length === 0) return;
  await apiFetch(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      method: 'POST',
      body: JSON.stringify({
        requests: renames.map((r) => ({
          updateSheetProperties: {
            properties: { sheetId: r.sheetId, title: r.title },
            fields: 'title',
          },
        })),
      }),
    },
  );
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

  const allSheets = await getSheets(spreadsheetId, token);
  const sheet = await getOrCreateSprintSheet(spreadsheetId, sprint, token, config, allSheets);

  const others = allSheets.filter(
    (s) => s.title !== config.TEMPLATE_SHEET && /^\d+_/.test(s.title) && s.sheetId !== sheet.sheetId,
  );
  const targets = [...others.map((s) => s.title), sheet.title];
  const keyCols = await readKeyColumns(spreadsheetId, targets, config.KEY_COLUMN, token);

  for (const s of others) {
    const row = findRowIndex(keyCols.get(s.title) ?? [], issue.key, config.HEADER_ROWS);
    if (row !== null) {
      await deleteRowByIndex(spreadsheetId, s.sheetId, row, token);
    }
  }

  const keyCol = keyCols.get(sheet.title) ?? [];
  let row = findRowIndex(keyCol, issue.key, config.HEADER_ROWS);
  if (row === null) {
    row = Math.max(keyCol.length, config.HEADER_ROWS) + 1;
  }

  const colMap = buildRowMap(issue, config, row);
  await writeRowRange(spreadsheetId, sheet.title, row, colMap, token);
}

export interface SprintPageResult {
  rowsWritten: number;
}

// Batched page sync for the DO alarm chain: one metadata read, one key-column batchGet per
// sprint group, ONE values:batchUpdate for every row in the page, and ONE batchUpdate for all
// stale-row deletes. That keeps a page tick at ~5 subrequests (Free plan caps 50/invocation)
// and avoids parsing the spreadsheet metadata once per issue.
export async function syncSprintPage(
  spreadsheetId: string,
  issues: JiraIssue[],
  token: string,
  config: Config,
): Promise<SprintPageResult> {
  if (issues.length === 0) return { rowsWritten: 0 };

  // Group before any sheet I/O so a page with no sprinted issues costs zero requests. The JQL is
  // sprint-filtered, so this is normally one group; an issue in two active sprints can still land
  // elsewhere (same accepted trade-off as the webhook path).
  const groups = new Map<number, { sprint: Sprint; issues: JiraIssue[] }>();
  for (const issue of issues) {
    const sprint = pickSprint(issue.fields[config.CUSTOM_FIELDS.sprint]);
    if (!sprint) {
      console.log(`Skipped ${issue.key}: no sprint`);
      continue;
    }
    const group = groups.get(sprint.id);
    if (group) group.issues.push(issue);
    else groups.set(sprint.id, { sprint, issues: [issue] });
  }
  if (groups.size === 0) return { rowsWritten: 0 };

  const allSheets = await getSheets(spreadsheetId, token);
  const sprintTabs = allSheets.filter((s) => s.title !== config.TEMPLATE_SHEET && /^\d+_/.test(s.title));

  const updates: Array<{ range: string; values: string[][] }> = [];
  const deletes: Array<{ sheetId: number; row: number }> = [];

  for (const { sprint, issues: groupIssues } of groups.values()) {
    const sheet = await getOrCreateSprintSheet(spreadsheetId, sprint, token, config, allSheets);
    const others = sprintTabs.filter((s) => s.sheetId !== sheet.sheetId);
    const targets = [...others.map((s) => s.title), sheet.title];
    const keyCols = await readKeyColumns(spreadsheetId, targets, config.KEY_COLUMN, token);

    const ownKeys = keyCols.get(sheet.title) ?? [];
    let nextRow = Math.max(ownKeys.length, config.HEADER_ROWS) + 1;
    const pending = new Set<string>(); // keys already assigned a fresh row in this page (in-page dedup)

    for (const issue of groupIssues) {
      let row = findRowIndex(ownKeys, issue.key, config.HEADER_ROWS);
      if (row === null && !pending.has(issue.key)) {
        row = nextRow++;
        pending.add(issue.key);
      }
      if (row === null) continue; // duplicate key within the page; the first copy is already queued

      const colMap = buildRowMap(issue, config, row);
      const cols = [...colMap.keys()].sort((a, b) => a - b);
      const minCol = cols[0];
      const maxCol = cols[cols.length - 1];
      const values = new Array(maxCol - minCol + 1).fill('');
      for (const [col, val] of colMap) values[col - minCol] = val;
      updates.push({
        range: `${sheet.title}!${indexToColumnLetter(minCol)}${row}:${indexToColumnLetter(maxCol)}${row}`,
        values: [values],
      });

      for (const other of others) {
        const staleRow = findRowIndex(keyCols.get(other.title) ?? [], issue.key, config.HEADER_ROWS);
        if (staleRow !== null) deletes.push({ sheetId: other.sheetId, row: staleRow });
      }
    }
  }

  if (updates.length > 0) {
    await apiFetch(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`,
      {
        method: 'POST',
        body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: updates }),
      },
    );
  }

  if (deletes.length > 0) {
    // One batchUpdate per tab with rows DESCENDING: batchUpdate applies requests sequentially, so
    // deleting a lower row shifts higher ones up and original row indices only stay valid if the
    // highest rows go first. A page's issues occupy at most one row per tab, so each batch is ≤100
    // requests (within the API limit) and batches for different tabs never interact.
    const bySheet = new Map<number, number[]>();
    for (const d of deletes) {
      const rows = bySheet.get(d.sheetId) ?? [];
      rows.push(d.row);
      bySheet.set(d.sheetId, rows);
    }
    for (const [sheetId, rows] of bySheet) {
      const sorted = [...new Set(rows)].sort((a, b) => b - a);
      await apiFetch(
        token,
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
        {
          method: 'POST',
          body: JSON.stringify({
            requests: sorted.map((row) => ({
              deleteDimension: {
                range: { sheetId, dimension: 'ROWS', startIndex: row - 1, endIndex: row },
              },
            })),
          }),
        },
      );
    }
  }

  return { rowsWritten: updates.length };
}

export async function deleteIssue(
  spreadsheetId: string,
  issue: JiraIssue,
  token: string,
  config: Config,
): Promise<void> {
  const sheets = await getSheets(spreadsheetId, token);

  const targets = sheets.filter((s) => s.title !== config.TEMPLATE_SHEET && /^\d+_/.test(s.title));
  if (targets.length === 0) return;
  const keyCols = await readKeyColumns(
    spreadsheetId,
    targets.map((s) => s.title),
    config.KEY_COLUMN,
    token,
  );

  for (const s of targets) {
    const row = findRowIndex(keyCols.get(s.title) ?? [], issue.key, config.HEADER_ROWS);
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

interface StoredToken {
  token: string;
  expiresAt: number;
}

// Durable-object variant: caches the OAuth token in DO storage (~1h validity, 60s headroom) so
// the RS256 JWT is signed at most once per hour instead of once per alarm tick (Free plan: 10ms
// CPU per invocation — JWT signing eats most of that budget).
export async function withStoredToken<T>(
  storage: DurableObjectStorage,
  email: string,
  privateKey: string,
  fn: (token: string) => Promise<T>,
): Promise<T> {
  const cached = await storage.get<StoredToken>('oauth_token');
  let token = cached && cached.expiresAt > Date.now() ? cached.token : undefined;
  if (!token) {
    token = await getAccessToken(email, privateKey);
    await storage.put('oauth_token', { token, expiresAt: Date.now() + 3_600_000 - 60_000 });
  }
  return fn(token);
}
