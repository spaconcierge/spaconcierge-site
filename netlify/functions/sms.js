// sms.js
console.log("SHEETS_CONFIG_ID is", process.env.SHEETS_CONFIG_ID);
const { appendRow } = require('./_sheets');
const { spaForNumber } = require('./_spa');                 // legacy display name for sheet rows
const { getConfigs } = require('./_lib/config');            // ← use your existing config.ts
const twilio = require('twilio');
const { google } = require('googleapis');
let OpenAI = require('openai'); OpenAI = OpenAI.default || OpenAI;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 8000 });

/* ----------------------------- Configuration ---------------------------- */
const HISTORY_LIMIT        = Number(process.env.HISTORY_LIMIT  || 10); // conversation memory
const HISTORY_WINDOW_HOURS = Number(process.env.HISTORY_HOURS || 48);  // recent window

// Compliance keyword patterns (log + let Twilio advanced opt-out respond)
const OPT_OUT_KEYWORDS = /^(stop|cancel|end|optout|quit|revoke|stopall|unsubscribe)$/i;
const OPT_IN_KEYWORDS  = /^(start|unstop|yes)$/i;
const HELP_KEYWORDS    = /^(help)$/i;

/* ---------------------- Helpers: phone normalization -------------------- */
function normalize(num) {
  if (!num) return '';
  const digits = String(num).replace(/[^\d]/g, '');
  return digits.replace(/^1/, ''); // drop US country code if present
}

/* -------------------------- Google Sheets auth -------------------------- */
function decodeServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON missing');
  return raw.trim().startsWith('{')
    ? JSON.parse(raw)
    : JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
}

async function getSheetsClient(scope = 'https://www.googleapis.com/auth/spreadsheets.readonly') {
  const sa = decodeServiceAccount();
  const auth = new google.auth.JWT(sa.client_email, null, sa.private_key, [scope]);
  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

/* --------------------------- Per-SPA runtime load ----------------------- */
/** Load the active spa record for this inbound Twilio number. */
async function loadSpaRuntime(e164ToNumber) {
  const cfgs = await getConfigs(); // { bySpaId, byNumber }
  const bySpaId = cfgs.bySpaId || {};
  const byNumber = cfgs.byNumber || {};

  const normTo = normalize(e164ToNumber);

  // try direct, normalized, and "+<normalized>" keys
  let spaId = byNumber[e164ToNumber]
           || byNumber[normTo]
           || byNumber['+' + normTo];

  // if still not found, try scanning keys (handles any other formatting)
  if (!spaId) {
    for (const [k, v] of Object.entries(byNumber)) {
      if (normalize(k) === normTo) { spaId = v; break; }
    }
  }

  const spaConf = spaId ? bySpaId[spaId] : null;

  // Messages/Bookings sheets: prefer per-spa sheet IDs; else default SHEET_ID
  const DEFAULT_SHEET_ID = process.env.SHEET_ID || process.env.GOOGLE_SHEETS_ID;
  const messagesSheetId = (spaConf && spaConf.sheets_ops_messages_id) || DEFAULT_SHEET_ID;
  const bookingsSheetId = (spaConf && spaConf.sheets_ops_bookings_id) || DEFAULT_SHEET_ID;

  // Human-friendly spa name used in your sheet’s “spa” column (keep legacy mapping for continuity)
  const spaSheetKey = spaForNumber(e164ToNumber); // e.g., "Hallovich Spa" as you’ve been logging
  const spaDisplayName = (spaConf && spaConf.spa_name) || spaSheetKey || 'Spa';

  // Timezone & hours
  let tz = (spaConf && (spaConf.tz || process.env.DEFAULT_TIMEZONE)) || 'America/New_York';
  let hours = null;
  if (spaConf && spaConf.hours_json) {
    try { hours = JSON.parse(spaConf.hours_json); } catch {}
  }

  // Optional per-spa “services_json” and AI tone/extra (add these columns later if you want)
  let services = null;
  if (spaConf && spaConf.services_json) {
    try { services = JSON.parse(spaConf.services_json); } catch {}
  }
  const aiTone  = (spaConf && spaConf.greeting_template)      ? 'friendly, concise, professional' : 'friendly, concise, professional';
  const aiExtra = (spaConf && spaConf.after_hours_template)   ? 'Be clear about after-hours replies if relevant.' : 'None.';

  return {
    spaId: spaId || 'default',
    spaSheetKey,        // what we write in the "spa" column to stay consistent with your existing rows
    spaDisplayName,     // what we say to users in replies
    tz,
    hours,              // may be null
    services,           // may be null; we’ll fallback to defaults below
    messagesSheetId,
    bookingsSheetId,
    msid: spaConf && spaConf.msid ? spaConf.msid : '',
    aiTone,
    aiExtra
  };
}

/* --------------------------- History from Sheets ------------------------ */
// messages!A:J -> timestamp | spa | '-' | to | from | channel | status | body | error | notes
async function fetchRecentHistory({ messagesSheetId, spaKey, to, from, limit = HISTORY_LIMIT, windowHours = HISTORY_WINDOW_HOURS }) {
  const sheets = await getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: messagesSheetId,
    range: 'messages!A:J',
  });
  const rows = resp.data.values || [];
  if (!rows.length) return [];

  const nowMs = Date.now();
  const out = [];
  const normTo = normalize(to);
  const normFrom = normalize(from);

  for (let i = rows.length - 1; i >= 0 && out.length < limit * 2; i--) {
    const r = rows[i];
    if (!r || r.length < 8) continue;

    const ts     = r[0] || '';
    const spa    = r[1] || '';
    const To     = normalize(r[3] || '');
    const From   = normalize(r[4] || '');
    const status = (r[6] || '').toString();
    const text   = (r[7] || '').toString().trim();

    if (spa !== spaKey) continue;
    const matchesPair =
      (To === normTo && From === normFrom) ||
      (To === normFrom && From === normTo);
    if (!matchesPair) continue;

    if (!text) continue;
    if (/^inbound:(optout|optin|help)/i.test(status)) continue;

    const t = Date.parse(ts);
    if (isFinite(t)) {
      const ageHrs = (nowMs - t) / 3600000;
      if (ageHrs > windowHours) break;
    }

    let role = null;
    if (/^inbound/i.test(status))  role = 'user';
    else if (/^outbound/i.test(status)) role = 'assistant';
    if (!role) continue;

    out.push({ role, content: text });
  }

  return out.reverse().slice(-limit);
}

