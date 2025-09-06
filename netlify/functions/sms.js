// sms.js
const { appendRow } = require('./_sheets');
const { spaForNumber } = require('./_spa');
const twilio = require('twilio');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 8000 });

// Define opt-out / opt-in / help keywords we want to log
const OPT_OUT_KEYWORDS = /^(stop|cancel|end|optout|quit|revoke|stopall|unsubscribe)$/i;
const OPT_IN_KEYWORDS  = /^(start|unstop|yes)$/i;
const HELP_KEYWORDS    = /^(help)$/i;

exports.handler = async (event) => {
  const params = new URLSearchParams(event.body || '');
  const from = params.get('From') || '';
  const to   = params.get('To')   || '';
  const body = (params.get('Body') || '').trim();
  const spaName = spaForNumber(to);
  const now = new Date().toISOString();

  // 1) Log inbound (always)
  try {
    await appendRow({
      sheetId: process.env.SHEET_ID || process.env.GOOGLE_SHEETS_ID,
      tabName: 'messages',
      row: [now, spaName, '-', to, from, 'sms', 'inbound', body, 'N/A', '']
    });
  } catch (e) {
    console.error('Inbound log failed:', e.message);
  }

  // 2) Compliance keyword logging
  if (OPT_OUT_KEYWORDS.test(body) || OPT_IN_KEYWORDS.test(body) || HELP_KEYWORDS.test(body)) {
    let complianceType = 'compliance';
    if (OPT_OUT_KEYWORDS.test(body)) complianceType = 'optout';
    if (OPT_IN_KEYWORDS.test(body))  complianceType = 'optin';
    if (HELP_KEYWORDS.test(body))    complianceType = 'help';

    try {
      await appendRow({
        sheetId: process.env.SHEET_ID || process.env.GOOGLE_SHEETS_ID,
        tabName: 'messages',
        row: [now, spaName, '-', to, from, 'sms', `inbound:${complianceType}`, body, 'N/A', '']
      });
    } catch (e) {
      console.error('Compliance log failed:', e.message);
    }

    // Don’t override Twilio’s built-in compliance handling
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/xml' },
      body: new twilio.twiml.MessagingResponse().toString()
    };
  }

  // 3) Decide reply
  let reply;
  let kind = 'auto';

  if (/^c$/i.test(body)) {
    reply = 'Confirmed ✅ See you soon! Reply HELP for help or STOP to opt out.';
  } else if (/^reschedule$/i.test(body)) {
    reply = 'Sure, please tell us your preferred date/time.';
  } else {
    // Everything else goes to GPT
    kind = 'ai';
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are a helpful receptionist for ${spaName}.
                      Answer in under 3 sentences, SMS style.`
          },
          { role: "user", content: body }
        ],
      });
      reply = completion.choices[0].message.content.trim();
    } catch (e) {
      console.error("OpenAI error:", e.message);
      kind = 'auto';
      reply = "Thanks for your message — we’ll get back to you shortly.";
    }
  }

  // 4) TwiML response
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);

  // 5) Log outbound
  try {
    await appendRow({
      sheetId: process.env.SHEET_ID || process.env.GOOGLE_SHEETS_ID,
      tabName: 'messages',
      row: [now, spaName, '-', to, from, 'sms', `outbound:${kind}`, reply, 'N/A', '']
    });
  } catch (e) {
    console.error('Outbound log failed:', e.message);
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/xml' },
    body: twiml.toString()
  };
};
