// netlify/functions/gs-sanity.js
const { readSheet } = require('./_lib/googleSheets');

exports.handler = async () => {
  try {
    const spreadsheetId = process.env.SHEETS_CONFIG_ID;
    if (!spreadsheetId) throw new Error('SHEETS_CONFIG_ID missing');

    const { headers, data } = await readSheet({ spreadsheetId, tabName: 'spas' });
    const preview = [headers, ...(data || [])].slice(0, 3);
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, rows_preview: preview }),
      headers: { 'Content-Type': 'application/json' }
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