/* ----------------------------- Slot tracking ---------------------------- */
// Basic regex helpers
const timeRe  = /\b(?:[01]?\d|2[0-3])(?::\d{2})?\s?(?:am|pm)\b/i;
const dayRe   = /\b(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i;
const dateRe  = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/;
const monthRe = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?\b/i;
const relRe   = /\b(?:today|tomorrow|tmrw|this (?:mon|tue|wed|thu|fri|sat|sun|weekend))\b/i;
const namePhraseRe  = /\b(?:my name(?:'s)? is|name is|i am|i'm|im|this is)\s+([a-z][a-z' -]{1,29})\b/i;

// Default service catalog if none provided by config sheet (extend later via services_json)
const DEFAULT_SERVICES = [
  { key: "facial",  variants: ["facial","classic facial","deep cleanse facial"], duration_min: 60, price: 120 },
  { key: "massage", variants: ["massage","standard massage","massage standard","relaxation massage"], duration_min: 60, price: 100 },
  { key: "brows",   variants: ["brow","brows","brow shaping","eyebrow"], duration_min: 30, price: 35 },
  { key: "wax",     variants: ["wax","waxing"], duration_min: 30, price: 45 },
  { key: "laser",   variants: ["laser","laser hair removal"], duration_min: 45, price: 150 }
];

function titleCase(s) {
  return String(s || '').trim().replace(/\s+/g, ' ')
    .split(' ')
    .map(x => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase())
    .join(' ');
}

function makeServiceIndex(services) {
  const variantToKey = new Map();
  const variants = [];
  for (const svc of services || []) {
    const key = String(svc.key || '').toLowerCase();
    const list = [key, ...(svc.variants || [])];
    for (const v of list) {
      const vv = String(v || '').toLowerCase().trim();
      if (!vv) continue;
      variants.push(vv);
      if (!variantToKey.has(vv)) variantToKey.set(vv, key);
    }
  }
  variants.sort((a,b) => b.length - a.length); // prefer longest phrase
  return { variantToKey, variants };
}

function pickService(text, svcIndex) {
  const t = String(text || '').toLowerCase();
  for (const v of svcIndex.variants) {
    if (t.includes(v)) return svcIndex.variantToKey.get(v) || '';
  }
  return '';
}

function whenPhrase(text) {
  const t = String(text || '');
  const m   = (monthRe.exec(t) || [])[0];
  const d   = (dateRe.exec(t)  || [])[0];
  const day = (dayRe.exec(t)   || [])[0];
  const rel = (relRe.exec(t)   || [])[0];
  const tm  = (timeRe.exec(t)  || [])[0];

  if (m && tm)   return `${m} ${tm}`;
  if (d && tm)   return `${d} ${tm}`;
  if (day && tm) return `${day} ${tm}`;
  if (rel && tm) return `${rel} ${tm}`;
  return m || d || day || rel || tm || '';
}

function nameFrom(text, svcIndex) {
  const t = String(text || '');
  const m1 = namePhraseRe.exec(t);
  if (m1) return titleCase(m1[1]);

  // bare first token (avoid service words)
  const m2 = /^([a-z][a-z' -]{1,29})(?:,|\s|$)/i.exec(t.trim());
  if (m2) {
    const candidate = m2[1].toLowerCase();
    if (!svcIndex.variants.some(w => candidate.includes(w))) return titleCase(candidate);
  }
  return '';
}

function extractSlotsFromMessages(history, currentUserMsg, svcIndex) {
  const slots = { service: '', when: '', name: '' };
  for (const m of history) {
    if (m.role !== 'user') continue;
    if (!slots.service) slots.service = pickService(m.content, svcIndex);
    if (!slots.when)    slots.when    = whenPhrase(m.content);
    if (!slots.name)    slots.name    = nameFrom(m.content, svcIndex);
  }
  if (currentUserMsg) {
    if (!slots.service) slots.service = pickService(currentUserMsg, svcIndex);
    if (!slots.when)    slots.when    = whenPhrase(currentUserMsg);
    if (!slots.name)    slots.name    = nameFrom(currentUserMsg, svcIndex);
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

  // Load runtime config for this spa (by Twilio "to" number)
  const runtime = await loadSpaRuntime(to);
  const spaSheetKey    = runtime.spaSheetKey;     // for sheet rows (keeps your history continuity)
  const spaDisplayName = runtime.spaDisplayName;  // user-facing name
  const messagesSheetId = runtime.messagesSheetId;
  const bookingsSheetId = runtime.bookingsSheetId;
  const services = runtime.services || DEFAULT_SERVICES;
  const svcIndex = makeServiceIndex(services);

  const now = new Date().toISOString();

  // 1) Log inbound
  try {
    await appendRow({
      sheetId: messagesSheetId,
      tabName: 'messages',
      row: [now, spaSheetKey, '-', to, from, 'sms', 'inbound', body, 'N/A', '']
    });
  } catch (e) { console.error('Inbound log failed:', e.message); }

  // 2) Compliance keywords (log + let Twilio auto-reply)
  if (OPT_OUT_KEYWORDS.test(body) || OPT_IN_KEYWORDS.test(body) || HELP_KEYWORDS.test(body)) {
    let complianceType = 'compliance';
    if (OPT_OUT_KEYWORDS.test(body)) complianceType = 'optout';
    if (OPT_IN_KEYWORDS.test(body))  complianceType = 'optin';
    if (HELP_KEYWORDS.test(body))    complianceType = 'help';

    try {
      await appendRow({
        sheetId: messagesSheetId,
        tabName: 'messages',
        row: [now, spaSheetKey, '-', to, from, 'sms', `inbound:${complianceType}`, body, 'N/A', '']
      });
    } catch (e) { console.error('Compliance log failed:', e.message); }

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
    reply = 'Sure — what date and time would you like instead?';
  } else {
    // AI path with memory + slots
    kind = 'ai';

    let history = [];
    try {
      history = await fetchRecentHistory({
        messagesSheetId,
        spaKey: spaSheetKey,
        to, from
      });
    } catch (e) {
      console.error('History fetch failed:', e.message);
    }

    const slots = extractSlotsFromMessages(history, body, svcIndex);
    const missing = missingFields(slots);

    const serviceLine = services.map(s => s.price ? `${s.key} (~$${s.price})` : s.key).join(', ');

    const systemPrompt =
`You are a helpful receptionist for ${spaDisplayName}.
Tone: ${runtime.aiTone}.
You DO NOT have live calendar access; never promise confirmed availability.
Use prior context; short follow-ups like “will it work?” refer to the most recent unresolved request.
Business timezone: ${runtime.tz}.
House rules: ${runtime.aiExtra}
Services: ${serviceLine || 'standard services'}.

Known so far:
- Service: ${slots.service || '—'}
- When: ${slots.when || '—'}
- Name: ${slots.name || '—'}
Missing: ${missing.length ? missing.join(', ') : 'none'}

Behavior:
- If any field is missing, ask ONLY for the missing field(s) (one compact question).
- If all fields are present, acknowledge and say you'll hold the request and someone will confirm shortly (no fake confirmations).
- Keep replies to 1–3 SMS-length sentences.`;

    const messages = [
      { role: "system", content: systemPrompt },
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

      if (missing.length === 0) {
        // 4) Log a PENDING booking for staff follow-up
        try {
          await appendRow({
            sheetId: bookingsSheetId,
            tabName: 'bookings',
            row: [
              now,                 // timestamp_iso
              '',                  // booking_id
              spaSheetKey,         // spa_id (keep your sheet continuity)
              'sms',               // channel
              slots.name,          // name
              from,                // phone
              '',                  // email
              slots.service,       // service
              slots.when,          // start_time (free-form phrase)
              runtime.tz || '',    // timezone
              'sms',               // source
              '',                  // notes
              '',                  // staff
              'pending',           // status
              '',                  // price
              ''                   // revenue
            ]
          });
        } catch (e) { console.error('Pending booking log failed:', e.message); }
      }
    } catch (e) {
      console.error("OpenAI error:", e.message);
      kind = 'auto';
      reply = "Thanks for your message — we’ll get back to you shortly.";
    }
  }

  // TwiML response
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);

  // Log outbound
  try {
    await appendRow({
      sheetId: messagesSheetId,
      tabName: 'messages',
      row: [now, spaSheetKey, '-', to, from, 'sms', `outbound:${kind}`, reply, 'N/A', '']
    });
  } catch (e) { console.error('Outbound log failed:', e.message); }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/xml' },
    body: twiml.toString()
  };
};
