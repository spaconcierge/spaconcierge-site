// sms.js
const { appendRow } = require('./_sheets');
const { spaForNumber } = require('./_spa');
const twilio = require('twilio');
const { google } = require('googleapis');
let OpenAI = require('openai'); OpenAI = OpenAI.default || OpenAI;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 8000 });

// --- Config for conversational memory ---
const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT || 8);       // how many past exchanges to include
const HISTORY_WINDOW_HOURS = Number(process.env.HISTORY_HOURS || 48); // only recent history

// Compliance keyword patterns
const OPT_OUT_KEYWORDS = /^(stop|cancel|end|optout|quit|revoke|stopall|unsubscribe)$/i;
const OPT_IN_KEYWORDS  = /^(start|unstop|yes)$/i;
const HELP_KEYWORDS    = /^(help)$/i;

// --- Minimal Sheets read client (independent of _sheets.appendRow) ---
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

// Fetch recent conversation for this spa+phone from the messages tab
async function fetchRecentHistory({ sheetId, spaName, to, from, limit = HISTORY_LIMIT, windowHours = HISTORY_WINDOW_HOURS }) {
  const sheets = await getSheetsClient();
  // Read the whole messages sheet; filter in code (simple + robust for now)
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'messages!A:J', // timestamp | spa | '-' | to | from | channel | status | body | error | notes
  });
  const rows = resp.data.values || [];
  if (!rows.length) return [];

  const nowMs = Date.now();
  const results = [];

  // Walk from bottom (most recent) upward until we collect enough
  for (let i = rows.length - 1; i >= 0 && results.length < limit * 2; i--) {
    const r = rows[i];
    if (!r || r.length < 8) continue;

    const ts = r[0] || '';
    const spa = r[1] || '';
    const To = r[3] || '';
    const From = r[4] || '';
    const status = (r[6] || '').toString();
    const text = (r[7] || '').toString().trim();

    // Filter to this conversation
    if (spa !== spaName) continue;
    if (To !== to || From !== from) continue;
    if (!text) continue;

    // Skip compliance/system events
    if (/^inbound:(optout|optin|help)/i.test(status)) continue;

    // Respect session window
    const t = Date.parse(ts);
    if (isFinite(t)) {
      const ageHrs = (nowMs - t) / 3600000;
      if (ageHrs > windowHours) break; // older than window → stop scanning further
    }

    // Map to chat roles
    let role = null;
    if (/^inbound/i.test(status)) role = 'user';
    else if (/^outbound/i.test(status)) role = 'assistant';
    if (!role) continue;

    results.push({ role, content: text });
  }

  // Return the last N in chronological order
  return results.reverse().slice(-limit);
}

exports.handler = async (event) => {
  const params = new URLSearchParams(event.body || '');
  const from = params.get('From') || ''; // customer phone (E.164)
  const to   = params.get('To')   || ''; // your Twilio number (E.164)
  const body = (params.get('Body') || '').trim();
  const spaName = spaForNumber(to);
  const now = new Date().toISOString();

  const SHEET_ID = process.env.SHEET_ID || process.env.GOOGLE_SHEETS_ID;

  // 1) Log inbound (always)
  try {
    await appendRow({
      sheetId: SHEET_ID,
      tabName: 'messages',
      row: [now, spaName, '-', to, from, 'sms', 'inbound', body, 'N/A', '']
    });
  } catch (e) {
    console.error('Inbound log failed:', e.message);
  }

  // 2) Compliance keyword logging (STOP/START/HELP)
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

    // Let Twilio handle the official compliance auto-response; we return empty TwiML
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
    // Everything else → GPT, **with short conversation history**
    kind = 'ai';

    // Build chat history (best-effort; non-blocking if it fails)
    let history = [];
    try {
      history = await fetchRecentHistory({ sheetId: SHEET_ID, spaName, to, from });
    } catch (e) {
      console.error('History fetch failed:', e.message);
    }

    const messages = [
      {
        role: "system",
        content: `You are a helpful receptionist for ${spaName}. 
                  Reply in 1–3 concise SMS sentences. 
                  Use context from prior messages if present. 
                  If unsure, ask a clarifying question.`
      },
      ...history,                 // prior turns: user/assistant pairs
      { role: "user", content: body } // current user message
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
