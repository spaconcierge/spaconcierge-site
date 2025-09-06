// sms.js
const { appendRow } = require('./_sheets');
const { spaForNumber } = require('./_spa');
const twilio = require('twilio');
const { google } = require('googleapis');
let OpenAI = require('openai'); OpenAI = OpenAI.default || OpenAI;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 8000 });

// --- Config for conversational memory ---
const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT || 8);        // messages to include
const HISTORY_WINDOW_HOURS = Number(process.env.HISTORY_HOURS || 48); // only recent ones

// Compliance keyword patterns
const OPT_OUT_KEYWORDS = /^(stop|cancel|end|optout|quit|revoke|stopall|unsubscribe)$/i;
const OPT_IN_KEYWORDS  = /^(start|unstop|yes)$/i;
const HELP_KEYWORDS    = /^(help)$/i;

/* ------------------------ Sheets read client (RO) ------------------------ */
function decodeServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON missing');
  return raw.trim().startsWith('{')
    ? JSON.parse(raw)
    : JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
}

async function getSheetsClient() {
  const sa = decodeServiceAccount();
  const auth = new google.auth.JWT(
    sa.client_email,
    null,
    sa.private_key,
    ['https://www.googleapis.com/auth/spreadsheets.readonly']
  );
  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

/* ------------- Fetch recent conversation for this spa/number ------------- */
async function fetchRecentHistory({ sheetId, spaName, to, from, limit = HISTORY_LIMIT, windowHours = HISTORY_WINDOW_HOURS }) {
  const sheets = await getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'messages!A:J', // timestamp | spa | '-' | to | from | channel | status | body | error | notes
  });
  const rows = resp.data.values || [];
  if (!rows.length) return [];

  const nowMs = Date.now();
  const keep = [];

  for (let i = rows.length - 1; i >= 0 && keep.length < limit * 2; i--) {
    const r = rows[i];
    if (!r || r.length < 8) continue;

    const ts = r[0] || '';
    const spa = r[1] || '';
    const To = r[3] || '';
    const From = r[4] || '';
    const status = (r[6] || '').toString();
    const text = (r[7] || '').toString().trim();

    if (spa !== spaName) continue;
    if (To !== to || From !== from) continue;
    if (!text) continue;

    // Skip compliance/system events
    if (/^inbound:(optout|optin|help)/i.test(status)) continue;

    // Respect session window
    const t = Date.parse(ts);
    if (isFinite(t)) {
      const ageHrs = (nowMs - t) / 3600000;
      if (ageHrs > windowHours) break;
    }

    let role = null;
    if (/^inbound/i.test(status)) role = 'user';
    else if (/^outbound/i.test(status)) role = 'assistant';
    if (!role) continue;

    keep.push({ role, content: text });
  }

  return keep.reverse().slice(-limit);
}

/* ---------------- Small “intent hint” from recent user text -------------- */
// Extremely lightweight: look backward for the last user message that
// likely mentions date/time/service and surface it as a hint.
function extractIntentHint(history) {
  if (!Array.isArray(history) || !history.length) return '';

  // patterns for times/days/services (simple but effective)
  const timeRe = /\b([01]?\d|2[0-3])(:\d{2})?\s?(am|pm)\b/i;
  const dayRe = /\b(mon(day)?|tue(sday)?|wed(nesday)?|thu(rsday)?|fri(day)?|sat(urday)?|sun(day)?)\b/i;
  const dateRe = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/;
  const serviceRe = /\b(facial|massage|wax|laser|brows?|mani|pedi|peel|micro(?:derm)?|facelift)\b/i;

  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== 'user') continue;
    const txt = m.content || '';
    if (timeRe.test(txt) || dayRe.test(txt) || dateRe.test(txt) || serviceRe.test(txt)) {
      return txt.length > 260 ? (txt.slice(0, 257) + '…') : txt;
    }
  }
  return '';
}

exports.handler = async (event) => {
  const params = new URLSearchParams(event.body || '');
  const from = params.get('From') || ''; // customer (E.164)
  const to   = params.get('To')   || ''; // our Twilio number (E.164)
  const body = (params.get('Body') || '').trim();
  const spaName = spaForNumber(to);
  const now = new Date().toISOString();

  const SHEET_ID = process.env.SHEET_ID || process.env.GOOGLE_SHEETS_ID;

  // 1) Log inbound
  try {
    await appendRow({
      sheetId: SHEET_ID,
      tabName: 'messages',
      row: [now, spaName, '-', to, from, 'sms', 'inbound', body, 'N/A', '']
    });
  } catch (e) {
    console.error('Inbound log failed:', e.message);
  }

  // 2) Compliance keywords
  if (OPT_OUT_KEYWORDS.test(body) || OPT_IN_KEYWORDS.test(body) || HELP_KEYWORDS.test(body)) {
    let complianceType = 'compliance';
    if (OPT_OUT_KEYWORDS.test(body)) complianceType = 'optout';
    if (OPT_IN_KEYWORDS.test(body))  complianceType = 'optin';
    if (HELP_KEYWORDS.test(body))    complianceType = 'help';

    try {
      await appendRow({
        sheetId: SHEET_ID,
        tabName: 'messages',
        row: [now, spaName, '-', to, from, 'sms', `inbound:${complianceType}`, body, 'N/A', '']
      });
    } catch (e) {
      console.error('Compliance log failed:', e.message);
    }
    // Let Twilio send the official compliance reply
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
    // GPT path with history + intent hint
    kind = 'ai';

    let history = [];
    try {
      history = await fetchRecentHistory({ sheetId: SHEET_ID, spaName, to, from });
    } catch (e) {
      console.error('History fetch failed:', e.message);
    }
    const intentHint = extractIntentHint(history);

    const messages = [
      {
        role: "system",
        content:
`You are a helpful receptionist for ${spaName}.
- Always use prior context; short follow-ups like “will it work?” or “that’s fine” refer to the most recent unresolved request (date/time/service).
- You DO NOT have live calendar access. Never assert availability as a fact.
- When asked to book or confirm, gather missing details (service, date, time, name) or propose next steps (two alternate times or the booking link).
- Stay concise (1–3 SMS-length sentences).`
      },
      ...(intentHint ? [{ role: "system", content: `Context hint (last user intent): ${intentHint}` }] : []),
      ...history,
      { role: "user", content: body }
    ];

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.3,
        messages
      });
      reply = (completion.choices?.[0]?.message?.content || '').trim();
      if (!reply) throw new Error('Empty AI reply');
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
      sheetId: SHEET_ID,
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
