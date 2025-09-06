// consent.js
const twilio = require('twilio');
const { appendRow } = require('./_sheets');
const { spaForNumber } = require('./_spa');

const YES_RE = /^(y|yes|yeah|yep|ok|okay|sure)/i;

exports.handler = async (event) => {
  const params = new URLSearchParams(event.body || '');
  const callSid = params.get('CallSid') || '';
  const to = params.get('To') || '';
  const from = params.get('From') || '';
  const digits = (params.get('Digits') || '').trim();
  const speech = (params.get('SpeechResult') || '').trim().toLowerCase();
  const accepted = digits === '1' || YES_RE.test(speech);

  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  const spaName = spaForNumber(to);
  const now = new Date().toISOString();

  // --- 1. Log consent decision ---
  try {
    await appendRow({
      // prefer explicit env, fallback handled inside _sheets
      sheetId: process.env.SHEET_ID || process.env.GOOGLE_SHEETS_ID,
      tabName: 'consents', // stable tab, include spaName as a column
      row: [
        now, spaName, callSid, to, from,
        'voice', 'consent', '-', accepted ? 'YES' : 'NO', speech || digits
      ]
    });
  } catch (e) {
    console.error('Consent log append failed:', e.message);
  }

  if (accepted) {
    // --- 2. Send the “first text” ---
    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    const body =
      `Hi — thanks for calling ${spaName}. We missed you but can help by text. ` +
      `Msg&Data rates may apply. Reply HELP for help or STOP to opt out.`;

    try {
      await client.messages.create({ to: from, from: to, body });

      // --- 3. Log SMS send success ---
      try {
        await appendRow({
          sheetId: process.env.SHEET_ID || process.env.GOOGLE_SHEETS_ID,
          tabName: 'messages',
          row: [
            now, spaName, callSid, to, from,
            'sms', 'outbound:first', body, 'N/A', 'sent after consent'
          ]
        });
      } catch (e) {
        console.error('SMS send log append failed:', e.message);
      }

    } catch (e) {
      console.error('Twilio SMS send failed:', e.message);

      // --- 4. Log SMS send failure ---
      try {
        await appendRow({
          sheetId: process.env.SHEET_ID || process.env.GOOGLE_SHEETS_ID,
          tabName: 'messages',
          row: [
            now, spaName, callSid, to, from,
            'sms', 'error', e.message, 'N/A', 'send failed'
          ]
        });
      } catch (e2) {
        console.error('SMS failure log append failed:', e2.message);
      }
    }

    twiml.say('Thanks. We just sent you a text to continue. Goodbye.');
  } else {
    twiml.say('Okay, we will not text you. Goodbye.');
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/xml' },
    body: twiml.toString()
  };
};
