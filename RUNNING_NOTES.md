# Spark – Running Notes
*Personal productivity tool MVP for capture → synthesis → execution*

## Project Charter
- **Goal**: Build a smart productivity tool that captures tasks (text, voice deferred), synthesizes them via AI (domain, type, priority, etc.), provides a clean responsive UI (Mac menubar + phone web), allows editing/feedback iteration/archiving/email drafting, and learns from corrections without inflating per‑request costs.
- **Constraints**: Cloud API for voice (deferred), Gmail API/OAuth with explicit user confirmation, cheap easy database (JSON), OpenRouter backend, Mac menubar interface (web UI + Fluid/Plash wrapper), phone accessibility via local network IP, MVP scope only.
- **Location**: `/Users/naviya/smart‑productivity‑mvp/`
- **Started**: September 2024

---

## 2025‑09‑01 – MVP Foundation
### Stack Decisions
- **Backend**: Bun + TypeScript + Hono (lightweight, fast start)
- **Database**: JSON file (`data.json`) – cheapest, zero‑schema, human‑readable
- **AI backend**: OpenRouter with `openai/gpt‑4o‑mini` (cost‑effective, widely available)
- **Frontend**: Plain HTML/CSS/JS with dark theme, responsive design
- **Communication**: Gmail API for drafting (OAuth flow, explicit user confirmation)

### Architecture
```
data.json
├── ingestions[]   – raw captures (text/voice, source context)
├── tasks[]        – synthesized tasks + metadata
├── corrections[]  – manual edits for learning
└── user_context   – keyword/contact/type priors (inferred)
```

### Two‑Tier Context System
- **Static**: `context.md` – human‑curated world knowledge (people, projects, preferences)
- **Dynamic**: `user_context` – keyword→domain priors automatically built from corrections

