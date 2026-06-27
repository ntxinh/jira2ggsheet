import { getConfig, type Env } from './config';
import { upsertIssue, deleteIssue, withToken } from './sheetWriter';

interface JiraWebhookPayload {
  webhookEvent: string;
  issue: {
    key: string;
    fields: Record<string, unknown>;
  };
}

function handleWebhook(payload: JiraWebhookPayload, env: Env): Promise<void> | null {
  if (!payload || !payload.issue || !payload.issue.fields) {
    console.log('Ignored: payload has no issue');
    return null;
  }

  const issue = payload.issue;
  const project = issue.fields.project as { key: string } | undefined;
  if (!project || project.key !== env.PROJECT_KEY) {
    console.log(`Ignored: project ${project?.key ?? 'undefined'} != ${env.PROJECT_KEY}`);
    return null;
  }

  const config = getConfig(env);

  switch (payload.webhookEvent) {
    case 'jira:issue_created':
    case 'jira:issue_updated':
      return withToken(
        env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        env.GOOGLE_PRIVATE_KEY,
        (token) => upsertIssue(env.SPREADSHEET_ID, issue, token, config),
      );
    case 'jira:issue_deleted':
      return withToken(
        env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        env.GOOGLE_PRIVATE_KEY,
        (token) => deleteIssue(env.SPREADSHEET_ID, issue, token, config),
      );
    default:
      console.log('Ignored: event ' + payload.webhookEvent);
      return null;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);
    if (url.searchParams.get('token') !== env.SECRET_TOKEN) {
      console.log('Webhook rejected: bad or missing token');
      return new Response('unauthorized', { status: 401 });
    }

    let payload: JiraWebhookPayload;
    try {
      payload = await request.json<JiraWebhookPayload>();
    } catch {
      console.log('Webhook ignored: malformed JSON');
      return new Response('ok');
    }

    try {
      const work = handleWebhook(payload, env);
      if (work) {
        ctx.waitUntil(work.catch((err) => console.error('Handler failed: ' + err)));
      }
    } catch (err) {
      console.log('Webhook handler error: ' + err);
    }

    return new Response('ok');
  },
};
