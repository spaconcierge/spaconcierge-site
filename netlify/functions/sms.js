// netlify/functions/sms.js
// ----------------------------------------------------------------------------
// Keeps existing behavior (compliance logging, C/reschedule keywords, history,
// bookings logging) and adds per-SPA config wiring + hours + better slots.
// ----------------------------------------------------------------------------

const { appendRow } = require('./_sheets');          // writes one row
const { spaForNumber } = require('./_spa');          // legacy display name fallback
const { getConfigs } = require('./_lib/config');     // TS config loader (spas tab)
const twilio = require('twilio');
const { google } = require('googleapis');
let OpenAI = require('openai'); OpenAI = OpenAI.default || OpenAI;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 8000 });

/* ----------------------------- Tunables ----------------------------- */
const HISTORY_LIMIT        = Number(process.env.HISTORY_LIMIT  || 10);
const HISTORY_WINDOW_HOURS = Number(process.env.HISTORY_HOURS  || 48);
const BOOKING_LOOKBACK_ROWS = 80;      // recent rows to scan for de-dupe
const BOOKING_DEDUP_HOURS   = 48;      // consider dup if same within X hours

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
// — regexes —
const timeRe  = /\b(?:[01]?\d|2[0-3])(?::\d{2})?\s?(?:am|pm)?\b/i;
const dayRe   = /\b(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i;
const dateRe  = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/;
const monthRe = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?\b/i;
const relRe   = /\b(?:today|tomorrow|tmrw|this\s+(?:mon|tue|wed|thu|fri|sat|sun)|weekend)\b/i;

// — date/time helpers —
function firstMatchWithIndex(text, regexes) {
  const t = String(text || '');
  let best = null; // { val, idx }
  for (const re of regexes) {
    const m = re.exec(t);
    if (m && m.index >= 0) {
      if (best === null || m.index < best.idx) best = { val: m[0], idx: m.index };
    }
  }
  return best ? best.val : '';
}
function extractDatePart(text) {
  return firstMatchWithIndex(text, [monthRe, dateRe, dayRe, relRe]);
}
function extractTimePart(text) {
  return firstMatchWithIndex(text, [timeRe]);
}

// — timezone helpers (no external lib) —
function tzParts(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  const weekdayMap = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
  return {
    y: +parts.year, m: +parts.month, d: +parts.day,
    hh: +parts.hour, mm: +parts.minute,
    dow: weekdayMap[parts.weekday] ?? 0
  };
}
function fmtYMD({y,m,d}) {
  const pad = (n)=> String(n).padStart(2,'0');
  return `${y}-${pad(m)}-${pad(d)}`;
}
function addDays({y,m,d}, n, tz) {
  // create a date in tz by formatting then using UTC add
  const dt = new Date(`${fmtYMD({y,m,d})}T12:00:00Z`); // noon safe anchor
  // approximate shift by using UTC day math; for our “next few days” this is sufficient
  dt.setUTCDate(dt.getUTCDate() + n);
  const p = tzParts(dt, tz);
  return { y: p.y, m: p.m, d: p.d, dow: p.dow };
}
function nextDow(from, targetDow, tz) {
  let cur = { y: from.y, m: from.m, d: from.d, dow: from.dow };
  for (let i=0;i<7;i++) {
    if (i>0) cur = addDays(cur,1,tz);
    if (cur.dow === targetDow) return cur;
  }
  return from;
}
function parseDateToYMD(raw, tz) {
  const now = tzParts(new Date(), tz);
  const t = (raw || '').toLowerCase();

  // explicit month name (Sep 8[, 2025])
  const m1 = /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:,\s*(\d{4}))?/i.exec(raw || '');
  if (m1) {
    const monthIdx = "jan feb mar apr may jun jul aug sep oct nov dec".split(' ').findIndex(s => (raw||'').toLowerCase().startsWith(s));
    const M = monthIdx + 1;
    const D = +m1[1];
    const Y = m1[2] ? +m1[2] : now.y;
    return { y:Y, m:M, d:D };
  }

  // numeric 9/8[/2025]
  const m2 = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/.exec(t);
  if (m2) {
    const M = +m2[1], D = +m2[2];
    let Y = m2[3] ? +m2[3] : now.y;
    if (Y < 100) Y += 2000;
    return { y:Y, m:M, d:D };
  }

  // weekday / relative
  if (/tomorrow|tmrw/.test(t)) return addDays(now, 1, tz);
  if (/today/.test(t)) return { y: now.y, m: now.m, d: now.d };

  const wd = /(?:mon|tue|wed|thu|fri|sat|sun)/.exec(t);
  if (wd) {
    const map = { mon:1,tue:2,wed:3,thu:4,fri:5,sat:6,sun:0 };
    const target = map[wd[0].slice(0,3)];
    const base = /this\s+/.test(t) ? now : addDays(now, 1, tz); // “this tue” can be today’s week
    return nextDow(base, target, tz);
  }

  // weekend
  if (/weekend/.test(t)) {
    // choose Saturday
    return nextDow(addDays(now,1,tz), 6, tz);
  }

  return null;
}
function parseTimeToHM(raw) {
  const s = String(raw || '').trim().toLowerCase();
  const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(s);
  if (!m) return null;
  let hh = +m[1], mm = m[2] ? +m[2] : 0;
  const ampm = m[3];
  if (ampm) {
    if (ampm === 'pm' && hh < 12) hh += 12;
    if (ampm === 'am' && hh === 12) hh = 0;
  }
  if (hh >= 0 && hh <= 23 && mm >= 0 && mm < 60) return { hh, mm };
  return null;
}
function combineWhenYMDHM(datePart, timePart) {
  if (!datePart && !timePart) return { ymd:'', hm:'' };
  const ymd = datePart ? fmtYMD(datePart) : '';
  const hm  = timePart ? `${String(timePart.hh).padStart(2,'0')}:${String(timePart.mm).padStart(2,'0')}` : '';
  return { ymd, hm };
}

