// netlify/functions/sms.js  (CJS)  — replace file
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

  // 1) Log inbound (best-effort)
  try {
    await appendRow({
      tabName: 'messages', // known tab; include spaName in columns
      row: [now, spaName, '-', to, from, 'sms', 'inbound', body, 'N/A', '']
    });
  } catch (e) {
    console.error('messages inbound append failed:', e && e.message);
  }

  // 2) Decide reply (placeholder)
  let reply =
    'Thanks! We’ll get you scheduled. Reply C to confirm, RESCHEDULE to move, ' +
    'HELP for help or STOP to opt out. Msg&Data rates may apply.';
  if (/^c$/i.test(body)) {
    reply = 'Confirmed ✅ See you soon! Reply HELP for help or STOP to opt out.';
  }

  // 3) Build TwiML and return 200 no matter what
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);

  // 4) Log outbound (best-effort)
  try {
    await appendRow({
      tabName: 'messages',
      row: [now, spaName, '-', to, from, 'sms', 'outbound:auto', reply, 'N/A', '']
    });
  } catch (e) {
    console.error('messages outbound append failed:', e && e.message);
  }

  return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
};
