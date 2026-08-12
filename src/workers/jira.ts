import type { JiraIssue } from './fieldExtractor'

const PAGE_SIZE = 100

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
  const base = `https://${subdomain}.atlassian.net/rest/api/3/search/jql`
  const auth = 'Basic ' + btoa(`${email}:${apiToken}`)
  let url = `${base}?jql=${encodeURIComponent(jql)}&fields=${encodeURIComponent(fields)}&maxResults=${PAGE_SIZE}`
  if (nextPageToken) url += `&nextPageToken=${encodeURIComponent(nextPageToken)}`
  const res = await fetch(url, { headers: { Authorization: auth } })
  if (!res.ok) throw new Error(`Jira search ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean }
  return {
    issues: data.issues ?? [],
    nextPageToken: data.nextPageToken,
    isLast: Boolean(data.isLast) || !data.nextPageToken,
  }
}
