import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

const API_KEY = process.env.CLICKUP_API_KEY;
const TEAM_ID = process.env.CLICKUP_TEAM_ID;
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';

if (!API_KEY) { console.error('CLICKUP_API_KEY missing'); process.exit(1); }

async function cu(path, method = 'GET', body = null) {
  const res = await fetch(`https://api.clickup.com/api/v2${path}`, {
    method,
    headers: { Authorization: API_KEY, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ClickUp ${res.status}: ${text}`);
  }
  if (method === 'DELETE') return {};
  // Some ClickUp endpoints return empty body on success (e.g. add tag)
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

const PRIO = { urgent: 1, high: 2, normal: 3, low: 4 };

function buildServer() {
  const s = new McpServer({ name: 'sheriff-clickup', version: '1.2.0' });

  // ────────────────────────────────────────────────────────────
  // EXISTING (v1.1.0) — kept stable, signatures unchanged
  // ────────────────────────────────────────────────────────────

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
    const body = { name, markdown_description: description };
    if (priority) body.priority = PRIO[priority];
    if (due_date) body.due_date = new Date(due_date).getTime();
    if (assignees) body.assignees = assignees;
    const t = await cu(`/list/${list_id}/task`, 'POST', body);
    return { content: [{ type: 'text', text: `✅ Created: ${t.name}\nID: ${t.id}\nURL: ${t.url}` }] };
  });

  s.tool('update_task', 'Update task status, priority, name, due date, description or assignees', {
    task_id: z.string(),
    name: z.string().optional(),
    status: z.string().optional(),
    priority: z.enum(['urgent','high','normal','low']).optional(),
    due_date: z.string().optional(),
    description: z.string().optional(),
    assignees_add: z.array(z.number()).optional(),
    assignees_remove: z.array(z.number()).optional(),
  }, async ({ task_id, name, status, priority, due_date, description, assignees_add, assignees_remove }) => {
    const body = {};
    if (name) body.name = name;
    if (status) body.status = status;
    if (priority) body.priority = PRIO[priority];
    if (due_date) body.due_date = new Date(due_date).getTime();
    if (description) body.markdown_description = description;
    if (assignees_add || assignees_remove) {
      body.assignees = {
        add: assignees_add || [],
        rem: assignees_remove || [],
      };
    }
    const t = await cu(`/task/${task_id}`, 'PUT', body);
    return { content: [{ type: 'text', text: `✅ Updated: ${t.name} [${t.status?.status}]` }] };
  });

  s.tool('delete_task', 'Delete a task permanently', {
    task_id: z.string(),
  }, async ({ task_id }) => {
    await cu(`/task/${task_id}`, 'DELETE');
    return { content: [{ type: 'text', text: `✅ Deleted task ${task_id}` }] };
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

  s.tool('get_members', 'Get all workspace members with their IDs', {}, async () => {
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
    return { content: [{ type: 'text', text: `✅ Comment added` }] };
  });

  s.tool('search_tasks', 'Search tasks by keyword', {
    query: z.string(),
  }, async ({ query }) => {
    const { tasks = [] } = await cu(`/team/${TEAM_ID}/task?query=${encodeURIComponent(query)}`);
    return { content: [{ type: 'text', text: JSON.stringify(tasks.map(t => ({
      id: t.id, name: t.name, status: t.status?.status, list: t.list?.name, url: t.url,
    })), null, 2) }] };
  });

  // ────────────────────────────────────────────────────────────
  // NEW (v1.2.0)
  // ────────────────────────────────────────────────────────────

  // ── Task lifecycle ──────────────────────────────────────────

  s.tool('move_task', 'Move a task to a different home list (changes its primary list)', {
    task_id: z.string(),
    list_id: z.string(),
  }, async ({ task_id, list_id }) => {
    const t = await cu(`/task/${task_id}/list/${list_id}`, 'POST');
    return { content: [{ type: 'text', text: `✅ Moved task ${task_id} → list ${list_id}` + (t?.name ? `\n${t.name}` : '') }] };
  });

  s.tool('get_task', 'Get full details of a single task (description, custom fields, tags, etc.)', {
    task_id: z.string(),
    include_subtasks: z.boolean().optional(),
  }, async ({ task_id, include_subtasks }) => {
    const t = await cu(`/task/${task_id}?include_subtasks=${!!include_subtasks}`);
    return { content: [{ type: 'text', text: JSON.stringify({
      id: t.id,
      name: t.name,
      status: t.status?.status,
      priority: t.priority?.priority,
      due_date: t.due_date,
      start_date: t.start_date,
      description: t.description,
      markdown_description: t.markdown_description,
      assignees: t.assignees?.map(a => ({ id: a.id, name: a.username })),
      tags: t.tags?.map(tag => tag.name),
      list: t.list,
      folder: t.folder,
      space: t.space,
      url: t.url,
      custom_fields: t.custom_fields?.map(f => ({
        id: f.id, name: f.name, type: f.type, value: f.value,
      })),
      subtasks: t.subtasks?.map(st => ({ id: st.id, name: st.name, status: st.status?.status })),
      linked_tasks: t.linked_tasks,
      dependencies: t.dependencies,
    }, null, 2) }] };
  });

  s.tool('add_task_to_list', 'Add a task to an additional list (multi-list, does not move home list)', {
    task_id: z.string(),
    list_id: z.string(),
  }, async ({ task_id, list_id }) => {
    await cu(`/list/${list_id}/task/${task_id}`, 'POST');
    return { content: [{ type: 'text', text: `✅ Task ${task_id} added to list ${list_id}` }] };
  });

  s.tool('remove_task_from_list', 'Remove a task from an additional list (does not delete the task)', {
    task_id: z.string(),
    list_id: z.string(),
  }, async ({ task_id, list_id }) => {
    await cu(`/list/${list_id}/task/${task_id}`, 'DELETE');
    return { content: [{ type: 'text', text: `✅ Task ${task_id} removed from list ${list_id}` }] };
  });

  // ── Task links & dependencies ───────────────────────────────

  s.tool('add_task_link', 'Link two tasks together (relationship, not dependency)', {
    task_id: z.string(),
    links_to: z.string(),
  }, async ({ task_id, links_to }) => {
    await cu(`/task/${task_id}/link/${links_to}`, 'POST');
    return { content: [{ type: 'text', text: `✅ Linked ${task_id} ↔ ${links_to}` }] };
  });

  s.tool('remove_task_link', 'Remove the link between two tasks', {
    task_id: z.string(),
    links_to: z.string(),
  }, async ({ task_id, links_to }) => {
    await cu(`/task/${task_id}/link/${links_to}`, 'DELETE');
    return { content: [{ type: 'text', text: `✅ Removed link ${task_id} ↮ ${links_to}` }] };
  });

  s.tool('add_dependency', 'Add a dependency: task_id depends on (waits for) depends_on, OR blocks dependency_of', {
    task_id: z.string(),
    depends_on: z.string().optional(),
    dependency_of: z.string().optional(),
  }, async ({ task_id, depends_on, dependency_of }) => {
    if (!depends_on && !dependency_of) {
      return { content: [{ type: 'text', text: '❌ Provide either depends_on or dependency_of' }], isError: true };
    }
    const body = {};
    if (depends_on) body.depends_on = depends_on;
    if (dependency_of) body.dependency_of = dependency_of;
    await cu(`/task/${task_id}/dependency`, 'POST', body);
    return { content: [{ type: 'text', text: `✅ Dependency added on ${task_id}` }] };
  });

  s.tool('remove_dependency', 'Remove a dependency from a task', {
    task_id: z.string(),
    depends_on: z.string().optional(),
    dependency_of: z.string().optional(),
  }, async ({ task_id, depends_on, dependency_of }) => {
    const params = new URLSearchParams();
    if (depends_on) params.append('depends_on', depends_on);
    if (dependency_of) params.append('dependency_of', dependency_of);
    await cu(`/task/${task_id}/dependency?${params.toString()}`, 'DELETE');
    return { content: [{ type: 'text', text: `✅ Dependency removed from ${task_id}` }] };
  });

  // ── Tags ────────────────────────────────────────────────────

  s.tool('add_tag_to_task', 'Add a tag (by name) to a task', {
    task_id: z.string(),
    tag_name: z.string(),
  }, async ({ task_id, tag_name }) => {
    await cu(`/task/${task_id}/tag/${encodeURIComponent(tag_name)}`, 'POST');
    return { content: [{ type: 'text', text: `✅ Tag "${tag_name}" added to ${task_id}` }] };
  });

  s.tool('remove_tag_from_task', 'Remove a tag (by name) from a task', {
    task_id: z.string(),
    tag_name: z.string(),
  }, async ({ task_id, tag_name }) => {
    await cu(`/task/${task_id}/tag/${encodeURIComponent(tag_name)}`, 'DELETE');
    return { content: [{ type: 'text', text: `✅ Tag "${tag_name}" removed from ${task_id}` }] };
  });

  // ── Comments ────────────────────────────────────────────────

  s.tool('get_task_comments', 'Get all comments on a task (thread)', {
    task_id: z.string(),
  }, async ({ task_id }) => {
    const { comments = [] } = await cu(`/task/${task_id}/comment`);
    return { content: [{ type: 'text', text: JSON.stringify(comments.map(c => ({
      id: c.id,
      user: c.user?.username,
      date: c.date,
      text: c.comment_text,
      resolved: c.resolved,
    })), null, 2) }] };
  });

  // ── Custom fields ───────────────────────────────────────────

  s.tool('get_custom_fields', 'Get all custom field definitions available on a list', {
    list_id: z.string(),
  }, async ({ list_id }) => {
    const { fields = [] } = await cu(`/list/${list_id}/field`);
    return { content: [{ type: 'text', text: JSON.stringify(fields.map(f => ({
      id: f.id,
      name: f.name,
      type: f.type,
      options: f.type_config?.options?.map(o => ({ id: o.id, name: o.name || o.label })),
    })), null, 2) }] };
  });

  s.tool('set_custom_field', 'Set the value of a custom field on a task', {
    task_id: z.string(),
    field_id: z.string(),
    value: z.any(),
  }, async ({ task_id, field_id, value }) => {
    await cu(`/task/${task_id}/field/${field_id}`, 'POST', { value });
    return { content: [{ type: 'text', text: `✅ Field ${field_id} set on ${task_id}` }] };
  });

  // ── Hierarchy navigation ────────────────────────────────────

  s.tool('get_spaces', 'Get all spaces in the workspace', {
    archived: z.boolean().optional(),
  }, async ({ archived }) => {
    const { spaces = [] } = await cu(`/team/${TEAM_ID}/space?archived=${!!archived}`);
    return { content: [{ type: 'text', text: JSON.stringify(spaces.map(sp => ({
      id: sp.id, name: sp.name, private: sp.private,
    })), null, 2) }] };
  });

  s.tool('get_folders', 'Get all folders inside a space', {
    space_id: z.string(),
    archived: z.boolean().optional(),
  }, async ({ space_id, archived }) => {
    const { folders = [] } = await cu(`/space/${space_id}/folder?archived=${!!archived}`);
    return { content: [{ type: 'text', text: JSON.stringify(folders.map(f => ({
      id: f.id, name: f.name, task_count: f.task_count,
    })), null, 2) }] };
  });

  s.tool('get_lists', 'Get all lists inside a folder OR directly inside a space (folderless)', {
    folder_id: z.string().optional(),
    space_id: z.string().optional(),
    archived: z.boolean().optional(),
  }, async ({ folder_id, space_id, archived }) => {
    if (!folder_id && !space_id) {
      return { content: [{ type: 'text', text: '❌ Provide either folder_id or space_id' }], isError: true };
    }
    const path = folder_id
      ? `/folder/${folder_id}/list?archived=${!!archived}`
      : `/space/${space_id}/list?archived=${!!archived}`;
    const { lists = [] } = await cu(path);
    return { content: [{ type: 'text', text: JSON.stringify(lists.map(l => ({
      id: l.id, name: l.name, task_count: l.task_count,
    })), null, 2) }] };
  });

  s.tool('get_list', 'Get details of a single list', {
    list_id: z.string(),
  }, async ({ list_id }) => {
    const l = await cu(`/list/${list_id}`);
    return { content: [{ type: 'text', text: JSON.stringify({
      id: l.id, name: l.name, content: l.content,
      task_count: l.task_count, folder: l.folder, space: l.space,
    }, null, 2) }] };
  });

  // ── User context ────────────────────────────────────────────

  s.tool('get_user', 'Get the authenticated user (whose token this MCP uses)', {}, async () => {
    const { user } = await cu('/user');
    return { content: [{ type: 'text', text: JSON.stringify({
      id: user.id, name: user.username, email: user.email,
    }, null, 2) }] };
  });

  // ── Time tracking ───────────────────────────────────────────

  s.tool('start_time_tracking', 'Start tracking time on a task', {
    task_id: z.string(),
    description: z.string().optional(),
    billable: z.boolean().optional(),
  }, async ({ task_id, description, billable }) => {
    const body = { tid: task_id };
    if (description) body.description = description;
    if (billable !== undefined) body.billable = billable;
    const r = await cu(`/team/${TEAM_ID}/time_entries/start`, 'POST', body);
    return { content: [{ type: 'text', text: `✅ Started tracking on ${task_id}` + (r?.data?.id ? ` | entry ${r.data.id}` : '') }] };
  });

  s.tool('stop_time_tracking', 'Stop the currently running time entry', {}, async () => {
    const r = await cu(`/team/${TEAM_ID}/time_entries/stop`, 'POST');
    return { content: [{ type: 'text', text: `✅ Stopped` + (r?.data?.duration ? ` | duration ${r.data.duration}ms` : '') }] };
  });

  s.tool('get_time_entries', 'Get time entries within a date range (defaults to last 7 days)', {
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    task_id: z.string().optional(),
  }, async ({ start_date, end_date, task_id }) => {
    const params = new URLSearchParams();
    const sd = start_date ? new Date(start_date).getTime() : Date.now() - 7 * 24 * 60 * 60 * 1000;
    const ed = end_date ? new Date(end_date).getTime() : Date.now();
    params.append('start_date', sd);
    params.append('end_date', ed);
    if (task_id) params.append('task_id', task_id);
    const { data = [] } = await cu(`/team/${TEAM_ID}/time_entries?${params.toString()}`);
    return { content: [{ type: 'text', text: JSON.stringify(data.map(e => ({
      id: e.id,
      task: e.task?.name,
      task_id: e.task?.id,
      user: e.user?.username,
      duration_ms: parseInt(e.duration, 10),
      duration_min: Math.round(parseInt(e.duration, 10) / 60000),
      start: e.start,
      end: e.end,
      description: e.description,
    })), null, 2) }] };
  });

  // ── Attachments (via URL — simple wrapper for documenting external assets) ──

  s.tool('add_attachment_url', 'Attach an external URL to a task as a comment with markdown link (workaround: ClickUp v2 file upload is multipart-only)', {
    task_id: z.string(),
    url: z.string(),
    title: z.string().optional(),
  }, async ({ task_id, url, title }) => {
    const text = `📎 ${title || 'Attachment'}: ${url}`;
    await cu(`/task/${task_id}/comment`, 'POST', { comment_text: text });
    return { content: [{ type: 'text', text: `✅ Attachment link posted as comment on ${task_id}` }] };
  });

  return s;
}

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Mcp-Session-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Sheriff ClickUp MCP', version: '1.2.0' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

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

const sseSessions = {};
app.get('/sse', async (req, res) => {
  try {
    const transport = new SSEServerTransport('/messages', res);
    sseSessions[transport.sessionId] = transport;
    res.on('close', () => delete sseSessions[transport.sessionId]);
    await buildServer().connect(transport);
  } catch (e) { console.error('SSE error:', e.message); }
});
app.post('/messages', async (req, res) => {
  const t = sseSessions[req.query.sessionId];
  if (!t) return res.status(404).json({ error: 'Session not found' });
  await t.handlePostMessage(req, res);
});

app.listen(PORT, HOST, () => {
  console.log(`🚀 Sheriff MCP v1.2.0 on ${HOST}:${PORT}`);
  console.log(`🔑 API: ${API_KEY ? 'set' : 'MISSING'} | Team: ${TEAM_ID || 'MISSING'}`);
});
