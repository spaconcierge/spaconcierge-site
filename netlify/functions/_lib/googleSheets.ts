// netlify/functions/_lib/googleSheets.ts
import { google } from 'googleapis';

type SA = { client_email: string; private_key: string };

function parseJsonBlob(raw: string): SA | null {
  try {
    const txt = raw.trim();
    const json = txt.startsWith('{') ? JSON.parse(txt) : JSON.parse(Buffer.from(txt, 'base64').toString('utf8'));
    if (json?.client_email && json?.private_key) {
      return { client_email: json.client_email, private_key: json.private_key };
    }
  } catch {}
  return null;
}

function getServiceAccount(): SA {
  // Preferred: split envs
  const email = process.env.GOOGLE_CLIENT_EMAIL || '';
  let key = process.env.GOOGLE_PRIVATE_KEY || '';

  // Netlify often stores keys with literal \n — convert to real newlines
  if (key) key = key.replace(/\\n/g, '\n');

  if (email && key) return { client_email: email, private_key: key };

  // Fallback: single JSON env var
  const blob = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
  const parsed = blob ? parseJsonBlob(blob) : null;
  if (parsed) return parsed;

  throw new Error('Google SA credentials not found. Provide GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY or GOOGLE_SERVICE_ACCOUNT_JSON.');
}

let cachedSheets: any;

export function getSheets() {
  if (cachedSheets) return cachedSheets;

  const sa = getServiceAccount();
  // (Optional) minimal debug — never print the key:
  console.log('GS AUTH email:', sa.client_email);

  const jwt = new google.auth.JWT(
    sa.client_email,
    undefined,
    sa.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  cachedSheets = google.sheets({ version: 'v4', auth: jwt });
  return cachedSheets;
}

export async function appendRows({
  spreadsheetId,
  tabName,
  values, // array of arrays (rows)
}: {
  spreadsheetId: string;
  tabName: string;
  values: (string | number | null)[][];
}) {
  const sheets = getSheets();
  const range = `${tabName}!A:ZZ`;
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
}

export async function readSheet({
  spreadsheetId,
  tabName,
}: {
  spreadsheetId: string;
  tabName: string;
}) {
  const sheets = getSheets();
  const range = `${tabName}!A:ZZ`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows: string[][] = (res.data.values || []) as any;
  const [headers = [], ...data] = rows;
  return { headers, data };
}
