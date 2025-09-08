// netlify/functions/sms.js
// ----------------------------------------------------------------------------
// Preserves existing behavior (compliance logging, history memory, per-SPA
// config, bookings logging) AND adds:
//  - Slot extraction (service, date, time, name)
//  - Explicit confirmation gate ("CONFIRM" / "C") before writing bookings
//  - "Pending proposal" marker row in messages (JSON in notes col) and
//    a confirm handler that reads it and writes a single booking row
//  - Relative date resolution using SPA timezone
//  - Business hours guard using hours_json (if present)
// ----------------------------------------------------------------------------

const { appendRow } = require('./_sheets');          // writes a row
const { spaForNumber } = require('./_spa');          // legacy display name fallback
const { getConfigs } = require('./_lib/config');     // loads spas tab
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
async function getSheetsRO() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey  = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) throw new Error('Missing GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY');
  const auth = new google.auth.JWT(clientEmail, undefined, privateKey, [
    'https://www.googleapis.com/auth/spreadsheets.readonly'
  ]);
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
const timeRe  = /\b(?:[01]?\d|2[0-3])(?::\d{2})?\s?(?:am|pm)?\b/i;
const dayRe   = /\b(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i;
const dateRe  = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/;
const monthRe = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?\b/i;
const relRe   = /\b(?:today|tomorrow|tmrw|this (?:mon|tue|wed|thu|fri|sat|sun|weekend)|weekend)\b/i;
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
function extractDateHint(text) { return firstMatchWithIndex(text, [monthRe, dateRe, dayRe, relRe]); }
function extractTimeHint(text) { return firstMatchWithIndex(text, [timeRe]); }

function nameFrom(text, idx) {
  const t = String(text || '').trim();
  const m1 = namePhraseRe.exec(t);
  if (m1) return titleCase(m1[1]);

  // Any single capitalized word not obviously a service/day/month
  const cap = /\b([A-Z][a-z]{1,29})\b/.exec(t);
  if (cap) {
    const candidate = cap[1].toLowerCase();
    const isDay = /\b(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(candidate);
    const isMon = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b/i.test(candidate);
    const isServiceish = idx.variants.some(w => candidate.includes(w));
    if (!isDay && !isMon && !isServiceish) return titleCase(cap[1]);
  }

  // Fallback: first token that isn't a service word
  const m2 = /^([a-z][a-z' -]{1,29})(?:,|\s|$)/i.exec(t);
  if (m2) {
    const candidate = m2[1].toLowerCase();
    if (!idx.variants.some(w => candidate.includes(w))) return titleCase(m2[1]);
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
    weekday: new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz }).format(new Date())
  };
}
function ymdToDate(yyyy, mm, dd) { return new Date(Date.UTC(yyyy, mm-1, dd)); } // compare only by date
function formatYMD(yyyy, mm, dd) { return `${String(yyyy).padStart(4,'0')}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`; }
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
    // next Saturday
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
  // month name (e.g., "Sep 12" or "September 12, 2025")
  const m1 = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:,\s*(\d{4}))?/i.exec(hint);
  if (m1) {
    const monthIdx = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12}[m1[1].slice(0,3).toLowerCase()];
    const dd = +m1[2];
    const yy = m1[3] ? +m1[3] : year;
    return formatYMD(yy, monthIdx, dd);
  }
  // numeric "MM/DD[/YY]"
  const m2 = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(hint);
  if (m2) {
    let mm = +m2[1], dd = +m2[2], yy = m2[3] ? +m2[3] : year;
    if (yy < 100) yy += 2000;
    // if already passed this year, roll to next year
    const candidate = ymdToDate(yy, mm, dd);
    if (candidate < today) yy += 1;
    return formatYMD(yy, mm, dd);
  }
  return ''; // unrecognized
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
  // supports keys: "mon-fri", "sat", "sun", "daily", etc. with "HH:MM-HH:MM" or null
  if (!hoursJson) return null;
  let obj = null;
  try { obj = typeof hoursJson === 'string' ? JSON.parse(hoursJson) : hoursJson; } catch { return null; }
  const map = { 0:null,1:null,2:null,3:null,4:null,5:null,6:null }; // 0=Sun..6=Sat
  const apply = (rangeStr, days) => {
    if (!rangeStr) return days.forEach(d => map[d] = null);
    const mm = /(\d{2}:\d{2})-(\d{2}:\d{2})/.exec(rangeStr);
    if (!mm) return;
    days.forEach(d => map[d] = { open: mm[1], close: mm[2] });
  };
  for (const [k,v] of Object.entries(obj)) {
    const key = k.toLowerCase();
    if (key === 'daily') { apply(v, [0,1,2,3,4,5,6]); continue; }
    const one = key.match(/^(mon|tue|wed|thu|fri|sat|sun)$/);
    const span = key.match(/^(mon|tue|wed|thu|fri|sat|sun)\s*-\s*(mon|tue|wed|thu|fri|sat|sun)$/);
    if (one) apply(v, [DOW[one[1]]]);
    else if (span) {
      const a = DOW[span[1]], b = DOW[span[2]];
      const days = []; for (let i=a; i!== (b+1)%7; i=(i+1)%7) days.push(i); days.push(b);
      apply(v, days);
    }
  }
  return map;
}
function withinHours(ymd, hhmm, tz, hoursMap) {
  if (!hoursMap) return true; // no hours set => allow
  if (!ymd || !hhmm) return true;
  const d = new Date(`${ymd}T${hhmm}:00Z`); // compare by local weekday in tz
  // compute weekday in tz
  const wd = new Intl.DateTimeFormat('en-US', { weekday:'short', timeZone: tz }).format(d).toLowerCase().slice(0,3);
  const dow = DOW[wd];
  const cfg = hoursMap[dow];
  if (!cfg) return false;
  return hhmm >= cfg.open && hhmm <= cfg.close;
}
function niceWhen(ymd, hhmm, tz) {
  if (!ymd) return '';
  const [Y,M,D] = ymd.split('-').map(n=>+n);
  const [h,m] = (hhmm||'00:00').split(':').map(n=>+n);
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

/* --------------- Pending proposal marker: find & create ------------- */
async function findPendingProposal({ messagesSheetId, spaKey, to, from }) {
  // Scan recent rows for an outbound:confirm_request with JSON in notes
  const sheets = await getSheetsRO();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: messagesSheetId,
    range: 'messages!A:J',
  });
  const rows = resp.data.values || [];
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