### UI Principles
- **Single‑task focus**: Surface the highest‑priority task only (scored by deadline, confidence, status)
- **Event delegation**: All buttons use `data‑action` and `data‑id`; no fragile inline `onclick`
- **Dark theme**: System‑like appearance (#0f0f0f background, #f5a623 accent)
- **Mobile‑first**: 420px max width, touch‑friendly buttons

### Key Endpoints
- `POST /api/capture` – create raw ingestion
- `POST /api/ingestions/:id/synthesize` – AI classification → task
- `GET /api/surface` – top scored task for display
- `PUT /api/tasks/:id` – manual edit (logs correction)
- `POST /api/tasks/:id/feedback` – iterate with user feedback
- `POST /api/tasks/:id/draft` – generate email body
- `POST /api/tasks/:id/create‑gmail‑draft` – push to Gmail

---

## 2025‑09‑02 – Early Issues & Fixes
### Port Conflict
- **Problem**: Default port 3000 conflicted with other services
- **Fix**: Changed to 3456 across `.env`, server code, README

### OpenRouter Model Issues
- **Problem**: Initial model unspecified; some calls failed
- **Fix**: Explicitly set `DEFAULT_MODEL = 'openai/gpt‑4o‑mini'` in `llm.ts`

### Memory/Context Compilation Deferred
- **User request**: Focus on core FE experience first
- **Removed**: Memory view/compile endpoints (`/api/compile‑priors`, `/api/context`) from initial UI
- **Note**: The `compilePriorsIntoContext` function remains in `llm.ts` for later use

---

## 2025‑09‑04 – The Feedback Incorporation Problem

### Symptom
“Iterate” button worked, but feedback was ignored—tasks didn’t change meaningfully.

### Root Cause
`src/llm.ts` `synthesizeWithFeedback` prompt was too weak:
```typescript
// Old (ineffective)
const system = buildSystemPrompt(hints) + `\n\nThe user has provided feedback on a previous classification. Incorporate it.`;
```
The model saw the feedback as optional context, not a directive to change.

### Solution
Rewrote the prompt to be forceful and include **all prior feedback**, not just the latest:
```typescript
// New (explicit)
const user = `You are re‑evaluating a task that was previously classified INCORRECTLY.
…
INCORRECT previous classification: ${JSON.stringify(…)}
…
USER'S DIRECT FEEDBACK — this is the ONLY signal that matters right now:
…
The previous title, categorization, and framing were ALL WRONG. Return a COMPLETELY NEW task…`;
```

### Additional Fix: Regenerating Drafts on Feedback
**Problem**: Even if metadata changed, the email draft body stayed stale.

**Solution**: In `/api/tasks/:id/feedback` endpoint, after updating metadata, check:
```typescript
if (task.draft && updated.task_type === 'Draft') {
  const draftTask = { ...task, ...updated } as Task;
  const newDraft = await draftEmail(draftTask);
  updated.draft = newDraft;
  updated.status = 'drafting';
}
```
Now clicking “Iterate” on a draft task **rewrites both the title and the email body** based on feedback.

---

## 2025‑09‑04 – Email Voice & Learning System

### Problem
“The emails/recommendations still sound lame.”

### Realization
The `draftEmail` prompt had no knowledge of the user’s actual voice. It used a generic “professional ghostwriter” instruction.

### Fixes Applied
1. **Inject `context.md` into email drafting**  
   Modified `draftEmail` to add:
   ```typescript
   const styleContext = contextFileContent
     ? `\n\n=== STYLE GUIDE (My actual voice, always follow) ===\n${contextFileContent}\n=== END STYLE GUIDE ===`
     : '';
   ```
   Now any voice rules in `context.md` are enforced.

2. **Enhanced `context.md.example`**  
   Added a detailed **Voice & Style** section with:
   - Forbidden phrases (“reach out”, “circle back”)
   - Preferred phrases (“check in”, “no rush”)
   - Tone guidelines
   - Example email snippets

3. **Restored compile‑priors endpoint**  
   Added back `POST /api/compile‑priors` and `GET /api/context` to allow learning from manual edits.

4. **Added Settings UI**  
   - Header now has “Settings” link  
   - Settings overlay includes:
     * **Learn from my edits** – runs compile‑priors
     * **View context.md** – reminder to edit file
   - User can now trigger learning without touching CLI

### How Learning Works (Two‑Loop System)
1. **Static learning** (human‑curated)
   - Edit `context.md` → restart server
   - Immediate effect on all new drafts

2. **Dynamic learning** (AI‑extracted)
   - Manually edit tasks (title/domain/type/subject) → corrections logged
   - Click “Learn from my edits” → AI scans corrections, updates `context.md`
   - Patterns with 2+ occurrences become permanent rules

---

## Current Architecture (as of 2025‑09‑04)

### Data Flow
```
Capture → Ingestion → Synthesis → Task → [Draft] → Gmail Draft
    ↑          ↑          ↑         ↑        ↑
 Feedback   Retry    Clarify    Edit    Iterate
    |          |          |         |        |
    └───→ Corrections ────┴─────────┘        |
              ↓                               |
         [Compile Priors] ←──────────────────┘
              ↓
        Updated context.md
```

### Files
| File | Purpose |
|------|---------|
| `src/index.ts` | Hono server, all API routes |
| `src/llm.ts` | OpenRouter calls: synthesize, feedback, draft, compile |
| `src/db.ts` | JSON file DB with typed interfaces |
| `src/context.ts` | Load/save `context.md`, build matched hints |
| `src/gmail.ts` | OAuth flow & draft creation |
| `public/index.html` | Single‑page UI with event delegation |
| `data.json` | All persisted state |
| `context.md` | Static world knowledge + voice rules |
| `.env` | API keys (OpenRouter, Gmail) |

### UI Actions & Their Effects
| Button | Action | API Call | Result |
|--------|--------|----------|--------|
| **Capture** | Submit raw text | `POST /api/capture` → `POST /api/ingestions/:id/synthesize` | New task appears |
| **Archive** | Mark done | `POST /api/tasks/:id/done` | Task removed from surface |
| **Snooze** | Snooze 24h | `POST /api/tasks/:id/answer` with tomorrow deadline | Task stays, deadline updated |
| **Edit** | Manual edit | `PUT /api/tasks/:id` | Fields updated, correction logged |
| **Iterate** | Give feedback | `POST /api/tasks/:id/feedback` | Task re‑synthesized, draft regenerated |
| **Generate Draft** | Create email | `POST /api/tasks/:id/draft` | Draft added to task |
| **Create Gmail Draft** | Push to Gmail | `POST /api/tasks/:id/create‑gmail‑draft` | Draft appears in Gmail UI |
| **Clarify** | Ask question | `GET /api/tasks/:id/reiterate` → `POST …/answer` | Confidence raised, task refined |
| **Learn from edits** (Settings) | Compile corrections | `POST /api/compile‑priors` | `context.md` updated with patterns |

---

## Known Limitations & Future Considerations

### Local‑Only Design
- **Pros**: No hosting costs, data stays on machine, no auth complexity
- **Cons**: Phone access requires same WiFi or ngrok tunnel
- **Recommendation**: Keep local for MVP; use `ngrok http 3456` for remote access

### Gmail OAuth
- Requires Google Cloud Console project with `http://localhost:3456/auth/gmail/callback` redirect URI
- Optional; can skip if not needed

### Learning Latency
- `context.md` changes require server restart (file loaded once at startup)
- Compile‑priors is a manual trigger; could be scheduled

### Scaling
- JSON file fine for personal use (1000s of tasks)
- If multi‑user needed, migrate to SQLite/Postgres

---

## Quick Start (for future reference)

```bash
cd smart‑productivity‑mvp
cp .env.example .env
# Edit .env: add OPENROUTER_API_KEY (from https://openrouter.ai/keys)
# Optional: set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET

cp context.md.example context.md
# Edit context.md with your voice rules, people, projects

bun run dev
# Server at http://localhost:3456
```

---

## Recent Changes (2025‑09‑04)

1. `src/llm.ts` – `synthesizeWithFeedback` prompt rewritten for forcefulness
2. `src/llm.ts` – `draftEmail` now injects `context.md` as style guide
3. `src/index.ts` – Feedback endpoint regenerates drafts when meaning changes
4. `context.md.example` – Expanded with Voice & Style section
5. `public/index.html` – Added Settings overlay with learning actions
6. `src/index.ts` – Restored compile‑priors and context endpoints

The system now:
- Respects feedback strongly (title, domain, draft all update)
- Follows your voice from `context.md`
- Allows one‑click learning from manual edits
- Prevents stale drafts after iteration

---

**Notes updated**: 2025‑09‑04