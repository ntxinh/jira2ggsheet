import type { JiraIssue } from './fieldExtractor'

const PAGE_SIZE = 100

function basicAuth(email: string, apiToken: string): string {
  return 'Basic ' + btoa(`${email}:${apiToken}`)
}

export function jiraBaseUrl(subdomain: string): string {
  return `https://${subdomain}.atlassian.net`
}

export interface JiraPage {
  issues: JiraIssue[]
  nextPageToken?: string
  isLast: boolean
}

// One Jira page per call: the /search/jql endpoint returns no `total` and ignores `startAt`,
// so pagination is driven entirely by nextPageToken/isLast (see AGENTS.md gotcha). The DO
// alarm chain calls this once per tick and persists the cursor between ticks. `fields` defaults
// to *all but callers should pass a narrow list — parsing a 100-issue page with every field
// (comments, attachments, ...) can exceed the Free plan's 10ms CPU budget.
export async function searchIssuesPage(
  jql: string,
  subdomain: string,
  email: string,
  apiToken: string,
  nextPageToken?: string,
  fields = '*all',
): Promise<JiraPage> {
  const base = `${jiraBaseUrl(subdomain)}/rest/api/3/search/jql`
  let url = `${base}?jql=${encodeURIComponent(jql)}&fields=${encodeURIComponent(fields)}&maxResults=${PAGE_SIZE}`
  if (nextPageToken) url += `&nextPageToken=${encodeURIComponent(nextPageToken)}`
  const res = await fetch(url, { headers: { Authorization: basicAuth(email, apiToken) } })
  if (!res.ok) throw new Error(`Jira search ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean }
  return {
    issues: data.issues ?? [],
    nextPageToken: data.nextPageToken,
    isLast: Boolean(data.isLast) || !data.nextPageToken,
  }
}

// Jira Software Agile API: authoritative current sprint name even for empty/closed
// sprints (issue-search JQL would miss them). Same Basic auth as searchIssuesPage.
export async function fetchSprintName(
  sprintId: string,
  subdomain: string,
  email: string,
  apiToken: string,
): Promise<string> {
  const url = `${jiraBaseUrl(subdomain)}/rest/agile/1.0/sprint/${sprintId}`
  const res = await fetch(url, { headers: { Authorization: basicAuth(email, apiToken) } })
  if (!res.ok) throw new Error(`Jira sprint ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { name?: string }
  return String(data.name ?? '')
}

// /myself resolves the account the API token belongs to — the watcher we add when a ticket
// gets assigned to that account.
export async function fetchMyselfAccountId(
  subdomain: string,
  email: string,
  apiToken: string,
): Promise<string> {
  const url = `${jiraBaseUrl(subdomain)}/rest/api/3/myself`
  const res = await fetch(url, { headers: { Authorization: basicAuth(email, apiToken) } })
  if (!res.ok) throw new Error(`Jira myself ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { accountId?: string }
  if (!data.accountId) throw new Error('Jira myself returned no accountId')
  return data.accountId
}

// Body is the raw accountId string (Jira API v3 quirk, not JSON). Adding an existing watcher
// is a 204 no-op, so callers don't need to check the watcher list first. Watching oneself
// only needs Browse permission.
export async function addWatcher(
  issueKey: string,
  accountId: string,
  subdomain: string,
  email: string,
  apiToken: string,
): Promise<void> {
  const url = `${jiraBaseUrl(subdomain)}/rest/api/3/issue/${issueKey}/watchers`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: basicAuth(email, apiToken), 'Content-Type': 'application/json' },
    body: JSON.stringify(accountId),
  })
  if (!res.ok) throw new Error(`Jira add watcher ${issueKey} ${res.status}: ${await res.text()}`)
}
