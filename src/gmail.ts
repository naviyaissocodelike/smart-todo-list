import { OAuth2Client } from 'google-auth-library';
import { db } from './db';

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REDIRECT_URI = process.env.GMAIL_REDIRECT_URI || 'http://localhost:3456/auth/gmail/callback';

function getClient() {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET not set');
  return new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

export function getAuthUrl(): string {
  const client = getClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.modify'],
    prompt: 'consent'
  });
}

export async function handleCallback(code: string) {
  const client = getClient();
  const { tokens } = await client.getToken(code);
  db.setGmailTokens({
    access_token: tokens.access_token!,
    refresh_token: tokens.refresh_token!,
    expiry_date: tokens.expiry_date!
  });
  return tokens;
}

export async function createDraft(to: string, subject: string, body: string) {
  const tokens = db.getGmailTokens();
  if (!tokens) throw new Error('Gmail not authenticated. Visit /auth/gmail first.');

  const client = getClient();
  client.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date
  });

  let accessToken = tokens.access_token;
  if (tokens.expiry_date && Date.now() > tokens.expiry_date) {
    const { credentials } = await client.refreshAccessToken();
    accessToken = credentials.access_token!;
    db.setGmailTokens({
      access_token: credentials.access_token!,
      refresh_token: credentials.refresh_token || tokens.refresh_token,
      expiry_date: credentials.expiry_date!
    });
  }

  const raw = makeEmail(to, subject, body);
  const encoded = Buffer.from(raw)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message: { raw: encoded } })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gmail API error ${res.status}: ${err}`);
  }
  return res.json();
}

function makeEmail(to: string, subject: string, body: string) {
  return `To: ${to}\nFrom: me\nSubject: ${subject}\nContent-Type: text/plain; charset=utf-8\n\n${body}`;
}
