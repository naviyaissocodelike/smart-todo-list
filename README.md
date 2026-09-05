# Smart Productivity MVP

## Quick Start

```bash
# 1. Install Bun (if you don't have it)
curl -fsSL https://bun.sh/install | bash

# 2. Install dependencies
cd smart-productivity-mvp
bun install

# 3. Configure environment
cp .env.example .env
# Edit .env — add your OpenRouter API key

# 4. Start the server
bun run dev
```

Server runs at `http://localhost:3456`

## Setup

### OpenRouter (required for AI synthesis)
1. Go to https://openrouter.ai/keys
2. Create a key and paste it in `.env` as `OPENROUTER_API_KEY`

### Gmail OAuth (optional — for creating email drafts)
1. Go to https://console.cloud.google.com/
2. Create a project → Enable **Gmail API**
3. Configure OAuth consent screen (External) → Add scope `https://www.googleapis.com/auth/gmail.modify`
4. Create OAuth 2.0 credentials (Web application)
5. Add `http://localhost:3456/auth/gmail/callback` as an authorized redirect URI
6. Copy Client ID and Secret to `.env`
7. Visit `http://localhost:3456/auth/gmail` to authorize

**The tool never sends emails.** It only creates drafts in your Gmail drafts folder.

## Usage

- **Capture:** Type in the box, hit Enter. AI auto-synthesizes
- **Surface:** The top task is shown automatically (no boards, no lists)
- **Reiterate:** If confidence is low, the tool asks one bounded question
- **Draft:** For email tasks, click "Generate Draft" → review → "Create Gmail Draft"
- **Edit:** Click Edit to fix domain, type, subject, deadline. Corrections are logged.
- **Iterate:** Click Iterate to give free-form feedback; AI re-synthesizes with it.
- **Archive:** Removes task from surface (stored permanently in `data.json`)

## Memory & Learning (Low-Cost Context)

Spark learns from your edits without bloating every prompt.

### How it works
1. **You edit a task** → Spark stores a correction in `data.json`
2. **Next capture** → Spark does a **local keyword match** against your priors. Only matching keywords inject a tiny hint into the prompt (usually 0 extra tokens, occasionally 10-30).
3. **Compile** → Click "Compile from edits" in the **Memory** view. This costs **one LLM call** to summarize your correction history into `context.md` — a human-readable, editable file.
4. **`context.md`** → Loaded once at server startup and injected into the system prompt. Zero per-request cost.

### context.md (optional, high-signal)
Create `context.md` in the project root for facts you want the AI to always know:

```markdown
# My World
- Dave → District Angels (co-founder)
- BOTR → Tala (internal initiative)
- "ASAP" means same-day deadline
```

Or copy the example: `cp context.md.example context.md`

**Why this is cheap:** Static context lives in the system prompt. It doesn't grow. Corrections are stored locally and only surfaced when relevant. Compilation happens on-demand, not per-request.

### Raw priors
Your full correction history is always visible in the **Memory** view under "Raw priors." It grows forever but never leaves your machine and never hits the LLM unless a keyword matches.

## Mac Menubar

Turn the web UI into a native menubar app without building anything:

**Option A: Fluid ($5)**
- Download [Fluid](https://fluidapp.com)
- Create a site-specific browser for `http://localhost:3456`
- Window size: 380x600, turn off navigation, pin to menubar

**Option B: Plash (free)**
- [Plash](https://github.com/sindresorhus/Plash) on the Mac App Store
- Load `http://localhost:3456` as a menubar web page

## Phone Usage

Once the server is running, find your computer's local IP:

```bash
ipconfig getifaddr en0  # Mac
hostname -I             # Linux
```

Then open `http://YOUR_IP:3456` on your phone (same WiFi network).

## Database

All data is stored in `data.json` in the project root. Human-readable, portable, easily backed up. No migrations, no schema changes.

### Files
| File | What it stores |
|------|---------------|
| `data.json` | Tasks, ingestions, corrections, keyword/contact/type priors |
| `context.md` | Human-curated or AI-compiled static context (optional) |
| `.env` | API keys and config |
