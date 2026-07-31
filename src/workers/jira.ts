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
  let startAt = 0
  for (;;) {
    const url = `${base}?jql=${encodeURIComponent(jql)}&fields=*all&maxResults=${PAGE_SIZE}&startAt=${startAt}`
    const res = await fetch(url, { headers: { Authorization: auth } })
    if (!res.ok) throw new Error(`Jira search ${res.status}: ${await res.text()}`)
    const data = (await res.json()) as { issues?: JiraIssue[]; total?: number }
    issues.push(...(data.issues ?? []))
    startAt += PAGE_SIZE
    if (startAt >= (data.total ?? startAt)) break
  }
  return issues
}