// — name extraction (avoid “hi/yeah/thanks/grandma” etc.) —
const namePhraseRe = /\b(?:my name(?:'s)? is|name is|i am|i'm|im|this is|call me|it's)\s+([A-Z][a-z' -]{1,29})\b/;
const bannedNames  = /^(hi|hello|hey|yeah|yep|no|thanks|thank|ok|okay|tomorrow|today|weekend|grandma|grandpa|mom|dad|sister|brother)$/i;

function nameFrom(text, idx) {
  const t = String(text || '').trim();

  const m1 = namePhraseRe.exec(t);
  if (m1) return titleCase(m1[1]);

  // capitalized single word that isn't a service, day, month, or banned term
  const cap = /\b([A-Z][a-z]{1,29})\b/.exec(t);
  if (cap) {
    const cand = cap[1].toLowerCase();
    if (
      !idx.variants.some(w => cand.includes(w)) &&
      !/\b(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(cand) &&
      !/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/i.test(cand) &&
      !bannedNames.test(cand)
    ) {
      return titleCase(cap[1]);
    }
  }

  return '';
}

/* --------------------- Hours handling (per config) ------------------ */
function parseHoursMap(hoursJson) {
  // supports {"mon-fri":"09:00-18:00","sat":"10:00-14:00","sun":null}
  // returns {0..6: {open:"HH:MM", close:"HH:MM"} | null}
  const map = {0:null,1:null,2:null,3:null,4:null,5:null,6:null};
  if (!hoursJson) return map;
  const obj = typeof hoursJson === 'string' ? JSON.parse(hoursJson) : hoursJson;
  const setRange = (didx, val) => {
    if (!val) { map[didx] = null; return; }
    const m = /(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})/.exec(val);
    if (!m) { map[didx] = null; return; }
    map[didx] = { open: m[1], close: m[2] };
  };
  const days = ['sun','mon','tue','wed','thu','fri','sat'];
  for (const k of Object.keys(obj)) {
    const val = obj[k];
    const low = k.toLowerCase();
    const r = /^(sun|mon|tue|wed|thu|fri|sat)(?:\s*-\s*(sun|mon|tue|wed|thu|fri|sat))?$/i.exec(low);
    if (r) {
      const a = days.indexOf(r[1]); const b = r[2] ? days.indexOf(r[2]) : a;
      let i = a; do { setRange(i, val); i = (i+1)%7; } while (i !== (b+1)%7);
      continue;
    }
    const idx = days.indexOf(low);
    if (idx >= 0) setRange(idx, val);
  }
  return map;
}
function isWithinHours({ ymd, hm }, tz, hoursMap) {
  if (!ymd || !hm) return false;
  const [Y,M,D] = ymd.split('-').map(n => +n);
  // Get day-of-week in tz
  const p = tzParts(new Date(`${ymd}T12:00:00Z`), tz);
  const w = p.dow; // 0..6
  const rule = hoursMap[w];
  if (!rule) return false; // closed
  return hm >= rule.open && hm <= rule.close;
}
function openWindowString(ymd, tz, hoursMap) {
  const p = tzParts(new Date(`${ymd || '2000-01-02'}T12:00:00Z`), tz);
  const rule = hoursMap[p.dow];
  return rule ? `${rule.open}–${rule.close}` : 'closed';
}

