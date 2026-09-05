const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';

interface SynthesisResult {
  title: string;
  domain: string;
  task_type: string;
  ai_required: string;
  deadline: string | null;
  schedule: string | null;
  subject: string | null;
  confidence: number;
}

let contextFileContent = ''; // loaded once at startup

export function setContextFile(content: string) {
  contextFileContent = content;
}

async function callOpenRouter(system: string, user: string, temperature = 0.2) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set in .env');

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'Smart Productivity MVP'
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

function cleanJson(content: string): string {
  return content.replace(/```json|```/g, '').trim();
}

function buildSystemPrompt(hints?: string): string {
  const worldContext = contextFileContent
    ? `\n\n=== My World (static context, always relevant) ===\n${contextFileContent}\n=== End My World ===`
    : '';

  return `You are a ruthless executive assistant for a busy knowledge worker.
Domains: District Angels (angel investing), Tala (primary company/work), Job Search, Personal Misc.

Analyze raw captures and return ONLY valid JSON. No markdown, no explanation.${worldContext}${hints || ''}

Required JSON shape:
{
  "title": "concise actionable task",
  "domain": "District Angels | Tala | Job Search | Personal Misc",
  "task_type": "Draft | Research | Nothing | Recommend Alt | Review | Create/Consolidate | Remind",
  "ai_required": "true | false | hybrid",
  "deadline": "ISO date or null",
  "schedule": "ISO datetime or null",
  "subject": "person's name or null",
  "confidence": 0.0-1.0
}

Rules:
- Draft = writing email/document. Research = gather info. Nothing = non-actionable note/venting.
- Recommend Alt = user asked for X but Y is clearly better/faster.
- Review = approve or edit something existing.
- Create/Consolidate = build, merge, organize a document or system.
- Remind = pure time alert (call dentist at 2pm).
- ai_required: true if AI can fully generate output. false if human-only. hybrid if AI preps but human must execute.
- Infer deadline from text: "by Friday", "next week", "ASAP", "EOD".
- Infer subject from names mentioned.
- Confidence < 0.7 if ambiguous. Confidence < 0.5 if a question is absolutely needed.`;
}

export async function synthesize(raw: string, hints?: string): Promise<SynthesisResult> {
  const system = buildSystemPrompt(hints);
  const content = await callOpenRouter(system, `Raw capture:\n"${raw.replace(/"/g, '\"')}"`, 0.2);
  return JSON.parse(cleanJson(content));
}

export async function synthesizeWithFeedback(raw: string, task: any, feedbackHistory: string[], hints?: string): Promise<SynthesisResult> {
  const system = buildSystemPrompt(hints);

  const latestFeedback = feedbackHistory[feedbackHistory.length - 1];
  const priorFeedback = feedbackHistory.slice(0, -1);

  let feedbackBlock = '';
  if (priorFeedback.length > 0) {
    feedbackBlock += `PRIOR FEEDBACK (already applied):\n` + priorFeedback.map((f, i) => `${i + 1}. "${f.replace(/"/g, '\"')}"`).join('\n') + '\n\n';
  }
  feedbackBlock += `CURRENT FEEDBACK — this is the ONLY signal that matters right now:\n"${latestFeedback.replace(/"/g, '\"')}"`;

  const user = `You are re-evaluating a task that was previously classified INCORRECTLY.

Original capture: "${raw.replace(/"/g, '\"')}"

INCORRECT previous classification: ${JSON.stringify({
    title: task.title,
    domain: task.domain,
    task_type: task.task_type,
    ai_required: task.ai_required,
    deadline: task.deadline,
    subject: task.subject
  })}

${feedbackBlock}

The previous title, categorization, and framing were ALL WRONG. You must produce a COMPLETELY NEW task that reflects what the user actually wants — NOT what the original capture literally said.

CRITICAL RULES:
- The "title" field MUST be rewritten from scratch to reflect the user's feedback.
- Do NOT copy the previous title unless the user's feedback explicitly says to keep it.
- If the user says "this is about X" or "this is for Y" — incorporate that into the title wording directly.
- "Draft" means an email/message needs to be written. The title should describe what needs to be drafted.

Return ONLY valid JSON.`;

  const content = await callOpenRouter(system, user, 0.2);
  return JSON.parse(cleanJson(content));
}

export async function compilePriorsIntoContext(corrections: any[], currentContext: string): Promise<string> {
  const system = `You are summarizing a user's task-correction history into a compact, human-readable knowledge file.
Output ONLY plain markdown. No JSON. No explanations.

Rules:
- One fact per line, using "- " bullets
- Group by domain when clear
- Keep it tight: 5-15 lines max
- Only include patterns with 2+ occurrences
- Delete anything from the old context that seems contradicted by new corrections`;

  const user = `Existing context file:\n${currentContext || '(empty)'}
\nNew corrections since last compile:\n${JSON.stringify(corrections.slice(-30), null, 2)}
\nProduce the updated My World context file.`;

  return await callOpenRouter(system, user, 0.3);
}

export async function reiterateQuestion(task: any, raw: string): Promise<{ question: string; options: string[] }> {
  const system = `You are a sharp EA who asks ONE specific, bounded clarification question with 2-3 short options.
Never open-ended. Reference the original capture directly. Output ONLY valid JSON.`;

  const user = `Original capture: "${raw.replace(/"/g, '\"')}"
Current classification: ${JSON.stringify({ title: task.title, domain: task.domain, task_type: task.task_type, ai_required: task.ai_required, deadline: task.deadline, subject: task.subject })}
Confidence was only ${task.confidence}.

Output JSON: {"question": "...", "options": ["...", "...", "..."]}`;

  const content = await callOpenRouter(system, user, 0.3);
  return JSON.parse(cleanJson(content));
}

export async function draftEmail(task: any): Promise<{ subject: string; body: string }> {
  const styleContext = contextFileContent
    ? `\n\n=== STYLE GUIDE (My actual voice, always follow) ===\n${contextFileContent}\n=== END STYLE GUIDE ===`
    : '';

  const system = `You are a professional ghostwriter, perfectly matching the user's actual voice and style.${styleContext}
\nWrite concise, warm-but-professional emails that sound EXACTLY like the user wrote them.\n\nOutput ONLY valid JSON: {\"subject\": \"...\", \"body\": \"...\"}\nBody should be plain text, no markdown, ready to send.`;

  const user = `Draft an email for this task:\nTitle: ${task.title}\nDomain: ${task.domain}\nRecipient: ${task.subject || 'the recipient'}\nContext: ${task.deadline ? `Relevant deadline: ${task.deadline}` : ''}\n\nWrite the email.`;

  const content = await callOpenRouter(system, user, 0.4);
  return JSON.parse(cleanJson(content));
}
