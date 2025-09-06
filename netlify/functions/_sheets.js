/// _sheets.js (SAFE PATCH for split creds)
const { google } = require('googleapis');

function buildAuth() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey  = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (clientEmail && privateKey) {
    return new google.auth.JWT(
      clientEmail,
      null,
      privateKey,
      ['https://www.googleapis.com/auth/spreadsheets']
    );
  }

  // fallback to legacy big JSON
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('No Google creds: set GOOGLE_CLIENT_EMAIL/GOOGLE_PRIVATE_KEY or GOOGLE_SERVICE_ACCOUNT_JSON');

  const creds = raw.trim().startsWith('{')
    ? JSON.parse(raw)
    : JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));

  return new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
}

async function getSheets() {
  const auth = buildAuth();
  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

async function ensureSheet({ sheets, spreadsheetId, tabName }) {
  try {
    await sheets.spreadsheets.get({ spreadsheetId, ranges: [tabName] });
  } catch {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] }
    });
    console.log(`Created missing sheet tab: ${tabName}`);
  }
}

async function appendRow({ sheetId, tabName, row }) {
  const spreadsheetId = sheetId || process.env.SHEET_ID || process.env.GOOGLE_SHEETS_ID;
  if (!spreadsheetId) throw new Error('Missing spreadsheetId (SHEET_ID/GOOGLE_SHEETS_ID)');
  const sheets = await getSheets();
  await ensureSheet({ sheets, spreadsheetId, tabName });
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tabName}!A:Z`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] }
  });
}

module.exports = { appendRow };