/* -------------------------------- Handler --------------------------- */
exports.handler = async (event) => {
  if (event.httpMethod === 'GET') return { statusCode: 200, body: 'OK' };

  const params = new URLSearchParams(event.body || '');
  const from = params.get('From') || '';
  const to   = params.get('To')   || '';
  const body = (params.get('Body') || '').trim();
  const now = new Date().toISOString();

  // Load per-SPA runtime
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
      row: [now, spaSheetKey, '-', to, from, 'sms', 'inbound', body, 'N/A', '']
    });
  } catch (e) { console.error('Inbound log failed:', e.message); }

  /* 2) Compliance keywords */
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
    return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: new twilio.twiml.MessagingResponse().toString() };
  }

  /* 3) Quick commands */
  if (/^c(onfirm)?$/i.test(body)) {
    // user confirms the last pending proposal
    let created = false, reply;
    try {
      const proposal = await findPendingProposal({ messagesSheetId, spaKey: spaSheetKey, to, from });
      if (proposal) {
        const { name, service, date, time } = proposal;
        await appendRow({
          sheetId: bookingsSheetId,
          tabName: 'bookings',
          row: [
            now,                 // timestamp_iso
            '',                  // booking_id
            spaSheetKey,         // spa_id
            'sms',               // channel
            name,                // name
            from,                // phone
            '',                  // email
            service,             // service
            `${date} ${time}`,   // start_time (explicit)
            tz || '',            // timezone
            'sms',               // source
            '',                  // notes
            '',                  // staff
            'pending',           // status
            '',                  // price
            ''                   // revenue
          ]
        });
        created = true;
        reply = `Booked (pending): ${name} · ${service} on ${niceWhen(date, time, tz)}. We’ll confirm shortly. Reply HELP for help or STOP to opt out.`;
      } else {
        reply = `I don't have a pending request to confirm. Tell me the service, date, time, and your name to start.`;
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
        row: [now, spaSheetKey, '-', to, from, 'sms', `outbound:${created ? 'confirmed' : 'auto'}`, reply, 'N/A', '']
      });
    } catch (e) { console.error('Outbound log failed:', e.message); }
    return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
  }

  if (/^reschedule$/i.test(body)) {
    const reply = 'Sure — what new date and time would you like?';
    const twiml = new twilio.twiml.MessagingResponse(); twiml.message(reply);
    try { await appendRow({ sheetId: messagesSheetId, tabName: 'messages', row: [now, spaSheetKey, '-', to, from, 'sms', 'outbound:auto', reply, 'N/A', ''] }); } catch {}
    return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
  }

  /* 4) AI path when not a quick command */
  let reply;
  let kind = 'ai';

  // Pull recent history for context (for GPT question phrasing)
  let history = [];
  try {
    history = await fetchRecentHistory({ messagesSheetId, spaKey: spaSheetKey, to, from });
  } catch (e) { console.error('History fetch failed:', e.message); }

  // Extract slots (human heuristics)
  const slots = (() => {
    const s = { service: '', dateHint: '', timeHint: '', name: '' };
    const apply = (text) => {
      if (!text) return;
      if (!s.service)  s.service  = pickService(text, svcIndex);
      if (!s.dateHint) s.dateHint = extractDateHint(text);
      if (!s.timeHint) s.timeHint = extractTimeHint(text);
      if (!s.name)     s.name     = nameFrom(text, svcIndex);
    };
    for (const m of history) if (m.role === 'user') apply(m.content);
    apply(body);
    return s;
  })();

  const normDate = normalizeDateHint(slots.dateHint, tz);
  const normTime = normalizeTimeHint(slots.timeHint);
  const missing = [];
  if (!slots.service) missing.push('service');
  if (!normDate)      missing.push('date');
  if (!normTime)      missing.push('time');
  if (!slots.name)    missing.push('name');

  // If anything missing: ask ONLY for the missing pieces (via GPT)
  if (missing.length) {
    const systemPrompt =
`You are a helpful receptionist for ${spaDisplayName}.
Ask ONLY for the missing items (${missing.join(', ')}). Keep it to 1–2 short SMS sentences.
Do not promise availability.`;
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt },
          ...history,
          { role: "user", content: body }
        ]
      });
      reply = (completion.choices?.[0]?.message?.content || '').trim();
      if (!reply) throw new Error('Empty AI reply');
    } catch (e) {
      console.error('OpenAI error:', e.message);
      kind = 'auto';
      reply = 'Got it — could you share the missing details? (service, date, time, or your name).';
    }

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);
    try { await appendRow({ sheetId: messagesSheetId, tabName: 'messages', row: [now, spaSheetKey, '-', to, from, 'sms', `outbound:${kind}`, reply, 'N/A', ''] }); } catch {}
    return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
  }

  // All pieces present: enforce hours (if set)
  const okHours = withinHours(normDate, normTime, tz, hoursMap);
  if (!okHours) {
    // Build a polite nudge with the valid window
    // Find the weekday window for that date
    const wd = new Intl.DateTimeFormat('en-US', { weekday:'long', timeZone: tz })
                 .format(new Date(`${normDate}T00:00:00Z`));
    let windowText = 'our regular hours that day';
    if (hoursMap) {
      const dow = DOW[wd.toLowerCase().slice(0,3)];
      const cfg = hoursMap[dow];
      if (cfg) windowText = `${cfg.open}–${cfg.close} ${tz}`;
      else windowText = 'closed';
    }
    reply = `We’re ${windowText.includes('closed') ? 'closed that day' : `open ${windowText}`}. Could you pick a time within those hours?`;
    const twiml = new twilio.twiml.MessagingResponse(); twiml.message(reply);
    try { await appendRow({ sheetId: messagesSheetId, tabName: 'messages', row: [now, spaSheetKey, '-', to, from, 'sms', 'outbound:auto', reply, 'N/A', ''] }); } catch {}
    return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
  }

  // Build a confirmation proposal and store it as a marker row in messages.notes
  const whenNice = niceWhen(normDate, normTime, tz);
  const proposal = { name: slots.name, service: slots.service, date: normDate, time: normTime, tz };
  const confirmText = `Here’s what I have: ${slots.name} — ${slots.service} on ${whenNice}. Reply CONFIRM to book, or say CHANGE to adjust.`;

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(confirmText);

  try {
    await appendRow({
      sheetId: messagesSheetId,
      tabName: 'messages',
      row: [now, spaSheetKey, '-', to, from, 'sms', 'outbound:confirm_request', confirmText, 'N/A', buildProposalJSON(proposal)]
    });
  } catch (e) { console.error('Outbound(confirmation) log failed:', e.message); }

  return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
};