/* ----------------- Extract slots from history + message -------------- */
function extractSlotsFromMessages(history, currentUserMsg, idx, tz) {
  const now = tzParts(new Date(), tz);
  const slots = { service: '', when: '', whenDate: '', whenTime: '', name: '' };

  function apply(text) {
    if (!text) return;
    if (!slots.service) slots.service = pickService(text, idx);
    if (!slots.name)    slots.name    = nameFrom(text, idx);

    const rawDate = extractDatePart(text);
    const rawTime = extractTimePart(text);
    if (rawDate && !slots.whenDate) {
      const d = parseDateToYMD(rawDate, tz);
      if (d) slots.whenDate = fmtYMD(d);
    }
    if (rawTime && !slots.whenTime) {
      const hm = parseTimeToHM(rawTime);
      if (hm) slots.whenTime = `${String(hm.hh).padStart(2,'0')}:${String(hm.mm).padStart(2,'0')}`;
    }
  }

  for (const m of history) if (m.role === 'user') apply(m.content);
  if (currentUserMsg) apply(currentUserMsg);

  // assemble combined
  if (slots.whenDate || slots.whenTime) {
    const { ymd, hm } = combineWhenYMDHM(
      slots.whenDate ? { y:+slots.whenDate.slice(0,4), m:+slots.whenDate.slice(5,7), d:+slots.whenDate.slice(8,10) } : null,
      slots.whenTime ? { hh:+slots.whenTime.slice(0,2), mm:+slots.whenTime.slice(3,5) } : null
    );
    slots.when = `${ymd || ''}${ymd && hm ? ' ' : ''}${hm || ''}`.trim();
  }
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

/* --------------- Booking de-dup (skip identical repeats) ------------ */
async function hasRecentDuplicateBooking({ bookingsSheetId, spaKey, from, service, when, tz }) {
  if (!service || !when) return false;
  const sheets = await getSheetsRO();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: bookingsSheetId,
    range: 'bookings!A:R',
  });
  const rows = resp.data.values || [];
  const now = Date.now();

  // scan last BOOKING_LOOKBACK_ROWS rows
  for (let i = Math.max(1, rows.length - BOOKING_LOOKBACK_ROWS); i < rows.length; i++) {
    const r = rows[i];
    // columns: timestamp_iso | booking_id | spa_id | channel | name | phone | email | service | start_time | timezone | source | notes | staff | status | price | revenue | external_apt_id | utm_campaign
    const ts     = r[0] || '';
    const spa    = r[2] || '';
    const phone  = (r[5] || '').replace(/[^\d]/g,'');
    const svc    = (r[7] || '').toLowerCase();
    const start  = (r[8] || '').toLowerCase();
    const status = (r[13] || '').toLowerCase();

    if (spa !== spaKey) continue;
    if (phone !== from.replace(/[^\d]/g,'')) continue;
    if (status !== 'pending') continue;

    // consider duplicate if same service + when within last 48h
    const ageHrs = isFinite(Date.parse(ts)) ? (now - Date.parse(ts))/3600000 : 0;
    if (ageHrs > BOOKING_DEDUP_HOURS) continue;

    if (svc === String(service).toLowerCase() && start === String(when).toLowerCase()) {
      return true;
    }
  }
  return false;
}

