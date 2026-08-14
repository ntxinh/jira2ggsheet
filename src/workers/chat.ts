import * as Sentry from '@sentry/cloudflare'
import type { Env } from './config'
import type { JiraWebhookPayload } from './schema'

const EVENT_ICONS: Record<string, string> = {
  'jira:issue_created': '🆕',
  'jira:issue_updated': '🔄',
  'jira:issue_deleted': '🗑️',
}

// Vietnam is UTC+7 year-round (no DST). Shifting the Date keeps the weekday and hour correct
// even when the UTC date differs from the local one (e.g. 00:00 Mon Vietnam is Sun 17:00 UTC).
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000

// True for 08:00 <= hh < 18:00 on Monday-Friday, Vietnam time. Exported for tests.
export function isWithinTicketWindow(now: Date): boolean {
  const local = new Date(now.getTime() + VIETNAM_OFFSET_MS)
  const day = local.getUTCDay()
  const hour = local.getUTCHours()
  return day >= 1 && day <= 5 && hour >= 8 && hour < 18
}

// Posts a one-line-per-detail summary of a received Jira webhook to the configured Google Chat
// space. issue_created goes to NEW_TICKET_GOOGLE_CHAT_WEBHOOK (falling back to
// GOOGLE_CHAT_WEBHOOK) only within the weekday 08:00-18:00 Vietnam window, everything else to
// GOOGLE_CHAT_WEBHOOK. No-op when no webhook is set; failures are reported to Sentry and never
// affect the webhook response (call via waitUntil, not awaited).
export async function postChatNotification(env: Env, payload: JiraWebhookPayload): Promise<void> {
  const webhookUrl =
    payload.webhookEvent === 'jira:issue_created' && isWithinTicketWindow(new Date())
      ? env.NEW_TICKET_GOOGLE_CHAT_WEBHOOK ?? env.GOOGLE_CHAT_WEBHOOK
      : env.GOOGLE_CHAT_WEBHOOK
  if (!webhookUrl) return

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: buildChatMessage(env, payload) }),
    })
  } catch (err) {
    Sentry.captureException(err)
  }
}

function buildChatMessage(env: Env, payload: JiraWebhookPayload): string {
  const { webhookEvent, issue } = payload
  const fields = issue.fields
  const details: string[] = []

  const badge = [fields.issuetype?.name, fields.status?.name, fields.priority?.name].filter(Boolean).join(' · ')
  if (badge) details.push(badge)
  if (fields.assignee?.displayName) details.push(`Assignee: ${fields.assignee.displayName}`)

  const sprint = sprintNames(env, fields)
  if (sprint) details.push(`Sprint: ${sprint}`)

  return [
    `${EVENT_ICONS[webhookEvent] ?? '📨'} ${webhookEvent} — ${issue.key}`,
    fields.summary ?? '',
    ...details,
    `https://${env.JIRA_SUBDOMAIN}.atlassian.net/browse/${issue.key}`,
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

// The sprint custom field key is configurable (CUSTOM_FIELDS_SPRINT), so look it up dynamically.
// Jira sends it as an array of {id, name} (or a single object); be lenient about the shape.
function sprintNames(env: Env, fields: Record<string, unknown>): string {
  const raw = fields[env.CUSTOM_FIELDS_SPRINT]
  if (Array.isArray(raw)) {
    return raw
      .map((sprint) => (sprint && typeof sprint === 'object' && 'name' in sprint ? String((sprint as { name: unknown }).name) : String(sprint)))
      .filter(Boolean)
      .join(', ')
  }
  if (raw && typeof raw === 'object' && 'name' in raw) return String((raw as { name: unknown }).name)
  return raw ? String(raw) : ''
}
