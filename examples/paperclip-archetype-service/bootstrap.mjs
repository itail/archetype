const PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL ?? 'http://127.0.0.1:3100';
const SERVICE_URL = process.env.ARCHETYPE_SERVICE_URL ?? 'http://127.0.0.1:8787/heartbeat';
const SERVICE_SECRET = process.env.ARCHETYPE_SERVICE_SECRET ?? '';

async function main() {
  const company = await request('/api/companies', {
    method: 'POST',
    body: {
      name: 'Archetype Demo Co',
      description: 'Local Paperclip + Archetype integration demo',
    },
  });

  const agent = await request(`/api/companies/${company.id}/agents`, {
    method: 'POST',
    body: {
      name: 'ArchetypeCOS',
      role: 'general',
      title: 'Archetype Chief of Staff',
      capabilities: 'Operational triage, concise writing, issue updates',
      adapterType: 'http',
      adapterConfig: {
        url: SERVICE_URL,
        headers: SERVICE_SECRET ? { 'x-paperclip-shared-secret': SERVICE_SECRET } : {},
        timeoutMs: 30000,
      },
      budgetMonthlyCents: 5000,
    },
  });

  const issue = await request(`/api/companies/${company.id}/issues`, {
    method: 'POST',
    body: {
      title: 'Write a rollout plan for the Archetype integration',
      description: 'Create a concise rollout/update note that moves this demo issue forward.',
      status: 'backlog',
      priority: 'high',
      assigneeAgentId: agent.id,
    },
  });

  const run = await request(`/api/agents/${agent.id}/wakeup`, {
    method: 'POST',
    body: {
      source: 'on_demand',
      triggerDetail: 'manual',
      reason: 'paperclip_archetype_demo',
      payload: {
        issueId: issue.id,
        mutation: 'demo_bootstrap',
      },
    },
  });

  console.log(JSON.stringify({
    companyId: company.id,
    agentId: agent.id,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    heartbeatRunId: run?.id ?? null,
    heartbeatRunStatus: run?.status ?? null,
    serviceUrl: SERVICE_URL,
  }, null, 2));

  const result = await waitForUpdate(issue.id, run?.id ?? null);
  console.log('\nUpdated issue snapshot:');
  console.log(JSON.stringify(result, null, 2));
}

async function waitForUpdate(issueId, runId) {
  const deadline = Date.now() + 30000;
  let lastIssue = null;
  let lastRun = null;

  while (Date.now() < deadline) {
    const [issue, comments, run] = await Promise.all([
      request(`/api/issues/${issueId}`),
      request(`/api/issues/${issueId}/comments`),
      runId ? request(`/api/heartbeat-runs/${runId}`) : Promise.resolve(null),
    ]);
    lastRun = run;
    lastIssue = { issue, comments, run };

    if ((comments ?? []).length > 0 && ['in_progress', 'done', 'blocked'].includes(issue.status)) {
      return lastIssue;
    }

    await sleep(1000);
  }

  throw new Error(
    `Timed out waiting for Paperclip agent update on issue ${issueId}: ${JSON.stringify({ lastIssue, lastRun }, null, 2)}`,
  );
}

async function request(pathname, options = {}) {
  const response = await fetch(`${PAPERCLIP_API_URL}${pathname}`, {
    method: options.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  const text = await response.text();
  const json = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(`Request failed: ${options.method ?? 'GET'} ${pathname} -> ${response.status} ${text}`);
  }

  return json;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error('[paperclip-archetype-bootstrap] failed:', error);
  process.exitCode = 1;
});
