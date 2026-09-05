import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const CONTEXT_PATH = join(process.cwd(), 'context.md');

/** Load the human-curated context file (injected into system prompt, not per-request) */
export function loadContextFile(): string {
  if (!existsSync(CONTEXT_PATH)) return '';
  return readFileSync(CONTEXT_PATH, 'utf-8').trim();
}

export function saveContextFile(content: string) {
  writeFileSync(CONTEXT_PATH, content);
}

/** Build a tiny hint string from ONLY the keywords that match the raw capture.
 *  Zero cost if nothing matches. Usually 0-3 lines if something does. */
export function buildMatchedHints(raw: string, userContext: any): string {
  if (!userContext) return '';
  const words = raw.toLowerCase().split(/\s+/);
  const hints: string[] = [];

  // Keyword → domain priors
  const seenKeywords = new Set<string>();
  words.forEach(word => {
    const cleaned = word.replace(/[^a-z]/g, '');
    if (!cleaned || cleaned.length < 3) return;
    if (seenKeywords.has(cleaned)) return;
    seenKeywords.add(cleaned);

    const priors = userContext.keyword_priors?.[cleaned];
    if (priors) {
      const sorted = Object.entries(priors as Record<string, number>)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 1);
      if (sorted.length > 0) {
        hints.push(`"${cleaned}" → usually "${sorted[0][0]}" (${sorted[0][1]} prior match${sorted[0][1] > 1 ? 'es' : ''})`);
      }
    }
  });

  // Contact → domain priors
  words.forEach(word => {
    const cleaned = word.replace(/[^a-z]/g, '');
    if (!cleaned || cleaned.length < 2) return;
    const domain = userContext.contact_priors?.[word];
    if (domain && !hints.some(h => h.includes(word))) {
      hints.push(`Contact "${word}" → ${domain}`);
    }
  });

  // Type priors
  words.forEach(word => {
    const cleaned = word.replace(/[^a-z]/g, '');
    if (!cleaned || cleaned.length < 3) return;
    const type = userContext.type_priors?.[cleaned];
    if (type && !hints.some(h => h.includes(cleaned) && h.includes(type))) {
      hints.push(`"${cleaned}" → usually "${type}" task`);
    }
  });

  if (hints.length === 0) return '';

  return '\n\nRelevant user preferences (only for this capture):\n' +
    hints.slice(0, 5).map(h => '- ' + h).join('\n') +
    '\nUse these as soft guidance, not hard rules.';
}