/* -------------------------------- Handler --------------------------- */
exports.handler = async (event) => {
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
    hours: hoursJson,
    services: svcFromCfg
  } = runtime;

  const services = svcFromCfg || DEFAULT_SERVICES;
  const svcIndex = makeServiceIndex(services);
  const hoursMap = parseHoursMap(hoursJson);

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
    // Let Twilio Advanced Opt-Out send the actual SMS
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

    // History + slots
    let history = [];
    try {
      history = await fetchRecentHistory({
        messagesSheetId,
        spaKey: spaSheetKey,
        to, from
      });
    } catch (e) { console.error('History fetch failed:', e.message); }

    let slots = extractSlotsFromMessages(history, body, svcIndex, tz);
    let missing = missingFields(slots);

    // If date+time exist but outside hours, force asking for a time within the window
    let hoursHint = '';
    if (slots.whenDate && slots.whenTime) {
      const ok = isWithinHours({ ymd: slots.whenDate, hm: slots.whenTime }, tz, hoursMap);
      if (!ok) {
        hoursHint = `Open that day: ${openWindowString(slots.whenDate, tz, hoursMap)}.`;
        // Force time to be re-collected
        slots.whenTime = '';
        slots.when = slots.whenDate;
        missing = missingFields(slots);
      }
    }

    const serviceLine = services.map(s => s.price ? `${s.key} (~$${s.price})` : s.key).join(', ');

    const systemPrompt =
`You are a helpful receptionist for ${spaDisplayName}.
Tone: friendly, concise, professional.
You DO NOT have live calendar access; never promise confirmed availability.
Use prior context; short follow-ups like “will it work?” refer to the most recent unresolved request.
Business timezone: ${tz}.
Services: ${serviceLine || 'standard services'}.
If time proposed is outside opening hours on the chosen date, ask for a time within the open window. ${hoursHint ? 'Hint: ' + hoursHint : ''}

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

      // Only append booking if we have a complete & in-hours set of slots
      if (missing.length === 0) {
        // ensure we have “YYYY-MM-DD HH:mm”
        const when = `${slots.whenDate} ${slots.whenTime}`.trim();

        // Skip identical duplicates from same phone/spa within the last 48h
        let isDup = false;
        try {
          isDup = await hasRecentDuplicateBooking({
            bookingsSheetId, spaKey: spaSheetKey, from, service: slots.service, when, tz
          });
        } catch (e) {
          console.error('De-dup scan failed:', e.message);
        }

        if (!isDup) {
          try {
            await appendRow({
              sheetId: bookingsSheetId,
              tabName: 'bookings',
              row: [
                now,                 // timestamp_iso
                '',                  // booking_id
                spaSheetKey,         // spa_id (or use strict spa_id if you prefer)
                'sms',               // channel
                slots.name,          // name
                from,                // phone
                '',                  // email
                slots.service,       // service
                when,                // start_time -> concrete date & time
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
          } catch (e) { console.error('Pending booking log failed:', e.message); }
        }
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
