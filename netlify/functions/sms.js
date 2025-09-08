// netlify/functions/sms.js
// ----------------------------------------------------------------------------
// Keeps existing behavior (compliance logging, C/reschedule keywords, history,
// bookings logging) and adds per-SPA config wiring (sheets, tz, services, etc.)
// ----------------------------------------------------------------------------

const { appendRow } = require('./_sheets');          // writes a row (we keep this)
const { spaForNumber } = require('./_spa');          // legacy display name fallback
const { getConfigs } = require('./_lib/config');     // your TS config loader (spas tab)
const twilio = require('twilio');
const { google } = require('googleapis');
let OpenAI = require('openai'); OpenAI = OpenAI.default || OpenAI;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 8000 });

/* ----------------------------- Tunables ----------------------------- */
const HISTORY_LIMIT        = Number(process.env.HISTORY_LIMIT  || 10);
const HISTORY_WINDOW_HOURS = Number(process.env.HISTORY_HOURS || 48);

/* ----------------------- Compliance keywords ------------------------ */
const OPT_OUT_KEYWORDS = /^(stop|cancel|end|optout|quit|revoke|stopall|unsubscribe)$/i;
const OPT_IN_KEYWORDS  = /^(start|unstop|yes)$/i;
const HELP_KEYWORDS    = /^(help)$/i;

/* ----------------------------- Helpers ------------------------------ */
function normalize(num) {
  if (!num) return '';
  const digits = String(num).replace(/[^\d]/g, '');
  return digits.replace(/^1/, ''); // US normalize
}
function titleCase(s) {
  return String(s || '').trim().replace(/\s+/g, ' ')
    .split(' ')
    .map(x => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase())
    .join(' ');
}

/* -------------------- Google Sheets (read-only) --------------------- */
/** Use split env vars; do NOT depend on GOOGLE_SERVICE_ACCOUNT_JSON. */
async function getSheetsRO() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey  = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!clientEmail || !privateKey) {
    throw new Error('Missing GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY');
  }

  const auth = new google.auth.JWT(
    clientEmail,
    undefined,
    privateKey,
    ['https://www.googleapis.com/auth/spreadsheets.readonly']
  );
  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

/* ------------------- Default service catalog (fallback) ------------- */
const DEFAULT_SERVICES = [
  { key: "facial",  variants: ["facial","classic facial","deep cleanse facial"], duration_min: 60, price: 120 },
  { key: "massage", variants: ["massage","standard massage","massage standard","relaxation massage"], duration_min: 60, price: 100 },
  { key: "brows",   variants: ["brow","brows","brow shaping","eyebrow"], duration_min: 30, price: 35 },
  { key: "wax",     variants: ["wax","waxing"], duration_min: 30, price: 45 },
  { key: "laser",   variants: ["laser","laser hair removal"], duration_min: 45, price: 150 }
];

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
  variants.sort((a,b) => b.length - a.length); // prefer longer phrase
  return { variantToKey, variants };
}

function pickService(text, idx) {
  const t = String(text || '').toLowerCase();
  for (const v of idx.variants) {
    if (t.includes(v)) return idx.variantToKey.get(v) || '';
  }
  return '';
}

