// netlify/functions/_lib/googleSheets.ts
import { google } from 'googleapis';

let sheetsClient: any;

function decodeServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  return raw.trim().startsWith('{')
    ? JSON.parse(raw)
    : JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
}

export function getSheets() {
  if (sheetsClient) return sheetsClient;

  let jwt;
  const sa = decodeServiceAccount();
  if (sa) {
    // Preferred path: JSON from GOOGLE_SERVICE_ACCOUNT_JSON
    jwt = new google.auth.JWT(
      sa.client_email,
      undefined,
      sa.private_key,
      ['https://www.googleapis.com/auth/spreadsheets']
    );
  } else {
    // Legacy path: individual env vars
    jwt = new google.auth.JWT(
      process.env.GOOGLE_CLIENT_EMAIL,
      undefined,
      (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      ['https://www.googleapis.com/auth/spreadsheets']
    );
  }

  sheetsClient = google.sheets({ version: 'v4', auth: jwt });
  return sheetsClient;
}

export async function appendRows({
  spreadsheetId,
  tabName,
  values,
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
  const [headers, ...data] = rows;
  return { headers, data };
}
}
