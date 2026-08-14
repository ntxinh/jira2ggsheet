# Architecture — `src/workers`

Diagrams for the Cloudflare Worker that syncs Jira issues into a Google Spreadsheet (one tab per sprint).

## 1. System architecture

```mermaid
flowchart LR
    subgraph External
        J[Jira / Jira Agile API]
        GC[Google Sheets API]
        CT[Google Chat space]
        OAUTH[Google OAuth2 token endpoint]
    end

    subgraph Worker[Cloudflare Worker]
        H[Hono entry<br/>index.ts]
        CH[chat.ts<br/>postChatNotification]
        CO[SyncCoordinator DO<br/>syncCoordinator.ts]
        ST[sheetWriter.ts<br/>upsert/delete/sync page]
        JR[jira.ts<br/>searchIssuesPage / fetchSprintName]
        AU[auth.ts<br/>getAccessToken]
        FE[fieldExtractor.ts<br/>pickSprint / extractField]
    end

    subgraph Config[Config & storage]
        CFG[config.ts<br/>Env + getConfig]
        DOST[DO SQLite storage<br/>sync cursor + OAuth token]
    end

    H -- "webhooks POST /" --> CH
    H -- "webhooks POST /" --> ST
    H -- "GET /sync, cron */5" --> CO
    CO -- "per-tick: 1 Jira page" --> JR
    CO -- "per-tick: batched write" --> ST
    CO <-- "cursor + oauth_token" --> DOST
    JR --> J
    JR --> CFG
    ST --> GC
    ST --> AU
    ST --> FE
    AU --> OAUTH
    CH --> CT
    CH --> CFG
```

## 2. Full-sprint sync — alarm chain sequence

The `*/5` cron and `GET /sync` both `kick()` the single named DO instance; the alarm chain then processes **one Jira page (100 issues) per tick**, ~3s apart, to stay under the Free plan's 10ms CPU budget.

```mermaid
sequenceDiagram
    actor Cron as Cron */5
    participant CO as SyncCoordinator DO
    participant DOST as DO storage
    participant JR as jira.ts
    participant ST as sheetWriter.ts
    actor GS as Google Sheets API

    Cron->>CO: kick() [no arg → SPRINT_ID list]
    CO->>DOST: get('sync')
    alt already running and fresh (< STALE_MS)
        CO-->>Cron: in_progress
    else stale or idle
        CO->>CO: syncTabNames() (rename sweep, best-effort)
        CO->>DOST: put(state: sprintQueue, pagesDone:0, failures:0)
        CO->>DOST: setAlarm(now+1s)
        CO-->>Cron: started
    end

    loop per alarm tick
        CO->>DOST: get('sync')
        CO->>JR: searchIssuesPage(jql, nextPageToken)
        JR-->>CO: 100 issues + nextPageToken / isLast
        CO->>ST: syncSprintPage(sheetId, issues)
        ST->>GS: metadata read + key-col batchGet + values:batchUpdate + batchUpdate(stale deletes)
        GS-->>ST: ok
        ST-->>CO: rowsWritten
        alt isLast
            CO->>DOST: put(next sprint from queue) or delete('sync')
        else next page
            CO->>DOST: put(cursor, pagesDone+1)
            CO->>DOST: setAlarm(now+3s)
        end
    end

    Note over CO,GS: on failure: cursor not advanced, retry with backoff 5s·2^n (cap 5 min), Sentry-captured
```

## 3. Webhook flow (`POST /`)

```mermaid
flowchart TD
    A[POST / ?token=...] --> B{token == SECRET_TOKEN?}
    B -- no --> R401[401 unauthorized]
    B -- yes --> C[validate payload JSON]
    C --> C1{issue.fields present?}
    C1 -- no --> OK[200 ok - ignored]
    C1 -- yes --> C2{project.key == PROJECT_KEY?}
    C2 -- no --> OK
    C2 -- yes --> CH[waitUntil: postChatNotification]
    C2 -- yes --> E{webhookEvent?}
    E -- issue_created/updated --> U[withToken → upsertIssue]
    E -- issue_deleted --> D[withToken → deleteIssue]
    E -- other --> OK
    U --> U1{pickSprint?}
    U1 -- none --> OK
    U1 -- sprint --> U2[getOrCreateSprintSheet: find / rename / duplicate from Template]
    U2 --> U3[read KEY_COLUMN across all sprint tabs]
    U3 --> U4[delete issue from every OTHER sprint tab]
    U4 --> U5[find row by key else append; write COLUMN_MAP range]
    U5 --> OK
    D --> D1[read KEY_COLUMN across sprint tabs]
    D1 --> D2{row found?}
    D2 -- no --> OK
    D2 -- yes --> D3{DELETE_MODE?}
    D3 -- delete --> D4[deleteDimension]
    D3 -- mark --> D5[status = Deleted]
    D4 --> OK
    D5 --> OK
```

## 4. Full-sprint sync flow (`SyncCoordinator`)

```mermaid
flowchart TD
    A[kick / cron or GET /sync] --> B{configured sprint IDs?}
    B -- none --> IDLE[idle]
    B -- ids --> C{existing state fresh?}
    C -- yes --> IP[in_progress]
    C -- no --> D[syncTabNames: rename sweep]
    D --> E["put state: sprintId=ids[0], sprintQueue=rest"]
    E --> F[setAlarm now+1s]

    F --> G[alarm: get state]
    G -- none --> STOP[return]
    G -- state --> H["searchIssuesPage: jql sprint=<sprintId>"]
    H --> I[syncSprintPage: batched write + stale deletes]
    I -- isLast --> J{more sprints queued?}
    J -- yes --> K[state: next sprint, fresh cursor]
    K --> F
    J -- no --> L[delete sync state - done]
    I -- more pages --> M[state: persist nextPageToken, pagesDone+1]
    M --> N[setAlarm now+3s]
    N --> G
    I -- error --> O[state: failures+1, cursor not advanced]
    O --> P[setAlarm backoff 5s·2^n cap 5min]
    P --> G
```

## Key gotchas reflected in the diagrams

- **Jira JQL pagination**: `/search/jql` returns no `total` and ignores `startAt` — paging is driven purely by `nextPageToken`/`isLast` (diagram 2).
- **Batched writes**: one page = 1 metadata read + 1 key-column batchGet + 1 `values:batchUpdate` + 1 `batchUpdate` per tab with stale copies (rows descending), to stay under the Free plan's 50-subrequest/invocation cap.
- **Stale restart**: if no page completed within `STALE_MS` (4 min), the next cron kick treats the marker as dead and restarts from page 0.
- **`pickSprint` is approximate**: an issue in two active sprints can land on the "wrong" tab — accepted trade-off (diagrams 3, 4).
- **OAuth token cache**: `auth.ts` caches in-memory; `withStoredToken` caches in DO storage so the RS256 JWT is signed ≤1/hr, not per tick.
- **Tab-name sweep** runs on every `kick()` because Jira doesn't reliably fire webhooks on sprint renames; failures never block the page sync.
