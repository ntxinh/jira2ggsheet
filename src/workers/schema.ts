import { z } from '@hono/zod-openapi'

const JiraProjectSchema = z.object({
  key: z.string().openapi({ example: 'ABC' }),
}).openapi('JiraProject')

const JiraIssueTypeSchema = z.object({
  name: z.string().openapi({ example: 'Bug' }),
}).openapi('JiraIssueType')

const JiraPrioritySchema = z.object({
  name: z.string().openapi({ example: 'High' }),
}).openapi('JiraPriority')

const JiraStatusSchema = z.object({
  name: z.string().openapi({ example: 'In Progress' }),
}).openapi('JiraStatus')

const JiraUserSchema = z.object({
  displayName: z.string().openapi({ example: 'John Doe' }),
}).openapi('JiraUser')

const JiraIssueFieldsSchema = z.object({
  project: JiraProjectSchema.optional(),
  issuetype: JiraIssueTypeSchema.optional(),
  priority: JiraPrioritySchema.optional(),
  summary: z.string().openapi({ example: 'Fix login bug' }).optional(),
  status: JiraStatusSchema.optional(),
  created: z.string().openapi({ example: '2026-07-04T10:00:00.000+0000' }).optional(),
  assignee: JiraUserSchema.optional(),
}).passthrough().openapi('JiraIssueFields')

const JiraIssueSchema = z.object({
  key: z.string().openapi({ example: 'ABC-123' }),
  fields: JiraIssueFieldsSchema,
}).openapi('JiraIssue')

const JiraWebhookPayloadSchema = z.object({
  webhookEvent: z.string().openapi({ example: 'jira:issue_created' }),
  issue: JiraIssueSchema,
}).openapi('JiraWebhookPayload')

const WebhookQuerySchema = z.object({
  token: z.string().optional().openapi({ description: 'Authentication token for webhook access' }),
})

export { JiraWebhookPayloadSchema, JiraIssueSchema, JiraIssueFieldsSchema, WebhookQuerySchema }
export type JiraWebhookPayload = z.infer<typeof JiraWebhookPayloadSchema>
