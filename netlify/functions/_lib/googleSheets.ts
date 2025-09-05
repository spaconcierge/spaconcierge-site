// netlify/functions/_lib/googleSheets.ts
import { google } from 'googleapis';

let sheetsClient: any;

export function getSheets() {
  if (sheetsClient) return sheetsClient;
  const jwt = new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL,
    undefined,
    (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  sheetsClient = google.sheets({ version: 'v4', auth: jwt });
  return sheetsClient;
}

export async function appendRows({
  spreadsheetId,
  tabName,
  values,                // array of arrays (rows)
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
