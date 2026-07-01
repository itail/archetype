import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';
import { definePersona, Gemini } from '../../dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT ?? 8787);
const PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL ?? 'http://127.0.0.1:3100';
const PAPERCLIP_API_KEY = process.env.PAPERCLIP_API_KEY ?? '';
const SERVICE_SECRET = process.env.ARCHETYPE_SERVICE_SECRET ?? '';
const STATE_PATH = process.env.ARCHETYPE_MEMORY_PATH ?? path.join(__dirname, '.state', 'paperclip-memory.json');
const MODEL = process.env.ARCHETYPE_MODEL ?? 'gemini-3.5-flash';

const updateIssueSchema = z.object({
  status: z.enum(['in_progress', 'done', 'blocked']),
  comment: z.string().min(1),
});

const provider = process.env.GEMINI_API_KEY
  ? Gemini({ apiKey: process.env.GEMINI_API_KEY, model: MODEL })
  : createDemoProvider();

const persona = definePersona({
  identity: {
    name: 'Paperclip Chief of Staff',
    expertise: ['operational triage', 'written updates', 'execution risk'],
    relationship: 'calm internal operator',
    northStar: 'move Paperclip issues forward clearly and honestly',
  },
  voice: { tone: 'balanced', style: 'quick', medium: 'desktop-panel' },
  directives: {
    default: [
      'You are handling a Paperclip issue during a heartbeat.',
      'Leave a concrete update that helps the next human or agent understand what happened.',
      'If the task is obviously a planning or writing task, completing a clear document or update can justify marking it done.',
      'If work remains and you are advancing it, use in_progress.',
      'If a hard dependency is missing, use blocked and say what is needed.',
      'Never pretend production work happened unless the issue context says it did.',
    ].join(' '),
  },
  actions: {
    updateIssue: {
      description: 'Choose the issue status and the exact comment Paperclip should post back to the issue.',
      schema: updateIssueSchema,
      confidence: 'low',
    },
  },
  contextInputs: {
    currentIssue: { label: 'CURRENT ISSUE', format: 'block', priority: 'critical' },
    recentComments: { label: 'RECENT COMMENTS', format: 'list' },
    ancestors: { label: 'ANCESTORS', format: 'list' },
    issueDocuments: { label: 'ISSUE DOCUMENTS', format: 'list' },
    workingMemory: { label: 'WORKING MEMORY', format: 'list', budget: 4000, prioritize: 'pinned-first' },
  },
  memory: {
    enabled: true,
    budget: 4000,
    categories: {
      preference: 'Stable style or workflow preference for this agent/company',
      operating_context: 'Durable operational context worth remembering across issues',
      risk: 'Recurring execution or coordination risk',
      general: 'Other durable learnings',
    },
    purpose: 'Durable things worth remembering across Paperclip heartbeats for this agent.',
  },
  eq: {
    frequencyRule: true,
    autonomyRespect: true,
    qualitativeFirst: true,
  },
  provider,
});

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'POST' || req.url !== '/heartbeat') {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    if (SERVICE_SECRET) {
      const provided = req.headers['x-paperclip-shared-secret'];
      if (provided !== SERVICE_SECRET) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
    }

    const body = await readJson(req);
    const result = await handleHeartbeat(body);
    sendJson(res, 200, result);
  } catch (error) {
    console.error('[paperclip-archetype-service] request failed:', error);
    sendJson(res, 500, {
      error: 'internal_error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(PORT, () => {
  console.log(`[paperclip-archetype-service] listening on http://127.0.0.1:${PORT}`);
  console.log(`[paperclip-archetype-service] paperclip api: ${PAPERCLIP_API_URL}`);
  console.log(`[paperclip-archetype-service] provider: ${process.env.GEMINI_API_KEY ? `gemini:${MODEL}` : 'demo-mock'}`);
});

async function handleHeartbeat(payload) {
  const runId = stringOrNull(payload?.runId);
  const agentId = stringOrNull(payload?.agentId);
  let companyId = stringOrNull(payload?.companyId);
  let taskId = stringOrNull(payload?.context?.taskId) ?? stringOrNull(payload?.context?.issueId);
  const wakeReason = stringOrNull(payload?.context?.wakeReason) ?? 'unknown';

  if (!runId || !agentId) {
    throw new Error('Missing runId or agentId');
  }

  if (!companyId || !taskId) {
    const run = await paperclipRequest(`/api/heartbeat-runs/${runId}`).catch(() => null);
    companyId = companyId ?? stringOrNull(run?.companyId);
    taskId =
      taskId ??
      stringOrNull(run?.contextSnapshot?.taskId) ??
      stringOrNull(run?.contextSnapshot?.issueId);
  }

  if (!taskId && companyId) {
    taskId = await findTopIssue(companyId, agentId);
  }

  if (!taskId) {
    console.log(`[paperclip-archetype-service] run ${runId}: no taskId and no assigned issue, skipping`);
    return {
      ok: true,
      skipped: true,
      reason: 'no_task_id',
      runId,
      agentId,
    };
  }

  if (wakeReason === 'issue_status_changed' || wakeReason === 'issue_commented') {
    console.log(`[paperclip-archetype-service] run ${runId}: skipping follow-up wake (${wakeReason}) for issue ${taskId}`);
    return {
      ok: true,
      skipped: true,
      reason: wakeReason,
      runId,
      agentId,
      taskId,
    };
  }

  console.log(`[paperclip-archetype-service] run ${runId}: handling issue ${taskId} (${wakeReason})`);

  const [issue, comments, documents, memories] = await Promise.all([
    paperclipRequest(`/api/issues/${taskId}`),
    paperclipRequest(`/api/issues/${taskId}/comments`),
    paperclipRequest(`/api/issues/${taskId}/documents`).catch(() => []),
    loadMemories(agentId),
  ]);

  if (issue.status === 'in_progress') {
    try {
      await paperclipRequest(`/api/issues/${taskId}/checkout`, {
        method: 'POST',
        runId,
        body: {
          agentId,
          expectedStatuses: ['in_progress'],
        },
      });
    } catch (error) {
      if (isConflict(error)) {
        console.warn(`[paperclip-archetype-service] issue ${taskId} already checked out elsewhere; skipping`);
        return { ok: true, skipped: true, reason: 'checkout_conflict', runId, agentId, taskId };
      }
      throw error;
    }
  }

  const result = await persona.chat({
    message: buildUserMessage(issue, wakeReason),
    history: [],
    memories,
    context: {
      currentIssue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        status: issue.status,
        priority: issue.priority,
        assigneeAgentId: issue.assigneeAgentId,
        project: issue.project?.name ?? null,
        goal: issue.goal?.title ?? null,
      },
      recentComments: (comments ?? []).slice(-5).map((comment) => ({
        id: comment.id,
        body: truncate(comment.body ?? '', 600),
      })),
      ancestors: (issue.ancestors ?? []).map((ancestor) => ({
        identifier: ancestor.identifier,
        title: ancestor.title,
        status: ancestor.status,
      })),
      issueDocuments: (documents ?? []).map((doc) => ({
        key: doc.key,
        title: doc.title,
        body: truncate(doc.body ?? '', 1000),
      })),
      workingMemory: memories,
    },
    userIdentity: 'Paperclip board operator',
    timezone: 'UTC',
  });

  await persistMemoryCrud(agentId, result.crudActions ?? [], memories);

  const updateAction = result.actions.find((action) => action.name === 'updateIssue');
  const update = updateIssueSchema.safeParse(updateAction?.params ?? {
    status: 'in_progress',
    comment: result.message || 'Reviewed the issue and captured the next step.',
  });

  if (!update.success) {
    throw new Error(`Invalid updateIssue action from persona: ${update.error.message}`);
  }

  const patched = await paperclipRequest(`/api/issues/${taskId}`, {
    method: 'PATCH',
    runId,
    body: update.data,
  });

  return {
    ok: true,
    runId,
    agentId,
    taskId,
    issueStatus: patched.status,
    comment: update.data.comment,
    provider: process.env.GEMINI_API_KEY ? `gemini:${MODEL}` : 'demo-mock',
  };
}

