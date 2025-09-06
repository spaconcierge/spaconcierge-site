// _sheets.js
const { google } = require('googleapis');

function decodeServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON missing');
  return raw.trim().startsWith('{')
    ? JSON.parse(raw)
    : JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
}

async function getSheets() {
  const creds = decodeServiceAccount();
  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

// Ensures tab exists; creates it if missing
async function ensureSheet({ sheets, spreadsheetId, tabName }) {
  try {
    await sheets.spreadsheets.get({
      spreadsheetId,
      ranges: [tabName]
    });
  } catch {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: tabName } } }]
      }
    });
    console.log(`Created missing sheet tab: ${tabName}`);
  }
}

async function appendRow({ sheetId, tabName, row }) {
  const spreadsheetId =
    sheetId || process.env.SHEET_ID || process.env.GOOGLE_SHEETS_ID;
  if (!spreadsheetId) throw new Error('Missing spreadsheetId (SHEET_ID/GOOGLE_SHEETS_ID)');

  const sheets = await getSheets();

  // Make sure the tab exists
  await ensureSheet({ sheets, spreadsheetId, tabName });

  // Append the row
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tabName}!A:Z`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] }
  });
}

module.exports = { appendRow };
