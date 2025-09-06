// sms.js
const { appendRow } = require('./_sheets');
const { spaForNumber } = require('./_spa');
const twilio = require('twilio');

exports.handler = async (event) => {
  const params = new URLSearchParams(event.body || '');
  const from = params.get('From') || '';
  const to   = params.get('To')   || '';
  const body = (params.get('Body') || '').trim();
  const spaName = spaForNumber(to);
  const now = new Date().toISOString();

  // 1) Log inbound SMS (best-effort)
  try {
    await appendRow({
      sheetId: process.env.SHEET_ID || process.env.GOOGLE_SHEETS_ID,
      tabName: 'messages', // stable tab; include spaName as a column
      row: [now, spaName, '-', to, from, 'sms', 'inbound', body, 'N/A', '']
    });
  } catch (e) {
    console.error('Inbound log failed:', e.message);
  }

  // 2) Decide reply
  let reply =
    'Thanks! We’ll get you scheduled. Reply C to confirm, ' +
    'RESCHEDULE to move, HELP for help or STOP to opt out. ' +
    'Msg&Data rates may apply.';
  if (/^c$/i.test(body)) {
    reply = 'Confirmed ✅ See you soon! Reply HELP for help or STOP to opt out.';
  }

  // 3) Build TwiML (always returned, no matter what)
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);

  // 4) Log outbound SMS (best-effort)
  try {
    await appendRow({
      sheetId: process.env.SHEET_ID || process.env.GOOGLE_SHEETS_ID,
      tabName: 'messages',
      row: [now, spaName, '-', to, from, 'sms', 'outbound:auto', reply, 'N/A', '']
    });
  } catch (e) {
    console.error('Outbound log failed:', e.message);
  }

  // 5) Always return a 200 with TwiML so Twilio is happy
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/xml' },
    body: twiml.toString()
  };
};
