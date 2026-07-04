import { describe, it, expect } from 'vitest'
import { JiraWebhookPayloadSchema, WebhookQuerySchema } from '../schema'

describe('JiraWebhookPayloadSchema', () => {
  it('accepts a valid minimal payload', () => {
    const payload = {
      webhookEvent: 'jira:issue_created',
      issue: { key: 'ABC-123', fields: {} },
    }
    const result = JiraWebhookPayloadSchema.safeParse(payload)
    expect(result.success).toBe(true)
  })

  it('rejects payload without webhookEvent', () => {
    const payload = { issue: { key: 'ABC-123', fields: {} } }
    const result = JiraWebhookPayloadSchema.safeParse(payload)
    expect(result.success).toBe(false)
  })

  it('rejects payload without issue', () => {
    const payload = { webhookEvent: 'jira:issue_created' }
    const result = JiraWebhookPayloadSchema.safeParse(payload)
    expect(result.success).toBe(false)
  })

  it('rejects payload where issue has no key', () => {
    const payload = { webhookEvent: 'jira:issue_created', issue: { fields: {} } }
    const result = JiraWebhookPayloadSchema.safeParse(payload)
    expect(result.success).toBe(false)
  })

  it('accepts payload with all optional fields filled', () => {
    const payload = {
      webhookEvent: 'jira:issue_updated',
      issue: {
        key: 'ABC-456',
        fields: {
          project: { key: 'ABC' },
          issuetype: { name: 'Story' },
          priority: { name: 'Medium' },
          summary: 'Test summary',
          status: { name: 'Done' },
          created: '2026-01-01T00:00:00.000+0000',
          assignee: { displayName: 'Jane Doe' },
        },
      },
    }
    const result = JiraWebhookPayloadSchema.safeParse(payload)
    expect(result.success).toBe(true)
  })

  it('allows unknown custom fields in issue.fields (passthrough)', () => {
    const payload = {
      webhookEvent: 'jira:issue_deleted',
      issue: {
        key: 'ABC-789',
        fields: {
          customfield_10016: { id: 1, name: 'Sprint 1' },
          customfield_10021: 5,
        },
      },
    }
    const result = JiraWebhookPayloadSchema.safeParse(payload)
    expect(result.success).toBe(true)
  })
})

describe('WebhookQuerySchema', () => {
  it('accepts a query with token', () => {
    expect(WebhookQuerySchema.safeParse({ token: 'secret123' }).success).toBe(true)
  })

  it('accepts a query without token (optional)', () => {
    expect(WebhookQuerySchema.safeParse({}).success).toBe(true)
  })
})
