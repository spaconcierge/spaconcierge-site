// netlify/functions/sms.js
// -----------------------------------------------------------------------------
// Combines your "conversational" flow with the newer structured flow:
//  - Model fallback (OPENAI_MODEL_PRIMARY -> OPENAI_MODEL_FALLBACK)
//  - Longer, tunable history window and "latest message wins"
//  - Robust name/service/date/time extraction (heuristics + LLM fallback)
//  - Relative dates -> explicit YYYY-MM-DD in SPA timezone
//  - Hours guard from hours_json (if provided)
//  - Confirmation gate ("CONFIRM"/"C") before writing to bookings
//  - CHANGE intent clears old proposal & re-extracts from latest message only
//  - Same Google Sheets logging columns as before
// -----------------------------------------------------------------------------

const { appendRow } = require('./_sheets');
const { spaForNumber } = require('./_spa');
const { getConfigs } = require('./_lib/config');
const twilio = require('twilio');
const { google } = require('googleapis');
let OpenAI = require('openai'); OpenAI = OpenAI.default || OpenAI;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 8000 });

/* ------------------------------ Models ------------------------------ */
const MODEL_PRIMARY  = process.env.OPENAI_MODEL_PRIMARY  || 'gpt-4o';
const MODEL_FALLBACK = process.env.OPENAI_MODEL_FALLBACK || 'gpt-4o-mini';

async function openaiChat(messages, opts = {}) {
  try {
    const r = await openai.chat.completions.create({
      model: MODEL_PRIMARY,
      ...opts,
      messages
    });
    return r.choices?.[0]?.message?.content?.trim() || '';
  } catch (e) {
    console.error('OpenAI primary failed:', e.message);
    try {
      const r2 = await openai.chat.completions.create({
        model: MODEL_FALLBACK,
        ...opts,
        messages
      });
      return r2.choices?.[0]?.message?.content?.trim() || '';
    } catch (e2) {
      console.error('OpenAI fallback failed:', e2.message);
      return '';
    }
  }
}

/* ------------------------------ Tunables ---------------------------- */
const HISTORY_LIMIT        = Number(process.env.HISTORY_LIMIT  || 20);
const HISTORY_WINDOW_HOURS = Number(process.env.HISTORY_HOURS || (24 * 7)); // 7 days

/* ----------------------- Compliance / intents ----------------------- */
const CHANGE_KEYWORDS  = /\b(change|instead|another|different|reschedule|no,|actually)\b/i;
const OPT_OUT_KEYWORDS = /^(stop|cancel|end|optout|quit|revoke|stopall|unsubscribe)$/i;
const OPT_IN_KEYWORDS  = /^(start|unstop|yes)$/i;
const HELP_KEYWORDS    = /^(help)$/i;

