# Setup Guide

## 1. Create the sheet and Apps Script project

1. Open (or create) the target Google Sheet. Create a tab named `Template`
   (or change `TEMPLATE_SHEET` in the config to match). Add your header row and
   any column formatting to `Template` — per-sprint tabs are cloned from it
   automatically when an issue arrives. You do not need to create sprint tabs
   manually.
2. Menu: **Extensions → Apps Script**. This creates a script bound to the sheet.
3. In the editor, create one script file per file in `src/` (**+ → Script**) and
   paste the contents: `Config`, `FieldExtractor`, `SheetWriter`, `WebApp`, `Test`.
   (Local files are `.js`; the editor shows them as `.gs` — content is identical.)

## 2. Find your custom field IDs

Sprint and Story Points are custom fields whose IDs differ per Jira site.

1. Open in a browser (logged into Jira), replacing the issue key with any real issue:
   `https://YOURORG.atlassian.net/rest/api/2/issue/ABC-1?expand=names`
2. Search the JSON for `"Sprint"` and `"Story point"` inside the `names` block.
   The keys look like `customfield_10020`.
3. Put them in `Config`:

   ```javascript
   CUSTOM_FIELDS: {
     sprint: 'customfield_10020',
     storyPoints: 'customfield_10016',
   },
   ```

## 3. Edit the config

In the `Config` file set:

- `PROJECT_KEY` — your Jira project key (e.g. `ABC`)
- `TEMPLATE_SHEET` — the name of the template tab (default: `Template`); per-sprint tabs are cloned from it
- `SECRET_TOKEN` — a long random string. Generate one, e.g. in a terminal:
  `openssl rand -hex 32`
- `DELETE_MODE` — `'delete'` (remove the row when the issue is deleted) or
  `'mark'` (keep the row, write `Deleted` into the status column)
- `COLUMN_MAP` — adjust if your columns move. Letter → field name.
- `TIMEZONE` / `DATE_FORMAT` — for the Created Date column.

## 4. Run the editor tests

In the Apps Script editor select `testAll` in the function dropdown and **Run**.
First run asks for permissions — grant them. Expected log: `All editor tests passed`.

Optional: run `testIntegrationUpsert` to write a TEST-99999 row to the real
sheet, check it, then run `testIntegrationCleanup` to remove it.

## 5. Deploy the web app

1. **Deploy → New deployment → Select type: Web app**
2. Description: anything. **Execute as: Me**. **Who has access: Anyone**.
   ("Anyone" is required — Jira is not logged into your Google account.
   The secret token in the URL is what keeps strangers out.)
3. **Deploy**, then copy the **Web app URL** (ends in `/exec`).

> After every code change: **Deploy → Manage deployments → ✏️ Edit →
> Version: New version → Deploy**. This keeps the same URL. Creating a brand
> new deployment changes the URL and breaks the webhook.

## 6. Register the Jira webhook

1. Go to `https://YOURORG.atlassian.net/plugins/servlet/webhooks`
   (Jira admin: **Settings → System → WebHooks**).
2. **Create a WebHook**:
   - **Name:** `Sync to Google Sheet`
   - **URL:** the web app URL plus your token:
     `https://script.google.com/macros/s/DEPLOYMENT_ID/exec?token=YOUR_SECRET_TOKEN`
   - **Issue related events → JQL:** `project = ABC`
   - **Events:** check **Issue: created, updated, deleted**
3. **Create**.

## 7. Test end to end

1. Create an issue in the Jira project → a row should appear in the sheet
   within a few seconds.
2. Change its assignee or story points → the row updates.
3. Transition it (To Do → In Progress) → the status cell updates.
4. Check logs: Apps Script editor → **Executions** (left sidebar). Every
   webhook delivery shows up there with its console output.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No row appears, no execution logged | Webhook not firing: check the JQL filter and events in Jira's webhook page; Jira shows recent delivery attempts there. Also re-check the URL. |
| Execution logged, says "bad or missing token" | `?token=` in the webhook URL doesn't match `SECRET_TOKEN` in Config. |
| Execution logged, says "Ignored: project ..." | `PROJECT_KEY` doesn't match the issue's project. |
| Sprint or Story point column empty | Wrong custom field ID — redo step 2. |
| Row appears but Created Date looks wrong | Adjust `TIMEZONE` / `DATE_FORMAT` in Config. |
| Jira webhook page shows the delivery as failed/redirected | Apps Script answers with a 302 redirect; Jira follows it and treats delivery as OK. Failures with 4xx/5xx mean the URL is wrong. |
| Changed the code but behavior didn't change | You must publish a **new version** of the existing deployment (step 5 note). |
