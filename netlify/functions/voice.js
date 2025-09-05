/* netlify/functions/voice.js */
const qs = require('qs');
const twilio = require('twilio');
const { xml } = twilio.twiml;
const { GoogleSpreadsheet } = require('google-spreadsheet');

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_MESSAGING_SERVICE_SID,
  SHEETS_CONSENTS_SHEET_ID,
  SHEETS_CLIENT_EMAIL,
  SHEETS_PRIVATE_KEY,
} = process.env;

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// --- helpers ---------------------------------------------------
function twimlResponse(cb) {
  const resp = new twilio.twiml.VoiceResponse();
  cb(resp);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/xml' },
    body: resp.toString(),
  };
}

function yesNoFromInput({ Digits, SpeechResult }) {
  const d = (Digits || '').trim();
  const s = (SpeechResult || '').toLowerCase();
  if (d === '1') return 'yes';
  if (d === '2') return 'no';
  if (s.includes('yes') || s.includes('yah') || s.includes('yep')) return 'yes';
  if (s.includes('no') || s.includes("don't") || s.includes('do not')) return 'no';
  return 'unknown';
}

async function logConsentToSheet({ phone, callSid, result, reason }) {
  if (!SHEETS_CONSENTS_SHEET_ID || !SHEETS_CLIENT_EMAIL || !SHEETS_PRIVATE_KEY) return;
  const doc = new GoogleSpreadsheet(SHEETS_CONSENTS_SHEET_ID);
  await doc.useServiceAccountAuth({
    client_email: SHEETS_CLIENT_EMAIL,
    private_key: SHEETS_PRIVATE_KEY.replace(/\\n/g, '\n'),
  });
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0] || await doc.addSheet({ title: 'consents', headerValues: [
    'timestamp','phone','callSid','result','reason'
  ]});
  await sheet.addRow({
    timestamp: new Date().toISOString(),
    phone,
    callSid,
    result,
    reason: reason || '',
  });
}

async function sendOptInConfirmationSMS({ to }) {
  if (!TWILIO_MESSAGING_SERVICE_SID) return;
  const body =
    'SpaConcierge: You’re opted in for appointment updates (1–3 msgs per visit). Msg&Data rates may apply. For help reply HELP; to opt out reply STOP.';
  await client.messages.create({
    to,
    body,
    messagingServiceSid: TWILIO_MESSAGING_SERVICE_SID,
  });
}

// --- handler ---------------------------------------------------
exports.handler = async (event) => {
  try {
    // Twilio posts x-www-form-urlencoded
    const params = event.body ? qs.parse(event.body) : {};
    const {
      CallSid, From, To, Digits, SpeechResult
    } = params;

    const thisFunctionUrl =
      `https://${event.headers.host}/.netlify/functions/voice`;

    // If no digits/speech -> prompt with IVR
    if (!Digits && !SpeechResult) {
      return twimlResponse((r) => {
        const g = r.gather({
          input: 'dtmf speech',
          numDigits: 1,
          timeout: 6,
          action: thisFunctionUrl,   // post back to same endpoint
          method: 'POST',
        });
        g.say(
          'Thanks for calling. We can text you booking help and appointment updates. ' +
          'To receive texts, press 1 or say Yes. To decline, press 2 or say No. ' +
          'You may receive up to three messages per appointment. Message and data rates may apply. ' +
          'You can get help by replying HELP, or opt out any time by replying STOP. ' +
          'Consent is not a condition of purchase. ' +
          'Our terms are at get spa concierge dot com slash S M S terms, and privacy policy at get spa concierge dot com slash S M S privacy.'
        );
        // Fallback if no input
        r.say('No input received. Goodbye.');
        r.hangup();
      });
    }

    // We got input; decide yes/no
    const yn = yesNoFromInput({ Digits, SpeechResult });

    if (yn === 'yes') {
      // Log consent + send SMS
      await logConsentToSheet({ phone: From, callSid: CallSid, result: 'YES' });
      await sendOptInConfirmationSMS({ to: From });

      return twimlResponse((r) => {
        r.say('Thanks. We just sent you a text confirming enrollment. Goodbye.');
        r.hangup();
      });
    }

    if (yn === 'no') {
      await logConsentToSheet({ phone: From, callSid: CallSid, result: 'NO' });
      return twimlResponse((r) => {
        r.say('No problem. We will not text you. Goodbye.');
        r.hangup();
      });
    }

    // Unknown or unclear input: reprompt once
    return twimlResponse((r) => {
      const g = r.gather({
        input: 'dtmf speech',
        numDigits: 1,
        timeout: 6,
        action: thisFunctionUrl,
        method: 'POST',
      });
      g.say('Sorry, I didn’t catch that. Press 1 or say Yes to receive texts. Press 2 or say No to decline.');
      r.say('No input received. Goodbye.');
      r.hangup();
    });

  } catch (err) {
    console.error('VOICE ERROR', err);
    return twimlResponse((r) => {
      r.say('Sorry, something went wrong on our end. Please try again later.');
      r.hangup();
    });
  }
};
