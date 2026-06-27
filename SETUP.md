# Setup Guide

Two deployment options. **Cloudflare Worker is recommended** — faster cold starts,
type-safe, no Google Apps Script quota limits.

---

## Option A: Cloudflare Worker (recommended)

### Prerequisites

- [Node.js 18+](https://nodejs.org)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler` or use the project's local copy)
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- A [Google Cloud service account](https://console.cloud.google.com/apis/credentials) with
  the Google Sheets API enabled and the spreadsheet shared with its email as **Editor**

### 1. Create the Google Sheet

1. Create (or open) the target Google Sheet.
2. Create a tab named `Template` (or change `TEMPLATE_SHEET` in config).
   Add your header row and any column formatting — per-sprint tabs are cloned
   from it automatically.
3. Note the **Spreadsheet ID** — the part between `/d/` and `/edit` in the URL.

### 2. Set up a Google Cloud service account

1. Go to [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials).
2. Create a **Service Account** (no role needed), then generate a **JSON key**.
3. Enable the **Google Sheets API** for your project.
4. Share your target Google Sheet with the service account email as **Editor**.
5. Keep the private key handy — you'll paste it into a Worker secret.

### 3. Find your custom field IDs

Sprint and Story Points are custom fields whose IDs differ per Jira site.

1. Open in a browser (logged into Jira), replacing the issue key with any real issue:
   `https://YOURORG.atlassian.net/rest/api/2/issue/ABC-1?expand=names`
2. Search the JSON for `"Sprint"` and `"Story point"` inside the `names` block.
   The keys look like `customfield_10020`.
3. Update `CUSTOM_FIELDS_SPRINT` and `CUSTOM_FIELDS_STORY_POINTS` in
   `src/workers/wrangler.jsonc` (or override them later via wrangler).

### 4. Configure and deploy

```bash
cd src/workers
npm install
```

Set required secrets:

```bash
npx wrangler secret put SECRET_TOKEN
# Paste: a long random string, e.g. openssl rand -hex 32

npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL
# Paste: your-service-account@project.iam.gserviceaccount.com

npx wrangler secret put GOOGLE_PRIVATE_KEY
# Paste: the full private key from the JSON key file (include the PEM markers)

npx wrangler secret put SPREADSHEET_ID
# Paste: the ID from step 1
```

Adjust variables in `wrangler.jsonc` if needed (`PROJECT_KEY`, `TEMPLATE_SHEET`,
`COLUMN_MAP_JSON`, `CUSTOM_FIELDS_*`, `TIMEZONE`, `DELETE_MODE`), then deploy:

```bash
npx wrangler deploy
```

Copy the **deployed Worker URL** (printed at the end of `deploy`).

### 5. Register the Jira webhook

1. Go to `https://YOURORG.atlassian.net/plugins/servlet/webhooks`
   (Jira admin: **Settings → System → WebHooks**).
2. **Create a WebHook**:
   - **Name:** `Sync to Google Sheet`
   - **URL:** your Worker URL plus the token:
     `https://jira2ggsheet.YOUR-ACCOUNT.workers.dev?token=YOUR_SECRET_TOKEN`
   - **Issue related events → JQL:** `project = ABC`
   - **Events:** check **Issue: created, updated, deleted**
3. **Create**.

### 6. Test end to end

1. Create an issue in the Jira project and assign it to a sprint → a row should
   appear in that sprint's tab within a few seconds.
2. Check Worker logs: `npx wrangler tail` or Cloudflare Dashboard → Workers → jira2ggsheet → Logs.

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No row appears | Webhook not firing: check JQL filter and events in Jira's webhook page; Jira shows delivery attempts there. Re-check the Worker URL and token. |
| Worker logs "bad or missing token" | `?token=` in the webhook URL doesn't match `SECRET_TOKEN`. |
| Worker logs "Ignored: project ..." | `PROJECT_KEY` in `wrangler.jsonc` doesn't match the issue's project. |
| Google Sheets API 403 | The service account email must have **Editor** access on the sheet. |
| Service account JWT auth fails | `GOOGLE_PRIVATE_KEY` must include the `-----BEGIN/END PRIVATE KEY-----` markers and line breaks (`\n`). |

---

## Option B: Google Apps Script (legacy backup)

### 1. Create the sheet and Apps Script project

1. Open (or create) the target Google Sheet. Create a tab named `Template`
   (or change `TEMPLATE_SHEET` in the config to match). Add your header row and
   any column formatting to `Template` — per-sprint tabs are cloned from it
   automatically when an issue arrives. You do not need to create sprint tabs
   manually.
2. Menu: **Extensions → Apps Script**. This creates a script bound to the sheet.
3. In the editor, create one script file per file in `src/gas/` (**+ → Script**) and
   paste the contents: `Config`, `FieldExtractor`, `SheetWriter`, `WebApp`, `Test`.
   (Local files are `.js`; the editor shows them as `.gs` — content is identical.)

### 2. Find your custom field IDs

Same as Option A step 3.

### 3. Edit the config

In the `Config` file set:

- `PROJECT_KEY` — your Jira project key (e.g. `ABC`)
- `TEMPLATE_SHEET` — the name of the template tab (default: `Template`); per-sprint tabs are cloned from it
- `SPREADSHEET_ID` — optional. Leave empty for a script bound to the target
  sheet. Set it when the Apps Script project is owned by a different Gmail than
  the sheet owner, or when the script is standalone. Copy the ID from the sheet
  URL: the part between `/d/` and `/edit`.
- `SECRET_TOKEN` — a long random string. Generate one, e.g. in a terminal:
  `openssl rand -hex 32`
- `DELETE_MODE` — `'delete'` (remove the row when the issue is deleted) or
  `'mark'` (keep the row, write `Deleted` into the status column)
- `COLUMN_MAP` — adjust if your columns move. Letter → field name.
- `TIMEZONE` / `DATE_FORMAT` — for the Created Date column.

### 4. Run the editor tests

In the Apps Script editor select `testAll` in the function dropdown and **Run**.
First run asks for permissions — grant them. Expected log: `All editor tests passed`.

Optional: run `testIntegrationUpsert` to write a TEST-99999 row to the real
sheet, check it, then run `testIntegrationCleanup` to remove it.

### 5. Deploy the web app

1. **Deploy → New deployment → Select type: Web app**
2. Description: anything. **Execute as: Me**. **Who has access: Anyone**.
   ("Anyone" is required — Jira is not logged into your Google account.
   The secret token in the URL is what keeps strangers out.)
3. **Deploy**, then copy the **Web app URL** (ends in `/exec`).

> After every code change: **Deploy → Manage deployments → ✏️ Edit →
> Version: New version → Deploy**. This keeps the same URL. Creating a brand
> new deployment changes the URL and breaks the webhook.

#### Two Gmail accounts

If the Google Sheet owner and Apps Script owner are different accounts:

1. The sheet owner must share the target sheet with the Apps Script owner as
   **Editor**.
2. The Apps Script owner sets `SPREADSHEET_ID` in `Config`.
3. The Apps Script owner deploys the web app with **Execute as: Me**.

Without editor access, `SpreadsheetApp.openById` cannot write to the sheet.

### 6. Register the Jira webhook

1. Go to `https://YOURORG.atlassian.net/plugins/servlet/webhooks`
   (Jira admin: **Settings → System → WebHooks**).
2. **Create a WebHook**:
   - **Name:** `Sync to Google Sheet`
   - **URL:** the web app URL plus your token:
     `https://script.google.com/macros/s/DEPLOYMENT_ID/exec?token=YOUR_SECRET_TOKEN`
   - **Issue related events → JQL:** `project = ABC`
   - **Events:** check **Issue: created, updated, deleted**
3. **Create**.

### 7. Test end to end

1. Create an issue in the Jira project and assign it to a sprint → a row should
   appear in that sprint's tab within a few seconds.
2. Change its assignee or story points → the row updates.
3. Transition it (To Do → In Progress) → the status cell updates.
4. Check logs: Apps Script editor → **Executions** (left sidebar). Every
   webhook delivery shows up there with its console output.

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No row appears, no execution logged | Webhook not firing: check the JQL filter and events in Jira's webhook page; Jira shows recent delivery attempts there. Also re-check the URL. |
| Execution logged, says "bad or missing token" | `?token=` in the webhook URL doesn't match `SECRET_TOKEN` in Config. |
| Execution logged, says "Ignored: project ..." | `PROJECT_KEY` doesn't match the issue's project. |
| Sprint or Story point column empty | Wrong custom field ID — redo step 2. |
| Row appears but Created Date looks wrong | Adjust `TIMEZONE` / `DATE_FORMAT` in Config. |
| Jira webhook page shows the delivery as failed/redirected | Apps Script answers with a 302 redirect; Jira follows it and treats delivery as OK. Failures with 4xx/5xx mean the URL is wrong. |
| Changed the code but behavior didn't change | You must publish a **new version** of the existing deployment (step 5 note). |
