import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { randomUUID } from 'crypto';
import { db, type Task } from './db';
import { synthesize, synthesizeWithFeedback, reiterateQuestion, draftEmail, setContextFile, compilePriorsIntoContext } from './llm';
import { loadContextFile, buildMatchedHints, saveContextFile } from './context';
import { getAuthUrl, handleCallback, createDraft } from './gmail';

/* ---------- Load static context once at startup ---------- */
const worldContext = loadContextFile();
setContextFile(worldContext);
console.log(worldContext ? '📚 Loaded context.md' : '📭 No context.md found. Create one to add static context.');

const app = new Hono();
app.use(cors());

/* ---------- Helpers ---------- */
function scoreTask(task: Task): number {
  let score = 0;
  score += task.confidence * 50;
  if (task.status === 'ready') score += 100;
  else if (task.status === 'clarified') score += 70;
  else if (task.status === 'synthesized') score += 40;

  if (task.deadline) {
    const days = (new Date(task.deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    if (days < 0) score += 500;
    else if (days < 1) score += 300;
    else if (days < 3) score += 150;
    else score += Math.max(0, 100 - days * 5);
  }

  if (task.task_type === 'Draft' && task.ai_required === 'true') score += 30;
  if (task.schedule) {
    const hours = (new Date(task.schedule).getTime() - Date.now()) / (1000 * 60 * 60);
    if (hours > 0 && hours < 24) score += 200;
  }

  const ageDays = (Date.now() - new Date(task.created_at).getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays > 7) score += ageDays * 2;

  return score;
}

/* ---------- API Routes ---------- */

app.post('/api/capture', async (c) => {
  const body = await c.req.json();
  const ingestion = {
    id: randomUUID(),
    mode: body.mode || 'text',
    raw: body.raw,
    timestamp: new Date().toISOString(),
    source_context: body.source_context || {}
  };
  db.addIngestion(ingestion);
  return c.json({ ingestion });
});

app.post('/api/ingestions/:id/synthesize', async (c) => {
  const ingestion = db.get().ingestions.find(i => i.id === c.req.param('id'));
  if (!ingestion) return c.json({ error: 'not found' }, 404);

  try {
    // Only inject hints for keywords that actually appear in this capture
    const hints = buildMatchedHints(ingestion.raw, db.getUserContext());
    const result = await synthesize(ingestion.raw, hints);

    const task: Task = {
      id: randomUUID(),
      ingestion_id: ingestion.id,
      title: result.title,
      domain: result.domain as Task['domain'],
      task_type: result.task_type as Task['task_type'],
      ai_required: result.ai_required as Task['ai_required'],
      deadline: result.deadline,
      schedule: result.schedule,
      subject: result.subject,
      status: result.confidence >= 0.85 ? 'ready' : (result.confidence >= 0.6 ? 'clarified' : 'synthesized'),
      confidence: result.confidence,
      created_at: new Date().toISOString()
    };

    db.addTask(task);
    return c.json({ task });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.get('/api/surface', (c) => {
  const tasks = db.getTasks().filter(t =>
    ['synthesized', 'clarified', 'ready', 'drafting'].includes(t.status)
  );
  const sorted = tasks.sort((a, b) => scoreTask(b) - scoreTask(a));
  return c.json({ task: sorted[0] || null, count: sorted.length });
});

/** Check if OpenRouter is configured */
app.get('/api/config', (c) => {
  const hasKey = !!process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY !== 'sk-or-v1-...';
  return c.json({ hasOpenRouter: hasKey, hasContextFile: !!worldContext });
});

/** Edit task fields */
app.put('/api/tasks/:id', async (c) => {
  const body = await c.req.json();
  const task = db.getTask(c.req.param('id'));
  if (!task) return c.json({ error: 'not found' }, 404);

  const fieldsToLog = ['domain', 'task_type', 'subject', 'title'];
  fieldsToLog.forEach(field => {
    if (body[field] !== undefined && body[field] !== (task as any)[field]) {
      db.logCorrection({
        id: randomUUID(),
        task_id: task.id,
        field,
        from_value: String((task as any)[field] || ''),
        to_value: String(body[field]),
        timestamp: new Date().toISOString()
      });
    }
  });

  const patch: Partial<Task> = {};
  if (body.domain) patch.domain = body.domain;
  if (body.task_type) patch.task_type = body.task_type;
  if (body.subject !== undefined) patch.subject = body.subject;
  if (body.title) patch.title = body.title;
  if (body.deadline !== undefined) patch.deadline = body.deadline;
  if (body.ai_required) patch.ai_required = body.ai_required;

  db.updateTask(task.id, patch);
  return c.json({ task: db.getTask(task.id) });
});

app.get('/api/tasks', (c) => {
  const tasks = db.getTasks().sort((a, b) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
  return c.json({ tasks });
});

app.get('/api/tasks/:id/reiterate', async (c) => {
  const task = db.getTask(c.req.param('id'));
  if (!task) return c.json({ error: 'not found' }, 404);

  const ingestion = db.get().ingestions.find(i => i.id === task.ingestion_id);
  if (!ingestion) return c.json({ error: 'ingestion not found' }, 404);

  try {
    const { question, options } = await reiterateQuestion(task, ingestion.raw);
    return c.json({ question, options, task });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.post('/api/tasks/:id/answer', async (c) => {
  const body = await c.req.json();
  const task = db.getTask(c.req.param('id'));
  if (!task) return c.json({ error: 'not found' }, 404);

  const patch: Partial<Task> = { status: 'ready', confidence: 0.9 };
  if (body.domain) patch.domain = body.domain;
  if (body.task_type) patch.task_type = body.task_type;
  if (body.subject) patch.subject = body.subject;
  if (body.deadline !== undefined) patch.deadline = body.deadline;
  if (body.answer_text) patch.title = body.answer_text;

  db.updateTask(task.id, patch);
  return c.json({ task: db.getTask(task.id) });
});

app.post('/api/tasks/:id/draft', async (c) => {
  const task = db.getTask(c.req.param('id'));
  if (!task) return c.json({ error: 'not found' }, 404);

  try {
    const draft = await draftEmail(task);
    db.updateTask(task.id, { draft, status: 'drafting' });
    return c.json({ draft, task: db.getTask(task.id) });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.post('/api/tasks/:id/create-gmail-draft', async (c) => {
  const body = await c.req.json();
  const task = db.getTask(c.req.param('id'));
  if (!task || !task.draft) return c.json({ error: 'no draft found' }, 404);

  try {
    const to = body.to || 'unknown@example.com';
    const result = await createDraft(to, task.draft.subject, task.draft.body);
    db.updateTask(task.id, { status: 'ready' });
    return c.json({ success: true, gmailDraft: result });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.post('/api/tasks/:id/done', (c) => {
  db.updateTask(c.req.param('id'), { status: 'archived' });
  return c.json({ success: true, archived: true });
});

/** Iterate on task with user feedback */
app.post('/api/tasks/:id/feedback', async (c) => {
  const body = await c.req.json();
  const task = db.getTask(c.req.param('id'));
  if (!task) return c.json({ error: 'not found' }, 404);

  const ingestion = db.get().ingestions.find(i => i.id === task.ingestion_id);
  if (!ingestion) return c.json({ error: 'ingestion not found' }, 404);

  const feedback = body.feedback;
  if (!feedback) return c.json({ error: 'feedback required' }, 400);

  try {
    const current = [...(task.feedback || []), feedback];

    const hints = buildMatchedHints(ingestion.raw, db.getUserContext());
    const result = await synthesizeWithFeedback(ingestion.raw, task, current, hints);

    // Build the updated task with new metadata
    const updated: Partial<Task> = {
      title: result.title,
      domain: result.domain as Task['domain'],
      task_type: result.task_type as Task['task_type'],
      ai_required: result.ai_required as Task['ai_required'],
      deadline: result.deadline,
      schedule: result.schedule,
      subject: result.subject,
      feedback: current,
      confidence: result.confidence,
      status: result.confidence >= 0.85 ? 'ready' : 'clarified'
    };

    // If this is a Draft task and there was already a draft, regenerate the content too
    if (task.draft && updated.task_type === 'Draft') {
      const draftTask = { ...task, ...updated } as Task;
      const newDraft = await draftEmail(draftTask);
      updated.draft = newDraft;
      updated.status = 'drafting';
    }

    db.updateTask(task.id, updated);
    return c.json({ task: db.getTask(task.id) });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/* ---------- Learning from corrections ---------- */
app.post('/api/compile-priors', async (c) => {
  try {
    const corrections = db.getCorrections();
    if (corrections.length === 0) {
      return c.json({ error: 'No corrections to compile yet. Edit some tasks first.' }, 400);
    }
    const currentContext = loadContextFile();
    const compiled = await compilePriorsIntoContext(corrections, currentContext);
    saveContextFile(compiled);
    setContextFile(compiled);
    return c.json({ success: true, compiled, lineCount: compiled.split('\n').length });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.get('/api/context', (c) => {
  const content = loadContextFile();
  return c.json({ content, exists: !!content });
});

/* ---------- Gmail Auth ---------- */

app.get('/auth/gmail', (c) => {
  try {
    return c.redirect(getAuthUrl());
  } catch (e: any) {
    return c.text(`Gmail not configured: ${e.message}. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env`, 500);
  }
});

app.get('/auth/gmail/callback', async (c) => {
  const code = c.req.query('code');
  if (!code) return c.text('No code provided', 400);
  await handleCallback(code);
  return c.html('<script>window.close()</script><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f0f0f;color:#fff;">Gmail connected. Close this tab.</body>');
});

/* ---------- Static Files ---------- */

app.get('*', async (c) => {
  const path = c.req.path === '/' ? '/index.html' : c.req.path;
  const filePath = `./public${path}`;
  try {
    const file = Bun.file(filePath);
    if (await file.exists()) return new Response(file);
  } catch {}
  return c.notFound();
});

/* ---------- Start ---------- */

const port = parseInt(process.env.PORT || '3456');
console.log(`🚀 Smart Productivity MVP running at http://localhost:${port}`);
Bun.serve({ fetch: app.fetch, port });
