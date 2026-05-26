import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const API_KEY = process.env.CLICKUP_API_KEY;
const TEAM_ID = process.env.CLICKUP_TEAM_ID;
const PORT = process.env.PORT || 3000;

if (!API_KEY) {
  console.error('ERROR: CLICKUP_API_KEY environment variable is required');
  process.exit(1);
}

// ClickUp API helper
async function clickup(path, method = 'GET', body = null) {
  const url = `https://api.clickup.com/api/v2${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': API_KEY,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ClickUp API error ${res.status}: ${err}`);
  }
  return res.json();
}

// Build MCP server
function createMcpServer() {
  const server = new McpServer({
    name: 'sheriff-clickup',
    version: '1.0.0',
  });

  // ── TOOL: get_workspace ──────────────────────────────────────────
  server.tool(
    'get_workspace',
    'Get all spaces, folders and lists in the ClickUp workspace',
    {},
    async () => {
      const spacesData = await clickup(`/team/${TEAM_ID}/space?archived=false`);
      const result = [];
      for (const space of spacesData.spaces || []) {
        const spaceInfo = { id: space.id, name: space.name, folders: [], lists: [] };
        const [foldersData, listsData] = await Promise.all([
          clickup(`/space/${space.id}/folder?archived=false`),
          clickup(`/space/${space.id}/list?archived=false`),
        ]);
        for (const folder of foldersData.folders || []) {
          const folderInfo = { id: folder.id, name: folder.name, lists: [] };
          const flData = await clickup(`/folder/${folder.id}/list?archived=false`);
          folderInfo.lists = (flData.lists || []).map(l => ({ id: l.id, name: l.name, task_count: l.task_count }));
          spaceInfo.folders.push(folderInfo);
        }
        spaceInfo.lists = (listsData.lists || []).map(l => ({ id: l.id, name: l.name, task_count: l.task_count }));
        result.push(spaceInfo);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── TOOL: get_tasks ──────────────────────────────────────────────
  server.tool(
    'get_tasks',
    'Get tasks from a list',
    {
      list_id: z.string().describe('ClickUp list ID'),
      include_closed: z.boolean().optional().describe('Include closed/done tasks'),
    },
    async ({ list_id, include_closed }) => {
      const data = await clickup(`/list/${list_id}/task?include_closed=${include_closed || false}&subtasks=true`);
      const tasks = (data.tasks || []).map(t => ({
        id: t.id,
        name: t.name,
        status: t.status?.status,
        priority: t.priority?.priority,
        due_date: t.due_date,
        assignees: t.assignees?.map(a => a.username),
        url: t.url,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }] };
    }
  );

  // ── TOOL: create_task ────────────────────────────────────────────
  server.tool(
    'create_task',
    'Create a new task in a list',
    {
      list_id: z.string().describe('ClickUp list ID'),
      name: z.string().describe('Task name'),
      description: z.string().optional().describe('Task description (markdown supported)'),
      priority: z.enum(['urgent', 'high', 'normal', 'low']).optional(),
      due_date: z.string().optional().describe('Due date YYYY-MM-DD'),
      assignees: z.array(z.number()).optional().describe('Array of user IDs'),
    },
    async ({ list_id, name, description, priority, due_date, assignees }) => {
      const priorityMap = { urgent: 1, high: 2, normal: 3, low: 4 };
      const body = { name, markdown_description: description };
      if (priority) body.priority = priorityMap[priority];
      if (due_date) body.due_date = new Date(due_date).getTime();
      if (assignees) body.assignees = assignees;
      const task = await clickup(`/list/${list_id}/task`, 'POST', body);
      return { content: [{ type: 'text', text: `✅ Task created: ${task.name}\nID: ${task.id}\nURL: ${task.url}` }] };
    }
  );

  // ── TOOL: update_task ────────────────────────────────────────────
  server.tool(
    'update_task',
    'Update task name, status, priority, due date or description',
    {
      task_id: z.string().describe('Task ID'),
      name: z.string().optional(),
      status: z.string().optional().describe('New status e.g. "in progress", "complete"'),
      priority: z.enum(['urgent', 'high', 'normal', 'low']).optional(),
      due_date: z.string().optional().describe('Due date YYYY-MM-DD'),
      description: z.string().optional(),
    },
    async ({ task_id, name, status, priority, due_date, description }) => {
      const priorityMap = { urgent: 1, high: 2, normal: 3, low: 4 };
      const body = {};
      if (name) body.name = name;
      if (status) body.status = status;
      if (priority) body.priority = priorityMap[priority];
      if (due_date) body.due_date = new Date(due_date).getTime();
      if (description) body.markdown_description = description;
      const task = await clickup(`/task/${task_id}`, 'PUT', body);
      return { content: [{ type: 'text', text: `✅ Task updated: ${task.name} [${task.status?.status}]` }] };
    }
  );

  // ── TOOL: create_list ────────────────────────────────────────────
  server.tool(
    'create_list',
    'Create a new list in a space or folder',
    {
      name: z.string().describe('List name'),
      space_id: z.string().optional().describe('Space ID (if creating directly in space)'),
      folder_id: z.string().optional().describe('Folder ID (if creating inside a folder)'),
    },
    async ({ name, space_id, folder_id }) => {
      if (!space_id && !folder_id) throw new Error('Provide either space_id or folder_id');
      const path = folder_id ? `/folder/${folder_id}/list` : `/space/${space_id}/list`;
      const list = await clickup(path, 'POST', { name });
      return { content: [{ type: 'text', text: `✅ List created: ${list.name}\nID: ${list.id}` }] };
    }
  );

  // ── TOOL: create_folder ──────────────────────────────────────────
  server.tool(
    'create_folder',
    'Create a new folder in a space',
    {
      space_id: z.string().describe('Space ID'),
      name: z.string().describe('Folder name'),
    },
    async ({ space_id, name }) => {
      const folder = await clickup(`/space/${space_id}/folder`, 'POST', { name });
      return { content: [{ type: 'text', text: `✅ Folder created: ${folder.name}\nID: ${folder.id}` }] };
    }
  );

  // ── TOOL: get_members ────────────────────────────────────────────
  server.tool(
    'get_members',
    'Get all members of the workspace',
    {},
    async () => {
      const data = await clickup(`/team`);
      const teams = data.teams || [];
      const members = teams.flatMap(t =>
        (t.members || []).map(m => ({
          id: m.user.id,
          name: m.user.username,
          email: m.user.email,
        }))
      );
      return { content: [{ type: 'text', text: JSON.stringify(members, null, 2) }] };
    }
  );

  // ── TOOL: search_tasks ───────────────────────────────────────────
  server.tool(
    'search_tasks',
    'Search tasks in the workspace by name or keyword',
    {
      query: z.string().describe('Search query'),
    },
    async ({ query }) => {
      const data = await clickup(`/team/${TEAM_ID}/task?query=${encodeURIComponent(query)}&include_closed=false`);
      const tasks = (data.tasks || []).map(t => ({
        id: t.id,
        name: t.name,
        status: t.status?.status,
        list: t.list?.name,
        url: t.url,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }] };
    }
  );

  // ── TOOL: add_comment ────────────────────────────────────────────
  server.tool(
    'add_comment',
    'Add a comment to a task',
    {
      task_id: z.string().describe('Task ID'),
      comment: z.string().describe('Comment text (markdown supported)'),
    },
    async ({ task_id, comment }) => {
      await clickup(`/task/${task_id}/comment`, 'POST', { comment_text: comment });
      return { content: [{ type: 'text', text: `✅ Comment added to task ${task_id}` }] };
    }
  );

  return server;
}

// ── Express app ──────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Sheriff ClickUp MCP', version: '1.0.0' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// MCP endpoint — stateless streamable HTTP (one transport per request)
app.post('/mcp', async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });
  res.on('close', () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', async (req, res) => {
  res.status(405).json({ error: 'Use POST /mcp for MCP protocol' });
});

app.delete('/mcp', async (req, res) => {
  res.status(405).json({ error: 'Method not allowed' });
});

app.listen(PORT, () => {
  console.log(`🚀 Sheriff ClickUp MCP running on port ${PORT}`);
  console.log(`📋 Team ID: ${TEAM_ID || 'NOT SET - add CLICKUP_TEAM_ID'}`);
  console.log(`🔑 API Key: ${API_KEY ? '***set***' : 'NOT SET'}`);
});
