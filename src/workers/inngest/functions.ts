import { inngest } from './client'
import { fetchSprintName } from '../jira'
import type { Env } from '../config'

export const fetchSprintNameFn = inngest.createFunction(
  { id: 'fetch-sprint-name', triggers: { event: 'sprint/name.requested' } },
  async ({ event, step, env }) => {
    const sprintId = event.data.sprintId
    const name = await step.run(
      'fetch-name',
      fetchSprintName,
      sprintId,
      (env as Env).JIRA_SUBDOMAIN,
      (env as Env).JIRA_EMAIL,
      (env as Env).JIRA_API_TOKEN,
    )
    return { sprintId, name }
  },
)
