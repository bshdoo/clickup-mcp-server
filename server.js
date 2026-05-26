import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

const API_KEY = process.env.CLICKUP_API_KEY;
const TEAM_ID = process.env.CLICKUP_TEAM_ID;
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0'; // Critical for Railway

if (!API_KEY) { console.error('CLICKUP_API_KEY missing'); process.exit(1); }

// ── ClickUp API ──────────────────────────────────────────────────
async function cu(path, method = 'GET', body = null) {
  const res = await fetch(`https://api.clickup.com/api/v2${path}`, {
    method,
    headers: { Authorization: API_KEY, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`ClickUp ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── MCP Server factory ───────────────────────────────────────────
function buildServer() {
  const s = new McpServer({ name: 'sheriff-clickup', version: '1.0.0' });

  s.tool('get_workspace', 'Get all spaces, folders and lists', {}, async () => {
    const { spaces = [] } = await cu(`/team/${TEAM_ID}/space?archived=false`);
    const result = await Promise.all(spaces.map(async sp => {
      const [{ folders = [] }, { lists = [] }] = await Promise.all([
        cu(`/space/${sp.id}/folder?archived=false`),
        cu(`/space/${sp.id}/list?archived=false`),
      ]);
      const foldersWithLists = await Promise.all(folders.map(async f => {
        const { lists: fl = [] } = await cu(`/folder/${f.id}/list?archived=false`);
        return { id: f.id, name: f.name, lists: fl.map(l => ({ id: l.id, name: l.name })) };
      }));
      return { id: sp.id, name: sp.name, folders: foldersWithLists, lists: lists.map(l => ({ id: l.id, name: l.name })) };
    }));
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  s.tool('get_tasks', 'Get tasks from a list', {
    list_id: z.string(),
    include_closed: z.boolean().optional(),
  }, async ({ list_id, include_closed }) => {
    const { tasks = [] } = await cu(`/list/${list_id}/task?include_closed=${!!include_closed}&subtasks=true`);
    return { content: [{ type: 'text', text: JSON.stringify(tasks.map(t => ({
      id: t.id, name: t.name, status: t.status?.status,
      priority: t.priority?.priority, due_date: t.due_date,
      assignees: t.assignees?.map(a => a.username), url: t.url,
    })), null, 2) }] };
  });

  s.tool('create_task', 'Create a new task', {
    list_id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    priority: z.enum(['urgent','high','normal','low']).optional(),
    due_date: z.string().optional(),
    assignees: z.array(z.number()).optional(),
  }, async ({ list_id, name, description, priority, due_date, assignees }) => {
    const pm = { urgent:1, high:2, normal:3, low:4 };
    const body = { name, markdown_description: description };
    if (priority) body.priority = pm[priority];
    if (due_date) body.due_date = new Date(due_date).getTime();
    if (assignees) body.assignees = assignees;
    const t = await cu(`/list/${list_id}/task`, 'POST', body);
    return { content: [{ type: 'text', text: `✅ Created: ${t.name}\nID: ${t.id}\nURL: ${t.url}` }] };
  });

  s.tool('update_task', 'Update task status, priority, name or due date', {
    task_id: z.string(),
    name: z.string().optional(),
    status: z.string().optional(),
    priority: z.enum(['urgent','high','normal','low']).optional(),
    due_date: z.string().optional(),
    description: z.string().optional(),
  }, async ({ task_id, name, status, priority, due_date, description }) => {
    const pm = { urgent:1, high:2, normal:3, low:4 };
    const body = {};
    if (name) body.name = name;
    if (status) body.status = status;
    if (priority) body.priority = pm[priority];
    if (due_date) body.due_date = new Date(due_date).getTime();
    if (description) body.markdown_description = description;
    const t = await cu(`/task/${task_id}`, 'PUT', body);
    return { content: [{ type: 'text', text: `✅ Updated: ${t.name} [${t.status?.status}]` }] };
  });

  s.tool('create_list', 'Create a list in a space or folder', {
    name: z.string(),
    space_id: z.string().optional(),
    folder_id: z.string().optional(),
  }, async ({ name, space_id, folder_id }) => {
    const path = folder_id ? `/folder/${folder_id}/list` : `/space/${space_id}/list`;
    const l = await cu(path, 'POST', { name });
    return { content: [{ type: 'text', text: `✅ List: ${l.name} | ID: ${l.id}` }] };
  });

  s.tool('create_folder', 'Create a folder in a space', {
    space_id: z.string(),
    name: z.string(),
  }, async ({ space_id, name }) => {
    const f = await cu(`/space/${space_id}/folder`, 'POST', { name });
    return { content: [{ type: 'text', text: `✅ Folder: ${f.name} | ID: ${f.id}` }] };
  });

  s.tool('get_members', 'Get all workspace members', {}, async () => {
    const { teams = [] } = await cu('/team');
    const members = teams.flatMap(t => (t.members || []).map(m => ({
      id: m.user.id, name: m.user.username, email: m.user.email,
    })));
    return { content: [{ type: 'text', text: JSON.stringify(members, null, 2) }] };
  });

  s.tool('add_comment', 'Add comment to a task', {
    task_id: z.string(),
    comment: z.string(),
  }, async ({ task_id, comment }) => {
    await cu(`/task/${task_id}/comment`, 'POST', { comment_text: comment });
    return { content: [{ type: 'text', text: `✅ Comment added to ${task_id}` }] };
  });

  return s;
}

// ── Express ──────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Mcp-Session-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Health
app.get('/', (req, res) => res.json({ status: 'ok', service: 'Sheriff ClickUp MCP' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Streamable HTTP — primary (for Claude.ai)
app.post('/mcp', async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildServer();
    res.on('close', () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('MCP error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// SSE — legacy fallback
const sseSessions = {};
app.get('/sse', async (req, res) => {
  try {
    const transport = new SSEServerTransport('/messages', res);
    sseSessions[transport.sessionId] = transport;
    res.on('close', () => delete sseSessions[transport.sessionId]);
    const server = buildServer();
    await server.connect(transport);
  } catch (e) {
    console.error('SSE error:', e.message);
  }
});
app.post('/messages', async (req, res) => {
  const id = req.query.sessionId;
  const t = sseSessions[id];
  if (!t) return res.status(404).json({ error: 'Session not found' });
  await t.handlePostMessage(req, res);
});

// ── Start ────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`🚀 Sheriff MCP on ${HOST}:${PORT}`);
  console.log(`🔑 API Key: ${API_KEY ? 'set' : 'MISSING'} | Team: ${TEAM_ID || 'MISSING'}`);
});