/* -------------------------------- Utils ----------------------------- */
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
// expanded slightly to be tolerant of “6pm”, “18:30”, etc.
const timeRe  = /\b(?:[01]?\d|2[0-3])(?::\d{2})?\s*(?:am|pm)?\b/i;
const dayRe   = /\b(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i;
const dateRe  = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/;
const monthRe = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?\b/i;
const relRe   = /\b(?:today|tomorrow|tmrw|this (?:mon|tue|wed|thu|fri|sat|sun|weekend)|weekend)\b/i;

// Name phrases (allow multiword names and O’…/De La …)
const namePhraseRe  = /\b(?:my name(?:'s)? is|name is|i am|i'm|im|this is|call me|it's)\s+([A-Z][A-Za-z'’\-]{1,29}(?:\s+[A-Z][A-Za-z'’\-]{1,29}){0,2})\b/;
const NAME_STOPWORDS = new Set(['hi','hey','hello','thanks','thank','ok','okay','yeah','yep','sure','please']);

function firstMatchWithIndex(text, regexes) {
  const t = String(text || '');
  let best = null;
  for (const re of regexes) {
    const m = re.exec(t);
    if (m && m.index >= 0) {
      const val = m[0];
      if (best === null || m.index < best.idx) best = { val, idx: m.index };
    }
  }
  return best ? best.val : '';
}
function extractDateHint(text) { return firstMatchWithIndex(text, [monthRe, dateRe, dayRe, relRe]); }
function extractTimeHint(text) { return firstMatchWithIndex(text, [timeRe]); }

function nameFrom(text, idx) {
  const t = String(text || '').trim();
  const m1 = namePhraseRe.exec(t);
  if (m1) {
    const nm = titleCase(m1[1]);
    if (!NAME_STOPWORDS.has(nm.toLowerCase())) return nm;
  }
  const cap = /\b([A-Z][a-z]{1,29})\b/.exec(t);
  if (cap) {
    const nm = cap[1];
    const candidate = nm.toLowerCase();
    const isDay = /\b(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(candidate);
    const isMon = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b/i.test(candidate);
    const isServiceish = idx.variants.some(w => candidate.includes(w));
    if (!isDay && !isMon && !isServiceish && !NAME_STOPWORDS.has(candidate)) return titleCase(nm);
  }
  return '';
}

/* --------------------- Timezone / date utilities -------------------- */
function nowPartsInTZ(tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return {
    year: +parts.year, month: +parts.month, day: +parts.day,
    hour: +parts.hour, minute: +parts.minute, second: +parts.second,
  };
}
function ymdToDate(yyyy, mm, dd)   { return new Date(Date.UTC(yyyy, mm-1, dd)); }
function formatYMD(yyyy, mm, dd)   { return `${String(yyyy).padStart(4,'0')}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`; }
const DOW = { sun:0, mon:1, tue:2, wed:3, thu:4, fri:5, sat:6 };

function normalizeDateHint(hint, tz) {
  if (!hint) return '';
  hint = hint.toLowerCase();

  const { year, month, day } = nowPartsInTZ(tz);
  const today = ymdToDate(year, month, day);

  if (/^today\b/.test(hint)) return formatYMD(year, month, day);
  if (/^(tomorrow|tmrw)\b/.test(hint)) {
    const d = ymdToDate(year, month, day); d.setUTCDate(d.getUTCDate()+1);
    return formatYMD(d.getUTCFullYear(), d.getUTCMonth()+1, d.getUTCDate());
  }
  if (/weekend/.test(hint)) {
    const d = ymdToDate(year, month, day);
    const delta = (DOW.sat - d.getUTCDay() + 7) % 7 || 7;
    d.setUTCDate(d.getUTCDate()+delta);
    return formatYMD(d.getUTCFullYear(), d.getUTCMonth()+1, d.getUTCDate());
  }
  const wd = Object.keys(DOW).find(k => new RegExp(`\\b${k}(?:day)?\\b`).test(hint));
  if (wd) {
    const target = DOW[wd];
    const d = ymdToDate(year, month, day);
    const delta = (target - d.getUTCDay() + 7) % 7 || 7;
    d.setUTCDate(d.getUTCDate()+delta);
    return formatYMD(d.getUTCFullYear(), d.getUTCMonth()+1, d.getUTCDate());
  }
  const m1 = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:,\s*(\d{4}))?/i.exec(hint);
  if (m1) {
    const monthIdx = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12}[m1[1].slice(0,3).toLowerCase()];
    const dd = +m1[2];
    let yy = m1[3] ? +m1[3] : year;
    const candidate = ymdToDate(yy, monthIdx, dd);
    if (candidate < today) yy += 1;
    return formatYMD(yy, monthIdx, dd);
  }
  const m2 = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(hint);
  if (m2) {
    let mm = +m2[1], dd = +m2[2], yy = m2[3] ? +m2[3] : year;
    if (yy < 100) yy += 2000;
    const candidate = ymdToDate(yy, mm, dd);
    if (candidate < today) yy += 1;
    return formatYMD(yy, mm, dd);
  }
  return '';
}
function normalizeTimeHint(hint) {
  if (!hint) return '';
  const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(hint);
  if (!m) return '';
  let hr = +m[1];
  const min = m[2] ? +m[2] : 0;
  const ap = m[3]?.toLowerCase();
  if (ap === 'pm' && hr < 12) hr += 12;
  if (ap === 'am' && hr === 12) hr = 0;
  if (hr >= 24 || min >= 60) return '';
  return `${String(hr).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
}

/* ----------------------- Hours parsing / check ---------------------- */
function parseHours(hoursJson) {
  if (!hoursJson) return null;
  let obj = null;
  try { obj = typeof hoursJson === 'string' ? JSON.parse(hoursJson) : hoursJson; } catch { return null; }
  const map = { 0:null,1:null,2:null,3:null,4:null,5:null,6:null };
  const apply = (rangeStr, days) => {
    if (!rangeStr) return days.forEach(d => map[d] = null);
    const mm = /(\d{2}:\d{2})-(\d{2}:\d{2})/.exec(rangeStr);
    if (!mm) return;
    days.forEach(d => map[d] = { open: mm[1], close: mm[2] });
  };
  const D = {mon:1,tue:2,wed:3,thu:4,fri:5,sat:6,sun:0};
  for (const [k,v] of Object.entries(obj)) {
    const key = k.toLowerCase().replace(/\s+/g,'');
    if (key === 'daily') { apply(v, [0,1,2,3,4,5,6]); continue; }
    const one  = key.match(/^(mon|tue|wed|thu|fri|sat|sun)$/);
    const span = key.match(/^(mon|tue|wed|thu|fri|sat|sun)\-(mon|tue|wed|thu|fri|sat|sun)$/);
    if (one)      apply(v, [D[one[1]]]);
    else if (span) {
      const a = D[span[1]], b = D[span[2]];
      const days = []; let x = a; days.push(x);
      while (x !== b) { x = (x+1)%7; days.push(x); }
      apply(v, days);
    }
  }
  return map;
}
function withinHours(ymd, hhmm, tz, hoursMap) {
  if (!hoursMap) return true;
  if (!ymd || !hhmm) return true;
  const dt = new Date(`${ymd}T${hhmm}:00Z`);
  const wd = new Intl.DateTimeFormat('en-US', { weekday:'short', timeZone: tz })
               .format(dt).toLowerCase().slice(0,3);
  const D = { sun:0, mon:1, tue:2, wed:3, thu:4, fri:5, sat:6 };
  const cfg = hoursMap[D[wd]];
  if (!cfg) return false;
  return hhmm >= cfg.open && hhmm <= cfg.close;
}
function niceWhen(ymd, hhmm, tz) {
  if (!ymd) return '';
  const [Y,M,D] = ymd.split('-').map(n=>+n);
  const [h,m]   = (hhmm||'00:00').split(':').map(n=>+n);
  const dt = new Date(Date.UTC(Y, M-1, D, h, m));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday:'short', month:'short', day:'numeric',
    hour:'numeric', minute:'2-digit'
  }).format(dt);
}

/* -------------------- Config runtime (with fallback) ---------------- */
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

  const bySpaId  = (cfgs && cfgs.bySpaId) || {};
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

/* ---------------- History: last N turns for (to,from) --------------- */
// messages!A:J => ts | spa | '-' | to | from | channel | status | body | err | notes
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
      (To === normTo && From === normFrom) ||     // inbound
      (To === normFrom && From === normTo);       // outbound
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

/* --------------- Pending proposal marker: find & create ------------- */
async function getSheetsROValues(spreadsheetId, range) {
  const s = await getSheetsRO();
  const r = await s.spreadsheets.values.get({ spreadsheetId, range });
  return (r.data.values || []);
}
async function findPendingProposal({ messagesSheetId, spaKey, to, from }) {
  const rows = await getSheetsROValues(messagesSheetId, 'messages!A:J');
  const normTo = normalize(to), normFrom = normalize(from);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (!r || r.length < 10) continue;
    const spa    = r[1] || '';
    const To     = normalize(r[3] || '');
    const From   = normalize(r[4] || '');
    const status = (r[6] || '').toString();
    const notes  = (r[9] || '').toString();
    if (spa !== spaKey) continue;
    const pair = (To === normFrom && From === normTo) || (To === normTo && From === normFrom);
    if (!pair) continue;
    if (!/^outbound:confirm_request$/i.test(status)) continue;
    try {
      const json = JSON.parse(notes);
      if (json && json.service && json.date && json.time && json.name) return json;
    } catch(_) {}
  }
  return null;
}
function buildProposalJSON({ name, service, date, time, tz }) {
  return JSON.stringify({ name, service, date, time, tz });
}

/* ----------------------- LLM slot extraction pass ------------------- */
async function llmExtractSlots({ spaDisplayName, tz, services, history, userText }) {
  const now = nowPartsInTZ(tz);
  const svcKeys = (services || []).map(s => s.key);
  const sys =
`You are a receptionist for ${spaDisplayName}. Extract fields from the conversation.
Return ONLY JSON with keys: service, date_text, time_text, name.
- service: one of [${svcKeys.join(', ')}] if possible; else "".
- date_text: user's hint for date (e.g., "tomorrow", "Sep 12", "Friday"); else "".
- time_text: user's hint for time (e.g., "2pm", "14:30"); else "".
- name: first + optional last name if stated; else "".
Assume current local date/time: ${now.year}-${String(now.month).padStart(2,'0')}-${String(now.day).padStart(2,'0')} ${String(now.hour).padStart(2,'0')}:${String(now.minute).padStart(2,'0')} (${tz}).`;
  const msgs = [
    { role: 'system', content: sys },
    ...history.slice(-HISTORY_LIMIT),
    { role: 'user', content: userText }
  ];
  const raw = await openaiChat(msgs, { temperature: 0.0 });
  try {
    const json = JSON.parse(raw);
    return {
      service: typeof json.service === 'string' ? json.service.trim().toLowerCase() : '',
      dateHint: typeof json.date_text === 'string' ? json.date_text.trim() : '',
      timeHint: typeof json.time_text === 'string' ? json.time_text.trim() : '',
      name: typeof json.name === 'string' ? titleCase(json.name) : ''
    };
  } catch {
    return { service:'', dateHint:'', timeHint:'', name:'' };
  }
}

/* -------------------------------- Handler --------------------------- */
exports.handler = async (event) => {
  if (event.httpMethod === 'GET') return { statusCode: 200, body: 'OK' };

  const params = new URLSearchParams(event.body || '');
  const from = params.get('From') || '';
  const to   = params.get('To')   || '';
  const body = (params.get('Body') || '').trim();
  const nowISO = new Date().toISOString();

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
    services: svcFromCfg,
    hours
  } = runtime;

  const services = svcFromCfg || DEFAULT_SERVICES;
  const svcIndex = makeServiceIndex(services);
  const hoursMap = parseHours(hours);

  /* 1) Log inbound */
  try {
    await appendRow({
      sheetId: messagesSheetId,
      tabName: 'messages',
      row: [nowISO, spaSheetKey, '-', to, from, 'sms', 'inbound', body, 'N/A', '']
    });
  } catch (e) { console.error('Inbound log failed:', e.message); }

  /* 2) Compliance keywords: let Twilio opt-out do its thing */
  if (OPT_OUT_KEYWORDS.test(body) || OPT_IN_KEYWORDS.test(body) || HELP_KEYWORDS.test(body)) {
    let complianceType = 'compliance';
    if (OPT_OUT_KEYWORDS.test(body)) complianceType = 'optout';
    if (OPT_IN_KEYWORDS.test(body))  complianceType = 'optin';
    if (HELP_KEYWORDS.test(body))    complianceType = 'help';
    try {
      await appendRow({
        sheetId: messagesSheetId,
        tabName: 'messages',
        row: [nowISO, spaSheetKey, '-', to, from, 'sms', `inbound:${complianceType}`, body, 'N/A', '']
      });
    } catch (e) { console.error('Compliance log failed:', e.message); }
    return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: new twilio.twiml.MessagingResponse().toString() };
  }

  /* 3) Quick commands */
  if (/^c(onfirm)?$/i.test(body)) {
    // Confirm the most recent proposal for this to/from pair
    let created = false, reply;
    try {
      const proposal = await findPendingProposal({ messagesSheetId, spaKey: spaSheetKey, to, from });
      if (proposal) {
        const { name, service, date, time } = proposal;

        // write full-width row (matches your Ops->bookings header)
        await appendRow({
          sheetId: bookingsSheetId,
          tabName: 'bookings',
          row: [
            nowISO,              // timestamp_iso
            '',                  // booking_id
            spaSheetKey,         // spa_id
            'sms',               // channel
            name,                // name
            from,                // phone
            '',                  // email
            service,             // service
            `${date} ${time}`,   // start_time
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
        created = true;
        reply = `Booked (pending): ${name} · ${service} on ${niceWhen(date, time, tz)}. We’ll confirm shortly. Reply HELP for help or STOP to opt out.`;
      } else {
        reply = `I don’t see a pending request to confirm. Tell me the service, date, time, and your name to start.`;
      }
    } catch (e) {
      console.error('Create booking failed:', e.message);
      reply = `Something went wrong saving your booking. We’ll follow up shortly.`;
    }

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);
    try {
      await appendRow({
        sheetId: messagesSheetId,
        tabName: 'messages',
        row: [nowISO, spaSheetKey, '-', to, from, 'sms', `outbound:${created ? 'confirmed' : 'auto'}`, reply, 'N/A', '']
      });
    } catch (e) { console.error('Outbound log failed:', e.message); }
    return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
  }

  if (/^reschedule$/i.test(body)) {
    const reply = 'Sure — what new date and time would you like?';
    const twiml = new twilio.twiml.MessagingResponse(); twiml.message(reply);
    try { await appendRow({ sheetId: messagesSheetId, tabName: 'messages', row: [nowISO, spaSheetKey, '-', to, from, 'sms', 'outbound:auto', reply, 'N/A', ''] }); } catch {}
    return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
  }

  /* 4) AI path */
  let history = [];
  try {
    history = await fetchRecentHistory({ messagesSheetId, spaKey: spaSheetKey, to, from });
  } catch (e) { console.error('History fetch failed:', e.message); }

  // ---------- Heuristics with "latest message wins" ----------
  const slotsHeu = (() => {
    const s = { service: '', dateHint: '', timeHint: '', name: '' };

    function apply(text, prefer = false) {
      if (!text) return;
      const svc = pickService(text, svcIndex);
      const d   = extractDateHint(text);
      const t   = extractTimeHint(text);
      const nm  = nameFrom(text, svcIndex);

      // if prefer==true (current message), override any prior value
      if (svc && (prefer || !s.service))   s.service  = svc;
      if (d   && (prefer || !s.dateHint))  s.dateHint = d;
      if (t   && (prefer || !s.timeHint))  s.timeHint = t;
      if (nm  && (prefer || !s.name))      s.name     = nm;
    }

    // read older user turns first (context), then override with current message
    for (const m of history) if (m.role === 'user') apply(m.content, false);
    apply(body, true);
    return s;
  })();

  // If anything missing, run a tight LLM extractor
  let slotsLLM = { service:'', dateHint:'', timeHint:'', name:'' };
  const needsLLM = !slotsHeu.service || !slotsHeu.dateHint || !slotsHeu.timeHint || !slotsHeu.name;
  if (needsLLM) {
    try {
      slotsLLM = await llmExtractSlots({ spaDisplayName, tz, services, history, userText: body });
    } catch (e) {
      console.error('LLM extract failed:', e.message);
    }
  }

  // Merge (prefer heuristics; they already prioritize the latest user text)
  let merged = {
    service : slotsHeu.service  || slotsLLM.service,
    dateHint: slotsHeu.dateHint || slotsLLM.dateHint,
    timeHint: slotsHeu.timeHint || slotsLLM.timeHint,
    name    : slotsHeu.name     || slotsLLM.name
  };

  // If the user said "change"/"instead"/etc., re-extract from THIS message only
  // and drop previous turns for the follow-up prompt.
  let effectiveHistory = history;
  if (CHANGE_KEYWORDS.test(body)) {
    merged = {
      service : pickService(body, svcIndex),
      dateHint: extractDateHint(body),
      timeHint: extractTimeHint(body),
      name    : nameFrom(body, svcIndex)
    };
    effectiveHistory = [];
  }

  const normDate = normalizeDateHint(merged.dateHint, tz);
  const normTime = normalizeTimeHint(merged.timeHint);
  const missing = [];
  if (!merged.service) missing.push('service');
  if (!normDate)       missing.push('date');
  if (!normTime)       missing.push('time');
  if (!merged.name)    missing.push('name');

  // ---------- Ask only for what's missing, in a friendly, natural tone ----------
  if (missing.length) {
    const systemPrompt =
`You are a friendly, concise receptionist for ${spaDisplayName}.
Your goal: help the guest and keep the chat natural BUT ask ONLY for the missing piece(s): ${missing.join(', ')}.
Never promise availability. If the guest said "change" or similar, ignore earlier suggestions and rebuild from their latest message.`;

    const content = await openaiChat(
      [{ role: 'system', content: systemPrompt }, ...effectiveHistory, { role: 'user', content: body }],
      { temperature: 0.3 }
    );

    const reply = content || `Got it — could you share the missing details (${missing.join(', ')})?`;

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);
    try { await appendRow({ sheetId: messagesSheetId, tabName: 'messages', row: [nowISO, spaSheetKey, '-', to, from, 'sms', 'outbound:ai', reply, 'N/A', ''] }); } catch {}
    return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
  }

  // ---------- Enforce open hours if provided ----------
  const okHours = withinHours(normDate, normTime, tz, hoursMap);
  if (!okHours) {
    let windowText = 'our regular hours that day';
    if (hoursMap) {
      const dow = new Intl.DateTimeFormat('en-US', { weekday:'short', timeZone: tz })
                    .format(new Date(`${normDate}T00:00:00Z`)).toLowerCase().slice(0,3);
      const di = { sun:0, mon:1, tue:2, wed:3, thu:4, fri:5, sat:6 }[dow];
      const cfg = hoursMap?.[di];
      windowText = cfg ? `${cfg.open}–${cfg.close} ${tz}` : 'closed';
    }
    const reply = windowText === 'closed'
      ? `We’re closed that day. Could you pick another day/time?`
      : `We’re open ${windowText}. Could you pick a time within those hours?`;

    const twiml = new twilio.twiml.MessagingResponse(); twiml.message(reply);
    try { await appendRow({ sheetId: messagesSheetId, tabName: 'messages', row: [nowISO, spaSheetKey, '-', to, from, 'sms', 'outbound:auto', reply, 'N/A', ''] }); } catch {}
    return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
  }

  // ---------- All pieces present -> propose & ask for CONFIRM ----------
  const whenNice = niceWhen(normDate, normTime, tz);
  const proposal = { name: merged.name, service: merged.service, date: normDate, time: normTime, tz };
  const confirmText = `Here’s what I have: ${merged.name} — ${merged.service} on ${whenNice}. Reply CONFIRM to book, or say CHANGE to adjust.`;

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(confirmText);

  try {
    await appendRow({
      sheetId: messagesSheetId,
      tabName: 'messages',
      row: [nowISO, spaSheetKey, '-', to, from, 'sms', 'outbound:confirm_request', confirmText, 'N/A', buildProposalJSON(proposal)]
    });
  } catch (e) { console.error('Outbound(confirmation) log failed:', e.message); }

  return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
};