/* -------------------------- Slot extraction ------------------------- */
const timeRe  = /\b(?:[01]?\d|2[0-3])(?::\d{2})?\s?(?:am|pm)\b/i;
const dayRe   = /\b(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i;
const dateRe  = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/;
const monthRe = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?\b/i;
const relRe   = /\b(?:today|tomorrow|tmrw|this (?:mon|tue|wed|thu|fri|sat|sun|weekend))\b/i;
const namePhraseRe  = /\b(?:my name(?:'s)? is|name is|i am|i'm|im|this is|call me|it's)\s+([A-Z][a-z' -]{1,29})\b/;
// --- date/time helpers (replace whenPhrase with these) ---
function firstMatchWithIndex(text, regexes) {
  const t = String(text || '');
  let best = null; // {val, idx}
  for (const re of regexes) {
    const m = re.exec(t);
    if (m && m.index >= 0) {
      const val = m[0];
      if (best === null || m.index < best.idx) best = { val, idx: m.index };
    }
  }
  return best ? best.val : '';
}

function extractDatePart(text) {
  // month name date (e.g. "Sep 12"), numeric date (e.g. "9/12"), weekday ("Friday"),
  // relative ("tomorrow", "this Tue", "weekend")
  return firstMatchWithIndex(text, [monthRe, dateRe, dayRe, relRe]);
}

function extractTimePart(text) {
  // 4pm, 10:30 AM, 14:00, etc.
  return firstMatchWithIndex(text, [timeRe]);
}

function combineWhen(datePart, timePart) {
  if (datePart && timePart) return `${datePart} ${timePart}`.trim();
  return (datePart || timePart || '').trim();
}

function nameFrom(text, idx) {
  const t = String(text || '').trim();

  // Explicit phrases ("my name is", "call me", "it's", etc.)
  const m1 = namePhraseRe.exec(t);
  if (m1) return titleCase(m1[1]);

  // Any single capitalized word not obviously a service/day/month
  const cap = /\b([A-Z][a-z]{1,29})\b/.exec(t);
  if (cap) {
    const candidate = cap[1].toLowerCase();
    if (
      !idx.variants.some(w => candidate.includes(w)) &&
      !/\b(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(candidate) &&
      !/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b/i.test(candidate)
    ) {
      return titleCase(cap[1]);
    }
  }

  // Fallback: first token that isn't a service word
  const m2 = /^([a-z][a-z' -]{1,29})(?:,|\s|$)/i.exec(t);
  if (m2) {
    const candidate = m2[1].toLowerCase();
    if (!idx.variants.some(w => candidate.includes(w))) return titleCase(m2[1]);
  }

  return '';
}

function extractSlotsFromMessages(history, currentUserMsg, idx) {
  const slots = { service: '', when: '', whenDate: '', whenTime: '', name: '' };

  function apply(text) {
    if (!text) return;
    if (!slots.service) slots.service = pickService(text, idx);
    if (!slots.name)    slots.name    = nameFrom(text, idx);

    const d = extractDatePart(text);
    const t = extractTimePart(text);
    if (!slots.whenDate && d) slots.whenDate = d;
    if (!slots.whenTime && t) slots.whenTime = t;
  }

  // prefer user turns in chronological order
  for (const m of history) {
    if (m.role === 'user') apply(m.content);
  }
  if (currentUserMsg) apply(currentUserMsg);

  slots.when = combineWhen(slots.whenDate, slots.whenTime);
  return slots;
}
function missingFields(slots) {
  const miss = [];
  if (!slots.service)  miss.push('service');
  if (!slots.whenDate) miss.push('date');
  if (!slots.whenTime) miss.push('time');
  if (!slots.name)     miss.push('name');
  return miss;
}

/* -------------------- Runtime from config (with fallback) ----------- */
function defaultRuntime(e164To) {
  const DEFAULT_SHEET_ID = process.env.SHEET_ID || process.env.GOOGLE_SHEETS_ID;
  const spaSheetKey = spaForNumber(e164To) || 'Spa';
  return {
    spaId: 'default',
    spaSheetKey,
    spaDisplayName: spaSheetKey,
    tz: process.env.DEFAULT_TIMEZONE || 'America/New_York',
    hours: null,
    services: null,
    messagesSheetId: DEFAULT_SHEET_ID,
    bookingsSheetId: DEFAULT_SHEET_ID,
    msid: '',
    aiTone: 'friendly, concise, professional',
    aiExtra: ''
  };
}

async function loadSpaRuntime(e164To) {
  let cfgs = null;
  try {
    cfgs = await getConfigs(); // { bySpaId, byNumber }
  } catch (err) {
    console.error('getConfigs failed. Falling back to default sheet.', err.message);
    return defaultRuntime(e164To);
  }

  const bySpaId = (cfgs && cfgs.bySpaId) || {};
  const byNumber = (cfgs && cfgs.byNumber) || {};

  const normTo = normalize(e164To);
  let spaId = byNumber[e164To] || byNumber[normTo] || byNumber['+' + normTo];
  if (!spaId) {
    for (const [k, v] of Object.entries(byNumber)) {
      if (normalize(k) === normTo) { spaId = v; break; }
    }
  }

  if (!spaId || !bySpaId[spaId]) {
    console.warn('No spa mapping for number; using default runtime.');
    return defaultRuntime(e164To);
  }

  const spaConf = bySpaId[spaId];
  const DEFAULT_SHEET_ID = process.env.SHEET_ID || process.env.GOOGLE_SHEETS_ID;

  const messagesSheetId = spaConf.sheets_ops_messages_id || DEFAULT_SHEET_ID;
  const bookingsSheetId = spaConf.sheets_ops_bookings_id || DEFAULT_SHEET_ID;

  const spaSheetKey    = spaForNumber(e164To) || spaConf.spa_name || 'Spa';
  const spaDisplayName = spaConf.spa_name || spaSheetKey;

  let hours = null, services = null;
  try { if (spaConf.hours_json)    hours = JSON.parse(spaConf.hours_json); } catch {}
  try { if (spaConf.services_json) services = JSON.parse(spaConf.services_json); } catch {}

  return {
    spaId,
    spaSheetKey,
    spaDisplayName,
    tz: spaConf.tz || process.env.DEFAULT_TIMEZONE || 'America/New_York',
    hours,
    services,
    messagesSheetId,
    bookingsSheetId,
    msid: spaConf.msid || '',
    aiTone: 'friendly, concise, professional',
    aiExtra: ''
  };
}

/* ---------------- History: pull last N turns for (to,from) --------- */
// messages!A:J -> timestamp | spa | '-' | to | from | channel | status | body | error | notes
async function fetchRecentHistory({ messagesSheetId, spaKey, to, from, limit = HISTORY_LIMIT, windowHours = HISTORY_WINDOW_HOURS }) {
  const sheets = await getSheetsRO();
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
      (To === normTo && From === normFrom) || // inbound
      (To === normFrom && From === normTo);   // outbound
    if (!matchesPair) continue;

    if (!text) continue;
    if (/^inbound:(optout|optin|help)/i.test(status)) continue;

    const t = Date.parse(ts);
    if (isFinite(t)) {
      const ageHrs = (nowMs - t) / 3600000;
      if (ageHrs > windowHours) break;
    }

    let role = null;
    if (/^inbound/i.test(status))       role = 'user';
    else if (/^outbound/i.test(status)) role = 'assistant';
    if (!role) continue;

    out.push({ role, content: text });
  }

  return out.reverse().slice(-limit);
}

/* -------------------------------- Handler --------------------------- */
exports.handler = async (event) => {
  // Simple GET health check (no secrets leaked)
  if (event.httpMethod === 'GET') {
    return { statusCode: 200, body: 'OK' };
  }

  const params = new URLSearchParams(event.body || '');
  const from = params.get('From') || ''; // customer (E.164)
  const to   = params.get('To')   || ''; // our Twilio number (E.164)
  const body = (params.get('Body') || '').trim();
  const now = new Date().toISOString();

  // Load per-SPA runtime (with safe fallback)
  let runtime = defaultRuntime(to);
  try {
    const r = await loadSpaRuntime(to);
    if (r && r.messagesSheetId) runtime = r;
  } catch (e) {
    console.error('loadSpaRuntime error; using default runtime:', e.message);
  }

  const {
    spaSheetKey,
    spaDisplayName,
    messagesSheetId,
    bookingsSheetId,
    tz,
    services: svcFromCfg
  } = runtime;

  const services = svcFromCfg || DEFAULT_SERVICES;
  const svcIndex = makeServiceIndex(services);

  /* 1) Log inbound (best-effort) */
  try {
    await appendRow({
      sheetId: messagesSheetId,
      tabName: 'messages',
      row: [now, spaSheetKey, '-', to, from, 'sms', 'inbound', body, 'N/A', '']
    });
  } catch (e) { console.error('Inbound log failed:', e.message); }

  /* 2) Compliance keywords: log & let Twilio Advanced Opt-Out reply */
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

  /* 3) Decide reply */
  let reply;
  let kind = 'auto';

  if (/^c$/i.test(body)) {
    reply = 'Confirmed ✅ See you soon! Reply HELP for help or STOP to opt out.';
  } else if (/^reschedule$/i.test(body)) {
    reply = 'Sure — what date and time would you like instead?';
  } else {
    kind = 'ai';

    // Pull recent history (to/from pair) and extract slots
    let history = [];
    try {
      history = await fetchRecentHistory({
        messagesSheetId,
        spaKey: spaSheetKey,
        to, from
      });
    } catch (e) { console.error('History fetch failed:', e.message); }

    const slots = extractSlotsFromMessages(history, body, svcIndex);
    const missing = missingFields(slots);
    const serviceLine = services.map(s => s.price ? `${s.key} (~$${s.price})` : s.key).join(', ');

   const systemPrompt =
`You are a helpful receptionist for ${spaDisplayName}.
Tone: friendly, concise, professional.
You DO NOT have live calendar access; never promise confirmed availability.
Use prior context; short follow-ups like “will it work?” refer to the most recent unresolved request.
Business timezone: ${tz}.
Services: ${serviceLine || 'standard services'}.

Known so far:
- Service: ${slots.service || '—'}
- Date: ${slots.whenDate || '—'}
- Time: ${slots.whenTime || '—'}
- Name: ${slots.name || '—'}
Missing: ${missing.length ? missing.join(', ') : 'none'}

Behavior:
- If any piece is missing, ask ONLY for the missing piece(s) (one compact question).
- If all pieces are present, acknowledge and say you'll hold the request and someone will confirm shortly (no fake confirmations).
- Keep replies to 1–3 SMS-length sentences.`;

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.3,
        messages: [
          { role: "system", content: systemPrompt },
          ...history,
          { role: "user", content: body }
        ]
      });
      reply = (completion.choices?.[0]?.message?.content || '').trim();
      if (!reply) throw new Error('Empty AI reply');

      // If all slots present → log a pending booking row
      if (missing.length === 0) {
        try {
          await appendRow({
            sheetId: bookingsSheetId,
            tabName: 'bookings',
            row: [
              now,                 // timestamp_iso
              '',                  // booking_id
              spaSheetKey,         // spa_id (use spa_id if you prefer)
              'sms',               // channel
              slots.name,          // name
              from,                // phone
              '',                  // email
              slots.service,       // service
              slots.when,          // start_time (free-form for now)
              tz || '',            // timezone
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
      console.error('OpenAI error:', e.message);
      kind = 'auto';
      reply = 'Thanks for your message — we’ll get back to you shortly.';
    }
  }

  /* 4) TwiML + log outbound */
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);

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
