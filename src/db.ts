import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const DB_PATH = join(process.cwd(), 'data.json');

export interface Ingestion {
  id: string;
  mode: 'text' | 'voice' | 'braindump' | 'email';
  raw: string;
  timestamp: string;
  source_context?: Record<string, string>;
}

export interface Task {
  id: string;
  ingestion_id: string;
  title: string;
  domain: 'District Angels' | 'Tala' | 'Job Search' | 'Personal Misc';
  task_type: 'Draft' | 'Research' | 'Nothing' | 'Recommend Alt' | 'Review' | 'Create/Consolidate' | 'Remind';
  ai_required: 'true' | 'false' | 'hybrid';
  deadline: string | null;
  schedule: string | null;
  subject: string | null;
  status: 'synthesized' | 'clarified' | 'ready' | 'drafting' | 'done' | 'archived';
  confidence: number;
  draft?: { subject: string; body: string };
  feedback?: string[];
  created_at: string;
}

export interface Correction {
  id: string;
  task_id: string;
  field: string;
  from_value: string;
  to_value: string;
  timestamp: string;
}

export interface UserContext {
  keyword_priors: Record<string, Record<string, number>>;
  contact_priors: Record<string, string>;
  type_priors: Record<string, string>;
}

interface DB {
  ingestions: Ingestion[];
  tasks: Task[];
  corrections: Correction[];
  user_context: UserContext;
  gmailTokens: { access_token: string; refresh_token: string; expiry_date: number } | null;
}

function load(): DB {
  if (!existsSync(DB_PATH)) {
    return {
      ingestions: [],
      tasks: [],
      corrections: [],
      user_context: {
        keyword_priors: {},
        contact_priors: {},
        type_priors: {}
      },
      gmailTokens: null
    };
  }
  return JSON.parse(readFileSync(DB_PATH, 'utf-8'));
}

function save(db: DB) {
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

export const db = {
  get(): DB { return load(); },
  set(data: DB) { save(data); },

  addIngestion(i: Ingestion) {
    const d = load();
    d.ingestions.push(i);
    save(d);
    return i;
  },

  addTask(t: Task) {
    const d = load();
    d.tasks.push(t);
    save(d);
    return t;
  },

  getTask(id: string): Task | undefined {
    return load().tasks.find(t => t.id === id);
  },

  updateTask(id: string, patch: Partial<Task>) {
    const d = load();
    const idx = d.tasks.findIndex(t => t.id === id);
    if (idx !== -1) {
      d.tasks[idx] = { ...d.tasks[idx], ...patch };
      save(d);
      return d.tasks[idx];
    }
    return undefined;
  },

  getTasks(): Task[] {
    return load().tasks;
  },

  logCorrection(correction: Correction) {
    const d = load();
    d.corrections.push(correction);
    // Update user context priors
    if (correction.field === 'domain') {
      const task = d.tasks.find(t => t.id === correction.task_id);
      if (task) {
        const words = task.title.toLowerCase().split(/\s+/);
        words.forEach(word => {
          if (word.length < 3) return;
          if (!d.user_context.keyword_priors[word]) {
            d.user_context.keyword_priors[word] = {};
          }
          if (!d.user_context.keyword_priors[word][correction.to_value]) {
            d.user_context.keyword_priors[word][correction.to_value] = 0;
          }
          d.user_context.keyword_priors[word][correction.to_value]++;
        });
      }
    }
    if (correction.field === 'subject' && correction.to_value) {
      const task = d.tasks.find(t => t.id === correction.task_id);
      if (task) {
        d.user_context.contact_priors[correction.to_value] = task.domain;
      }
    }
    if (correction.field === 'task_type') {
      const task = d.tasks.find(t => t.id === correction.task_id);
      if (task) {
        const words = task.title.toLowerCase().split(/\s+/);
        words.forEach(word => {
          if (word.length < 3) return;
          d.user_context.type_priors[word] = correction.to_value;
        });
      }
    }
    save(d);
    return correction;
  },

  getUserContext(): UserContext {
    return load().user_context;
  },

  getCorrections(): Correction[] {
    return load().corrections;
  },

  setGmailTokens(tokens: DB['gmailTokens']) {
    const d = load();
    d.gmailTokens = tokens;
    save(d);
  },

  getGmailTokens(): DB['gmailTokens'] {
    return load().gmailTokens;
  }
};
