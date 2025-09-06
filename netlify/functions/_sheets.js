// netlify/functions/_sheets.js
const { google } = require('googleapis');

function parseJsonBlob(raw) {
  try {
    const txt = String(raw || '').trim();
    const json = txt.startsWith('{') ? JSON.parse(txt) : JSON.parse(Buffer.from(txt, 'base64').toString('utf8'));
    if (json && json.client_email && json.private_key) {
      return { client_email: json.client_email, private_key: json.private_key };
    }
  } catch {}
  return null;
}

function getServiceAccount() {
  // Preferred split vars
  let email = process.env.GOOGLE_CLIENT_EMAIL || '';
  let key = process.env.GOOGLE_PRIVATE_KEY || '';
  if (key) key = key.replace(/\\n/g, '\n');

  if (email && key) return { client_email: email, private_key: key };

  // Fallback JSON blob
  const blob = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
  const parsed = parseJsonBlob(blob);
  if (parsed) return parsed;

  throw new Error('Google SA credentials missing (need GOOGLE_CLIENT_EMAIL+GOOGLE_PRIVATE_KEY or GOOGLE_SERVICE_ACCOUNT_JSON).');
}

async function getSheets() {
  const sa = getServiceAccount();
  const auth = new google.auth.JWT(
    sa.client_email,
    null,
    sa.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  // googleapis will authorize lazily; no need to await auth.authorize()
  return google.sheets({ version: 'v4', auth });
}

// Ensure tab exists
async function ensureSheet({ sheets, spreadsheetId, tabName }) {
  try {
    await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tabName}!A:A` });
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
