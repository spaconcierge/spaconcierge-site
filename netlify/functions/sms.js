// sms.js
const { appendRow } = require('./_sheets');
const { spaForNumber } = require('./_spa');
const twilio = require('twilio');
const { google } = require('googleapis');
let OpenAI = require('openai'); OpenAI = OpenAI.default || OpenAI;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 8000 });

/* ----------------------------- Configuration ---------------------------- */
const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT || 8);         // messages to include
const HISTORY_WINDOW_HOURS = Number(process.env.HISTORY_HOURS || 48); // recent window

// Services to detect (customize later per spa)
const SERVICE_WORDS = [
  'facial','massage','massage standard','standard','wax','laser','brow','brows',
  'mani','pedicure','peel','microderm','microdermabrasion','facelift'
];

// Compliance keyword patterns
const OPT_OUT_KEYWORDS = /^(stop|cancel|end|optout|quit|revoke|stopall|unsubscribe)$/i;
const OPT_IN_KEYWORDS  = /^(start|unstop|yes)$/i;
const HELP_KEYWORDS    = /^(help)$/i;

/* ------------------------ Google Sheets (read-only) --------------------- */
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

/* --------------------- Fetch recent conversation turns ------------------ */
// messages!A:J -> timestamp | spa | '-' | to | from | channel | status | body | error | notes
async function fetchRecentHistory({ sheetId, spaName, to, from, limit = HISTORY_LIMIT, windowHours = HISTORY_WINDOW_HOURS }) {
  const sheets = await getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'messages!A:J',
  });
  const rows = resp.data.values || [];
  if (!rows.length) return [];

  const nowMs = Date.now();
  const out = [];

  for (let i = rows.length - 1; i >= 0 && out.length < limit * 2; i--) {
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

    const t = Date.parse(ts);
    if (isFinite(t)) {
      const ageHrs = (nowMs - t) / 3600000;
      if (ageHrs > windowHours) break;
    }

    let role = null;
    if (/^inbound/i.test(status)) role = 'user';
    else if (/^outbound/i.test(status)) role = 'assistant';
    if (!role) continue;

    out.push({ role, content: text });
  }

  return out.reverse().slice(-limit);
}

/* ----------------------------- Slot tracking ---------------------------- */
// Heuristics; calendar integration will replace this.
const timeRe  = /\b(?:[01]?\d|2[0-3])(?::\d{2})?\s?(?:am|pm)\b/i;
const dayRe   = /\b(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i;
const dateRe  = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/;
const monthRe = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?\b/i;
const relRe   = /\b(?:today|tomorrow|tmrw|this (?:mon|tue|wed|thu|fri|sat|sun|weekend))\b/i;
const nameRe  = /\b(?:my name is|name is|i am|i’m|im)\s+([a-z][a-z' -]{1,29})\b/i;

function pickService(text) {
  const t = text.toLowerCase();
  let best = '';
  for (const w of SERVICE_WORDS) {
    if (t.includes(w)) {
      if (w.length > best.length) best = w; // prefer longer phrase
    }
  }
  if (best === 'standard') return 'standard massage';
  return best || '';
}

function whenPhrase(text) {
  const t = text;
  const m = (monthRe.exec(t) || [])[0];
  const d = (dateRe.exec(t)  || [])[0];
  const day = (dayRe.exec(t) || [])[0];
  const rel = (relRe.exec(t) || [])[0];
  const tm  = (timeRe.exec(t)|| [])[0];

  // combine best we can
  if (m && tm)   return `${m} ${tm}`;
  if (d && tm)   return `${d} ${tm}`;
  if (day && tm) return `${day} ${tm}`;
  if (rel && tm) return `${rel} ${tm}`;
  return m || d || day || rel || tm || '';
}

function nameFrom(text) {
  const m = nameRe.exec(text);
  if (!m) return '';
  const raw = m[1].trim();
  return raw.split(/\s+/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
}

function extractSlotsFromMessages(history, currentUserMsg) {
  const slots = { service: '', when: '', name: '' };

  for (const m of history) {
    if (m.role !== 'user') continue;
    if (!slots.service) slots.service = pickService(m.content);
    if (!slots.when)    slots.when    = whenPhrase(m.content);
    if (!slots.name)    slots.name    = nameFrom(m.content);
  }

  if (currentUserMsg) {
    if (!slots.service) slots.service = pickService(currentUserMsg);
    if (!slots.when)    slots.when    = whenPhrase(currentUserMsg);
    if (!slots.name)    slots.name    = nameFrom(currentUserMsg);
  }

  return slots;
}

function missingFields(slots) {
  const miss = [];
  if (!slots.service) miss.push('service');
  if (!slots.when)    miss.push('date/time');
  if (!slots.name)    miss.push('name');
  return miss;
}

/* ----------------------------- Main handler ----------------------------- */
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

  // 2) Compliance keywords (log + let Twilio send its reply)
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
    // AI path with memory + slot tracking
    kind = 'ai';

    let history = [];
    try {
      history = await fetchRecentHistory({ sheetId: SHEET_ID, spaName, to, from });
    } catch (e) {
      console.error('History fetch failed:', e.message);
    }

    const slots = extractSlotsFromMessages(history, body);
    const missing = missingFields(slots);

    const messages = [
      {
        role: "system",
        content:
`You are a helpful receptionist for ${spaName}.
You DO NOT have live calendar access. Never assert availability as a fact.
Use prior context; short follow-ups like “will it work?” refer to the most recent unresolved request.
Known so far (may be empty):
- Service: ${slots.service || '—'}
- When: ${slots.when || '—'}
- Name: ${slots.name || '—'}
Missing fields: ${missing.length ? missing.join(', ') : 'none'}

Behavior:
- If at least one field is missing, ask ONLY for missing fields (one compact question).
- If all fields are present, acknowledge and say you'll hold the request and someone will confirm shortly (no fake confirmations).
- Keep replies to 1–3 SMS-length sentences.`
      },
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

      // If all slots present, log a pending booking row
      if (missing.length === 0) {
        try {
          await appendRow({
            sheetId: SHEET_ID,
            tabName: 'bookings',
            row: [
              now,                 // timestamp_iso
              '',                  // booking_id
              spaName,             // spa_id (using name for now)
              'sms',               // channel
              slots.name,          // name
              from,                // phone
              '',                  // email
              slots.service,       // service
              slots.when,          // start_time (raw phrase for now)
              '',                  // timezone
              'sms',               // source
              '',                  // notes
              '',                  // staff
              'pending',           // status
              '',                  // price
              ''                   // revenue
            ]
          });
        } catch (e) {
          console.error('Pending booking log failed:', e.message);
        }
      }
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
