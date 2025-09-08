// netlify/functions/sms.js
// ----------------------------------------------------------------------------
// Preserves: compliance logging, status-callback logging, C/reschedule,
// per-SPA config, history memory, messages schema, bookings append.
// Adds: explicit CONFIRM gate for bookings + dedupe.
// Uses canonical spa_id in all sheet writes. Skips compliance rows in memory.
// ----------------------------------------------------------------------------

const { appendRow } = require('./_sheets');
const { spaForNumber } = require('./_spa');          // fallback display label
const { getConfigs } = require('./_lib/config');     // loads SpaConcierge_Config.spas
const twilio = require('twilio');
const { google } = require('googleapis');
let OpenAI = require('openai'); OpenAI = OpenAI.default || OpenAI;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 8000 });

/* ----------------------------- Tunables ----------------------------- */
const HISTORY_LIMIT        = Number(process.env.HISTORY_LIMIT  || 10);
const HISTORY_WINDOW_HOURS = Number(process.env.HISTORY_HOURS  || 48);
const CONFIRM_RE           = /^confirm\b/i;
const DEDUPE_WINDOW_MIN    = 60; // minutes

/* ----------------------- Compliance keywords ------------------------ */
const OPT_OUT_KEYWORDS = /^(stop|cancel|end|optout|quit|revoke|stopall|unsubscribe)$/i;
const OPT_IN_KEYWORDS  = /^(start|unstop|yes)$/i;
const HELP_KEYWORDS    = /^(help)$/i;

/* ----------------------------- Helpers ------------------------------ */
function normalize(num) {
  if (!num) return '';
  const digits = String(num).replace(/[^\d]/g, '');
  return digits.replace(/^1/, ''); // drop +1 (US)
}
function titleCase(s) {
  return String(s || '').trim().replace(/\s+/g, ' ')
    .split(' ')
    .map(x => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase())
    .join(' ');
}

/* -------------------- Google Sheets (read-only) --------------------- */
async function getSheetsRO() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey  = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) throw new Error('Missing GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY');
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
  variants.sort((a,b) => b.length - a.length); // prefer longest phrase
  return { variantToKey, variants };
}
function pickService(text, idx) {
  const t = String(text || '').toLowerCase();
  for (const v of idx.variants) if (t.includes(v)) return idx.variantToKey.get(v) || '';
  return '';
}

