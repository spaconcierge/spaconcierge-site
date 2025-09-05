// _sheets.js
const {google} = require('googleapis');

function decodeServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON missing');
  try {
    // allow plain JSON or base64 JSON
    return raw.trim().startsWith('{')
      ? JSON.parse(raw)
      : JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch (e) {
    throw new Error('Invalid GOOGLE_SERVICE_ACCOUNT_JSON: ' + e.message);
  }
}

async function getSheets() {
  const credentials = decodeServiceAccount();
  const auth = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  await auth.authorize();
  const sheets = google.sheets({version: 'v4', auth});
  return sheets;
}

async function appendRow({sheetId, tabName, row}) {
  const sheets = await getSheets();
  const range = `${tabName}!A:Z`;
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] }
  });
}

module.exports = { appendRow };
