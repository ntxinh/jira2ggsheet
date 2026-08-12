import type { JiraIssue } from './fieldExtractor'

const PAGE_SIZE = 100

export async function searchIssues(
  jql: string,
  subdomain: string,
  email: string,
  apiToken: string,
): Promise<JiraIssue[]> {
  const base = `https://${subdomain}.atlassian.net/rest/api/3/search/jql`
  const auth = 'Basic ' + btoa(`${email}:${apiToken}`)
  const issues: JiraIssue[] = []
  let nextPageToken: string | undefined
  for (;;) {
    let url = `${base}?jql=${encodeURIComponent(jql)}&fields=*all&maxResults=${PAGE_SIZE}`
    if (nextPageToken) url += `&nextPageToken=${encodeURIComponent(nextPageToken)}`
    const res = await fetch(url, { headers: { Authorization: auth } })
    if (!res.ok) throw new Error(`Jira search ${res.status}: ${await res.text()}`)
    const data = (await res.json()) as { issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean }
    issues.push(...(data.issues ?? []))
    if (data.isLast || !data.nextPageToken) break
    nextPageToken = data.nextPageToken
  }
  return issues
}
