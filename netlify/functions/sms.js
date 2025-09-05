// sms.js
const { appendRow } = require('./_sheets');
const { spaForNumber } = require('./_spa');
const twilio = require('twilio');

exports.handler = async (event) => {
  const params = new URLSearchParams(event.body || '');
  const from = params.get('From') || '';
  const to = params.get('To') || '';
  const body = (params.get('Body') || '').trim();
  const spaName = spaForNumber(to);
  const now = new Date().toISOString();

  // Log inbound SMS
  await appendRow({
    sheetId: process.env.SHEET_ID,
    tabName: spaName,
    row: [now, '-', to, from, 'sms', 'inbound', body, 'N/A', '']
  });

  // Very simple router (you can drop in your existing logic here)
  let reply =
    'Thanks! We’ll get you scheduled. Reply C to confirm, ' +
    'RESCHEDULE to move, HELP for help or STOP to opt out. ' +
    'Msg&Data rates may apply.';

  // Example: confirm keyword “C”
  if (/^c$/i.test(body)) {
    reply = 'Confirmed ✅ See you soon! Reply HELP for help or STOP to opt out.';
  }

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);

  // Log outbound SMS
  await appendRow({
    sheetId: process.env.SHEET_ID,
    tabName: spaName,
    row: [now, '-', to, from, 'sms', 'outbound:auto', reply, 'N/A', '']
  });

  return {
    statusCode: 200,
    headers: {'Content-Type': 'application/xml'},
    body: twiml.toString()
  };
};