function createDemoProvider() {
  return {
    name: 'paperclip-demo-mock',
    async chat(request) {
      const message = String(request.message ?? '').toLowerCase();
      let status = 'in_progress';
      let response = 'I reviewed the issue, captured the next operational step, and left a progress update.';

      if (message.includes('blocked') || message.includes('waiting on') || message.includes('needs access')) {
        status = 'blocked';
        response = 'Blocked on an external dependency. I documented exactly what is needed to unblock this issue.';
      } else if (
        message.includes('write a plan') ||
        message.includes('document') ||
        message.includes('draft') ||
        message.includes('design')
      ) {
        status = 'done';
        response = 'Completed the requested planning/documentation pass and recorded the result back on the issue.';
      }

      return {
        text: JSON.stringify({
          message: response,
          actions: [
            {
              name: 'updateIssue',
              params: {
                status,
                comment: response,
              },
            },
          ],
          followUps: [],
        }),
      };
    },
  };
}

async function paperclipRequest(pathname, options = {}) {
  const headers = {
    'content-type': 'application/json',
    ...(PAPERCLIP_API_KEY ? { authorization: `Bearer ${PAPERCLIP_API_KEY}` } : {}),
    ...(options.runId ? { 'x-paperclip-run-id': options.runId } : {}),
    ...(options.headers ?? {}),
  };

  const response = await fetch(`${PAPERCLIP_API_URL}${pathname}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  const text = await response.text();
  const json = text ? safeJsonParse(text) : null;

  if (!response.ok) {
    const error = new Error(`Paperclip API ${options.method ?? 'GET'} ${pathname} failed with ${response.status}`);
    error.status = response.status;
    error.body = json ?? text;
    throw error;
  }

  return json;
}

async function loadMemories(agentId) {
  const state = await loadState();
  return state[agentId] ?? [];
}

async function findTopIssue(companyId, agentId) {
  const issues = await paperclipRequest(
    `/api/companies/${companyId}/issues?assigneeAgentId=${encodeURIComponent(agentId)}&status=todo,in_progress,blocked`,
  );
  return Array.isArray(issues) && issues.length > 0 ? stringOrNull(issues[0]?.id) : null;
}

async function persistMemoryCrud(agentId, crudActions, existingMemories) {
  if (!Array.isArray(crudActions) || crudActions.length === 0) return;
  const state = await loadState();
  const current = [...(state[agentId] ?? existingMemories ?? [])];
  const byId = new Map(current.map((memory) => [memory.id, memory]));

  for (const action of crudActions) {
    if (action.entity !== 'memory') continue;

    if (action.operation === 'create') {
      const params = action.params ?? {};
      const memory = {
        id: action.id ?? `${agentId}-${Date.now()}-${byId.size + 1}`,
        content: String(params.content ?? '').trim(),
        category: String(params.category ?? 'general'),
        pinned: Boolean(params.pinned ?? false),
        createdAt: new Date().toISOString(),
        ...(params.source ? { source: String(params.source) } : {}),
        ...(params.stability ? { stability: String(params.stability) } : {}),
        ...(params.contextHint ? { contextHint: String(params.contextHint) } : {}),
      };
      if (memory.content) byId.set(memory.id, memory);
      continue;
    }

    if (!action.id) continue;
    if (action.operation === 'delete') {
      byId.delete(action.id);
      continue;
    }

    if (action.operation === 'update') {
      const existing = byId.get(action.id);
      if (!existing) continue;
      byId.set(action.id, { ...existing, ...(action.params ?? {}) });
    }
  }

  state[agentId] = [...byId.values()];
  await saveState(state);
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function saveState(state) {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

function buildUserMessage(issue, wakeReason) {
  return [
    `Wake reason: ${wakeReason}`,
    `Issue title: ${issue.title ?? ''}`,
    `Issue description: ${issue.description ?? ''}`,
    'Decide the best next operational update for this issue and choose the correct status.',
  ].join('\n');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function truncate(value, limit) {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function isConflict(error) {
  return Boolean(error && typeof error === 'object' && error.status === 409);
}