/* -------------------------- Slot extraction ------------------------- */
const timeRe  = /\b(?:[01]?\d|2[0-3])(?::\d{2})?\s?(?:am|pm)\b/i;
const dayRe   = /\b(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i;
const dateRe  = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/;
const monthRe = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?\b/i;
const relRe   = /\b(?:today|tomorrow|tmrw|this (?:mon|tue|wed|thu|fri|sat|sun|weekend))\b/i;
const namePhraseRe  = /\b(?:my name(?:'s)? is|name is|i am|i'm|im|this is|call me|it's)\s+([A-Z][a-z' -]{1,29})\b/;

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
function extractDatePart(text) { return firstMatchWithIndex(text, [monthRe, dateRe, dayRe, relRe]); }
function extractTimePart(text) { return firstMatchWithIndex(text, [timeRe]); }
function combineWhen(datePart, timePart) { return (datePart && timePart) ? `${datePart} ${timePart}`.trim() : (datePart || timePart || '').trim(); }

const NAME_IGNORE = /\b(hi|hello|hey|thanks|thank you|okay|ok|yes|yeah|yep)\b/i;
function nameFrom(text, idx) {
  const t = String(text || '').trim();

  const m1 = namePhraseRe.exec(t);
  if (m1) return titleCase(m1[1]);

  const cap = /\b([A-Z][a-z]{1,29})\b/.exec(t);
  if (cap) {
    const candidate = cap[1].toLowerCase();
    if (
      !idx.variants.some(w => candidate.includes(w)) &&
      !/\b(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(candidate) &&
      !/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b/i.test(candidate) &&
      !NAME_IGNORE.test(candidate)
    ) return titleCase(cap[1]);
  }

  const m2 = /^([a-z][a-z' -]{1,29})(?:,|\s|$)/i.exec(t);
  if (m2) {
    const cand = m2[1].toLowerCase();
    if (!idx.variants.some(w => cand.includes(w)) && !NAME_IGNORE.test(cand)) return titleCase(m2[1]);
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

  for (const m of history) if (m.role === 'user') apply(m.content);
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
  try { cfgs = await getConfigs(); }
  catch (err) { console.error('getConfigs failed. Falling back to default sheet.', err.message); return defaultRuntime(e164To); }

  const bySpaId = (cfgs && cfgs.bySpaId) || {};
  const byNumber = (cfgs && cfgs.byNumber) || {};

  const normTo = normalize(e164To);
  let spaId = byNumber[e164To] || byNumber[normTo] || byNumber['+' + normTo];
  if (!spaId) for (const [k, v] of Object.entries(byNumber)) { if (normalize(k) === normTo) { spaId = v; break; } }
  if (!spaId || !bySpaId[spaId]) { console.warn('No spa mapping for number; using default runtime.'); return defaultRuntime(e164To); }

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
    spaId: spaConf.spa_id || 'default',
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

/* -------- History: pull last N user/assistant turns (skip status+compliance) ---
// SpaConcierge_Ops.messages (15 cols):
// [0]timestamp_iso,[1]spa_id,[2]direction,[3]to_e164,[4]from_e164,
// [5]body,[6]status,[7]error_code,[8]message_sid,[9]msid,[10]campaign_id,
// [11]segments,[12]price,[13]intent,[14]matched_keyword
*/
async function fetchRecentHistory({ messagesSheetId, spaKey, to, from, limit = HISTORY_LIMIT, windowHours = HISTORY_WINDOW_HOURS }) {
  const sheets = await getSheetsRO();
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: messagesSheetId, range: 'messages!A:O' });
  const rows = resp.data.values || [];
  if (!rows.length) return [];

  const nowMs = Date.now();
  const out = [];
  const normTo = normalize(to);
  const normFrom = normalize(from);

  for (let i = rows.length - 1; i >= 1 && out.length < limit * 2; i--) {
    const r = rows[i];
    if (!r || r.length < 6) continue;

    const ts       = r[0] || '';
    const spa      = r[1] || '';
    const dir      = (r[2] || '').toString(); // inbound | outbound:* | inbound:optout | status | ...
    const To       = normalize(r[3] || '');
    const From     = normalize(r[4] || '');
    const text     = (r[5] || '').toString().trim();

    if (spa !== spaKey) continue;

    // Same conversation pair
    const matchesPair =
      (To === normTo && From === normFrom) ||
      (To === normFrom && From === normTo);
    if (!matchesPair) continue;

    if (!text) continue;

    // Skip status + compliance keyword rows to keep memory clean
    if (dir === 'status') continue;
    if (/^inbound:(optout|optin|help)/i.test(dir)) continue;

    const t = Date.parse(ts);
    if (isFinite(t)) {
      const ageHrs = (nowMs - t) / 3600000;
      if (ageHrs > windowHours) break;
    }

    let role = null;
    if (dir.startsWith('inbound'))  role = 'user';
    else if (dir.startsWith('outbound')) role = 'assistant';
    if (!role) continue;

    out.push({ role, content: text });
  }
  return out.reverse().slice(-limit);
}

/* ------------------------------ Dedupe ------------------------------ */
async function hasRecentPendingBooking({ bookingsSheetId, phone, startTime, windowMin = DEDUPE_WINDOW_MIN }) {
  try {
    const sheets = await getSheetsRO();
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: bookingsSheetId,
      range: 'bookings!A:R', // 18 columns
    });
    const rows = resp.data.values || [];
    if (rows.length <= 1) return false;

    const since = Date.now() - windowMin * 60 * 1000;

    const hdr = rows[0].map(h => (h || '').toLowerCase());
    const idx = (name) => hdr.indexOf(name);

    const tsIdx    = idx('timestamp_iso');
    const phoneIdx = idx('phone');
    const startIdx = idx('start_time');
    const statusIdx= idx('status');

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const ts = Date.parse(r[tsIdx] || '');
      const ph = (r[phoneIdx] || '').replace(/[^\d]/g, '');
      const st = (r[startIdx] || '').trim();
      const status = (r[statusIdx] || '').toLowerCase();
      if (isFinite(ts) && ts >= since && status === 'pending') {
        if (ph.endsWith(normalize(phone)) && st === (startTime || '')) return true;
      }
    }
  } catch (e) {
    console.error('Dedupe check failed:', e.message);
  }
  return false;
}

/* -------------------------------- Handler --------------------------- */
exports.handler = async (event) => {
  if (event.httpMethod === 'GET') return { statusCode: 200, body: 'OK' };

  const params = new URLSearchParams(event.body || '');
  const now = new Date().toISOString();

  // Status-callback branch
  const maybeStatus = params.get('MessageStatus') || params.get('SmsStatus');
  if (maybeStatus) {
    const to   = params.get('To')   || '';
    const from = params.get('From') || '';
    let runtime = defaultRuntime(to);
    try { const r = await loadSpaRuntime(to); if (r && r.messagesSheetId) runtime = r; } catch (e) { console.error('loadSpaRuntime (status) error; using default:', e.message); }

    const messageSid = params.get('MessageSid') || '';
    const errCode    = params.get('ErrorCode') || '';
    const campaignId = params.get('CampaignSid') || params.get('MessagingServiceSid') || '';

    try {
      await appendRow({
        sheetId: runtime.messagesSheetId,
        tabName: 'messages',
        row: [now, runtime.spaId, 'status', to, from, '', maybeStatus, errCode, messageSid, runtime.msid || '', campaignId, '', '', '', '']
      });
    } catch (e) { console.error('Status log failed:', e.message); }

    return { statusCode: 200, body: '' };
  }

  // Regular inbound message
  const from = params.get('From') || '';
  const to   = params.get('To')   || '';
  const body = (params.get('Body') || '').trim();
  const inboundSid = params.get('MessageSid') || '';
  const segments   = params.get('NumSegments') || '';
  const price      = params.get('Price') || '';
  const campaignId = params.get('CampaignSid') || params.get('MessagingServiceSid') || '';

  let runtime = defaultRuntime(to);
  try { const r = await loadSpaRuntime(to); if (r && r.messagesSheetId) runtime = r; }
  catch (e) { console.error('loadSpaRuntime error; using default runtime:', e.message); }

  const {
    spaId,               // <— canonical id to log
    spaSheetKey,         // display-ish
    spaDisplayName,
    messagesSheetId,
    bookingsSheetId,
    tz,
    services: svcFromCfg
  } = runtime;

  const services = svcFromCfg || DEFAULT_SERVICES;
  const svcIndex = makeServiceIndex(services);

  // 1) Log inbound (15-col schema)
  try {
    await appendRow({
      sheetId: messagesSheetId,
      tabName: 'messages',
      row: [now, spaId, 'inbound', to, from, body, 'received', '', inboundSid, runtime.msid || '', campaignId, segments, price, '', '']
    });
  } catch (e) { console.error('Inbound log failed:', e.message); }

  // 2) Compliance (log + let Twilio handle reply)
  if (OPT_OUT_KEYWORDS.test(body) || OPT_IN_KEYWORDS.test(body) || HELP_KEYWORDS.test(body)) {
    let complianceType = 'compliance', matched = '';
    if (OPT_OUT_KEYWORDS.test(body)) { complianceType = 'inbound:optout'; matched = body; }
    if (OPT_IN_KEYWORDS.test(body))  { complianceType = 'inbound:optin';  matched = body; }
    if (HELP_KEYWORDS.test(body))    { complianceType = 'inbound:help';   matched = body; }

    try {
      await appendRow({
        sheetId: messagesSheetId,
        tabName: 'messages',
        row: [now, spaId, complianceType, to, from, body, 'received', '', inboundSid, runtime.msid || '', campaignId, segments, price, '', matched]
      });
    } catch (e) { console.error('Compliance log failed:', e.message); }

    return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: new twilio.twiml.MessagingResponse().toString() };
  }

  // 3) Explicit CONFIRM booking path (only here we write bookings)
  if (CONFIRM_RE.test(body)) {
    let reply, kind = 'auto';
    try {
      const history = await fetchRecentHistory({ messagesSheetId, spaKey: spaId, to, from });
      const slots = extractSlotsFromMessages(history, /*currentUserMsg*/'', svcIndex);
      const missing = missingFields(slots);

      if (missing.length) {
        reply = `Almost there — I still need your ${missing.join(' & ')} to place the hold.`;
      } else {
        const dup = await hasRecentPendingBooking({ bookingsSheetId, phone: from, startTime: slots.when, windowMin: DEDUPE_WINDOW_MIN });
        if (dup) {
          reply = `You’re already on our list for ${slots.service} ${slots.when}. If you need changes, just tell me what to change.`;
        } else {
          try {
            await appendRow({
              sheetId: bookingsSheetId,
              tabName: 'bookings',
              row: [
                now,                 // timestamp_iso
                '',                  // booking_id
                spaId,               // spa_id (canonical)
                'sms',               // channel
                slots.name,          // name
                from,                // phone
                '',                  // email
                slots.service,       // service
                slots.when,          // start_time
                tz || '',            // timezone
                'sms',               // source
                '',                  // notes
                '',                  // staff
                'pending',           // status
                '',                  // price
                '',                  // revenue
                '',                  // external_apt_id
                ''                   // utm_campaign
              ]
            });
            reply = `Got it — I’ll hold a spot for ${slots.service} ${slots.when}. We’ll text back to confirm availability.`;
          } catch (e) {
            console.error('Pending booking log failed:', e.message);
            reply = "I couldn't place the hold just now, but I’ve saved your details and will follow up shortly.";
          }
        }
      }
    } catch (e) {
      console.error('Confirm flow error:', e.message);
      reply = 'Thanks! I’m saving your request and will confirm shortly.';
    }

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);

    try {
      await appendRow({
        sheetId: messagesSheetId,
        tabName: 'messages',
        row: [now, spaId, 'outbound:auto', to, from, reply, 'queued', '', '', runtime.msid || '', '', '', '', 'confirm']
      });
    } catch (e) { console.error('Outbound log failed:', e.message); }

    return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
  }

  // 4) Decide reply (AI) + prompt to CONFIRM
  let reply;
  let kind = 'auto';

  if (/^c$/i.test(body)) {
    reply = 'Confirmed ✅ See you soon! Reply HELP for help or STOP to opt out.';
  } else if (/^reschedule$/i.test(body)) {
    reply = 'Sure — what date and time would you like instead?';
  } else {
    kind = 'ai';

    let history = [];
    try { history = await fetchRecentHistory({ messagesSheetId, spaKey: spaId, to, from }); }
    catch (e) { console.error('History fetch failed:', e.message); }

    const slots = extractSlotsFromMessages(history, body, svcIndex);
    const missing = missingFields(slots);
    const serviceLine = (services || []).map(s => s.price ? `${s.key} (~$${s.price})` : s.key).join(', ');

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
- If all pieces are present, summarize and ask them to reply "CONFIRM" to place a hold. Example:
  “Great, I have you for a {service} on {date} at {time}. Reply CONFIRM to place a hold.”
- Keep replies to 1–3 SMS-length sentences.
- Once you have the service, date, time, and name, tell the guest:
  “I’ve got your [service] on [date/time]. Please reply CONFIRM to hold this request.”
- Do NOT log a booking until the guest replies CONFIRM.`;

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.3,
        messages: [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: body }]
      });
      reply = (completion.choices?.[0]?.message?.content || '').trim();
      if (!reply) throw new Error('Empty AI reply');
    } catch (e) {
      console.error('OpenAI error:', e.message);
      kind = 'auto';
      reply = 'Thanks for your message — we’ll get back to you shortly.';
    }
  }

  // 5) TwiML + log outbound
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);

  try {
    await appendRow({
      sheetId: messagesSheetId,
      tabName: 'messages',
      row: [now, spaId, `outbound:${kind}`, to, from, reply, 'queued', '', '', runtime.msid || '', '', '', '', (kind === 'ai' ? 'ai' : ''), '']
    });
  } catch (e) { console.error('Outbound log failed:', e.message); }

  return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
};
