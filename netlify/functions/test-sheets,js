const { appendRow } = require('./_sheets');

exports.handler = async () => {
  try {
    await appendRow({
      sheetId: process.env.SHEET_ID || process.env.GOOGLE_SHEETS_ID,
      tabName: 'test',
      row: [new Date().toISOString(), 'test function write']
    });
    return { statusCode: 200, body: "✅ Wrote row to Sheets" };
  } catch (e) {
    console.error("Sheets write failed:", e);
    return { statusCode: 500, body: "❌ Error: " + e.message };
  }
};
