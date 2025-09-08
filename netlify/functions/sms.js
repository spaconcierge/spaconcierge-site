// netlify/functions/sms.js
// ----------------------------------------------------------------------------
// Memory-aware, per-SPA SMS bot with safe logging & booking confirmation.
// ----------------------------------------------------------------------------

const { appendRow } = require('./_sheets');
const { spaForNumber } = require('./_spa');
const { getConfigs } = require('./_lib/config');
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

const namePhraseRe =
  /\b(?:my name(?:'s)? is|name is|this is|it's|it is|i am|i'm|im|call me|under|for)\s+([A-Za-z][A-Za-z' -]{1,29})\b/;

/* ---------- convert “tomorrow / Fri / 9/12 2pm” → local date/time ---------- */

// current local date parts in tz
function nowParts(tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
  }).formatToParts(new Date());
  const m = +parts.find(p => p.type==='month').value;
  const d = +parts.find(p => p.type==='day').value;
  const y = +parts.find(p => p.type==='year').value;
  const wdShort = parts.find(p => p.type==='weekday').value.toLowerCase(); // mon,tue,...
  const wdMap = {sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6};
  const wd = wdMap[wdShort.slice(0,3)] ?? 0;
  return { y, m, d, wd };
}
function toUTCDate(y,m,d) { return new Date(Date.UTC(y, m-1, d)); }
function addDaysUTC(dt, days) { const t = new Date(dt.getTime()); t.setUTCDate(t.getUTCDate() + days); return t; }
function nextWeekdayFrom(parts, targetWd) {
  const delta = (targetWd - parts.wd + 7) % 7 || 7;
  return addDaysUTC(toUTCDate(parts.y, parts.m, parts.d), delta);
}
function parseTimeHM(s) {
  const t = String(s||'').trim().toLowerCase();
  const m = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let hh = +m[1], mm = +(m[2]||'0'); const ap = (m[3]||'').toLowerCase();
  if (ap==='pm' && hh<12) hh += 12;
  if (ap==='am' && hh===12) hh = 0;
  if (hh>23 || mm>59) return null;
  return { hh, mm };
}
function weekdayIndexFromWord(word) {
  const w = (word||'').toLowerCase().slice(0,3);
  const map = {sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6};
  return map[w];
}
/** return { label:"YYYY-MM-DD HH:mm", ymd:"YYYY-MM-DD", hhmm:"HH:mm" } or null */
function resolveLocalDateTime({ dateWord, timeWord, tz }) {
  if (!dateWord && !timeWord) return null;
  const parts = nowParts(tz);
  let baseDateUTC = toUTCDate(parts.y, parts.m, parts.d);

  if (/^tomorrow|tmrw/i.test(dateWord||'')) {
    baseDateUTC = addDaysUTC(baseDateUTC, 1);
  } else if (dayRe.test(dateWord||'')) {
    const wd = weekdayIndexFromWord(dateWord);
    baseDateUTC = nextWeekdayFrom(parts, wd);
  } else if (dateRe.test(dateWord||'')) {
    const m = dateWord.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    if (m) {
      const mm = +m[1], dd = +m[2], yy = m[3] ? +m[3] : parts.y;
      baseDateUTC = toUTCDate(yy<100?2000+yy:yy, mm, dd);
    }
  } else if (monthRe.test(dateWord||'')) {
    // e.g., "Sep 10"
    const m = dateWord.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:,\s*(\d{4}))?/i);
    if (m) {
      const map = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12};
      const mm = map[m[1].toLowerCase()];
      const dd = +m[2];
      const yy = m[3] ? +m[3] : parts.y;
      baseDateUTC = toUTCDate(yy, mm, dd);
    }
  }

  let hh = 9, mm = 0;
  const tm = parseTimeHM(timeWord||'');
  if (tm) { hh = tm.hh; mm = tm.mm; }

  // Build a local wall time in tz → label parts
  // We can't set tz on Date, so we format UTC date with tz to get YMD and then stitch time.
  const ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' });
  const ymdParts = ymdFmt.formatToParts(baseDateUTC);
  const Y = ymdParts.find(p=>p.type==='year').value;
  const M = ymdParts.find(p=>p.type==='month').value;
  const D = ymdParts.find(p=>p.type==='day').value;
  const ymd = `${Y}-${M}-${D}`;
  const HH = String(hh).padStart(2,'0');
  const MM = String(mm).padStart(2,'0');
  return { label: `${ymd} ${HH}:${MM}`, ymd, hhmm: `${HH}:${MM}` };
}

/* ----------------- business hours check from hours_json --------------- */
function parseHours(hoursJson) {
  // supports {"mon-fri":"09:00-18:00","sat":"10:00-14:00","sun":null}
  const out = Array(7).fill(null); // 0=Sun..6=Sat -> { openMin, closeMin } or null
  if (!hoursJson) return out;
  let obj = hoursJson;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj.replace(/[“”]/g,'"')); } catch { return out; }
  }
  const dayIdx = {sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6};
  function setRange(days, rng) {
    if (!rng) { days.forEach(i => out[i]=null); return; }
    const m = rng.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
    if (!m) return;
    const openMin  = (+m[1])*60 + (+m[2]);
    const closeMin = (+m[3])*60 + (+m[4]);
    days.forEach(i => out[i] = { openMin, closeMin });
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (/^mon-fri$/i.test(k)) setRange([1,2,3,4,5], v);
    else if (/^sat-?sun$/i.test(k)) setRange([6,0], v);
    else {
      const tokens = k.split(/[, ]+/).filter(Boolean);
      const indices = [];
      for (const t of tokens) {
        const key = t.toLowerCase().slice(0,3);
        if (dayIdx[key]!=null) indices.push(dayIdx[key]);
      }
      if (indices.length) setRange(indices, v);
    }
  }
  return out;
}
function localHMInMinutes(ymd, hhmm) {
  const [H,M] = hhmm.split(':').map(Number);
  return H*60 + M;
}
function isWithinHours({ tz, whenYmd, whenHhmm, hours }) {
  if (!hours) return { ok:true };
  const wd = new Date(`${whenYmd}T12:00:00Z`); // anchor to get weekday deterministically
  const wdShort = new Intl.DateTimeFormat('en-US',{ timeZone: tz, weekday:'short'}).format(wd).toLowerCase().slice(0,3);
  const map = {sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6};
  const idx = map[wdShort] ?? 0;
  const spec = hours[idx];
  if (!spec) return { ok:false, reason:'closed' };
  const mins = localHMInMinutes(whenYmd, whenHhmm);
  if (mins < spec.openMin || mins > spec.closeMin) {
    return {
      ok:false,
      reason:`outside_hours`,
      window: `${String(Math.floor(spec.openMin/60)).padStart(2,'0')}:${String(spec.openMin%60).padStart(2,'0')}–${String(Math.floor(spec.closeMin/60)).padStart(2,'0')}:${String(spec.closeMin%60).padStart(2,'0')}`
    };
  }
  return { ok:true };
}

/* --------- name & slot extraction (no aggressive guessing of name) -------- */
function extractDatePart(text) {
  const t = String(text||'');
  const pick = (re) => (re.exec(t)||[])[0]||'';
  return pick(monthRe) || pick(dateRe) || pick(dayRe) || pick(relRe) || '';
}
function extractTimePart(text) {
  const t = String(text||'');
  const m = timeRe.exec(t);
  return (m && m[0]) || '';
}
function nameFrom(text) {
  const t = String(text||'').trim();
  const m = namePhraseRe.exec(t);
  if (m) return titleCase(m[1]);
  return ''; // no more “Hi/Yeah” false positives
}
function extractSlotsFromMessages(history, currentUserMsg, idx) {
  const slots = { service:'', name:'', whenDate:'', whenTime:'', when:'' };
  const apply = (text) => {
    if (!text) return;
    if (!slots.service) slots.service = pickService(text, idx);
    if (!slots.name)    slots.name    = nameFrom(text);
    const d = extractDatePart(text);
    const tm = extractTimePart(text);
    if (!slots.whenDate && d) slots.whenDate = d;
    if (!slots.whenTime && tm) slots.whenTime = tm;
  };
  for (const m of history) if (m.role==='user') apply(m.content);
  if (currentUserMsg) apply(currentUserMsg);
  if (slots.whenDate || slots.whenTime) slots.when = `${slots.whenDate} ${slots.whenTime}`.trim();
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
  catch (err) {
    console.error('getConfigs failed. Falling back to default sheet.', err.message);
    return defaultRuntime(e164To);
  }
  const bySpaId = (cfgs && cfgs.bySpaId) || {};
  const byNumber = (cfgs && cfgs.byNumber) || {};

  const normTo = normalize(e164To);
  let spaId = byNumber[e164To] || byNumber[normTo] || byNumber['+'+normTo];
  if (!spaId) {
    for (const [k,v] of Object.entries(byNumber)) {
      if (normalize(k)===normTo) { spaId = v; break; }
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

/* ---------------- History: last N turns for (to,from) ---------------- */
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
    if (/^inbound/i.test(status))       role = 'user';
    else if (/^outbound/i.test(status)) role = 'assistant';
    if (!role) continue;

    out.push({ role, content: text });
  }

  return out.reverse().slice(-limit);
}

/* -------------------------------- Handler --------------------------- */
exports.handler = async (event) => {
  if (event.httpMethod === 'GET') {
    return { statusCode: 200, body: 'OK' };
  }

  const params = new URLSearchParams(event.body || '');
  const from = params.get('From') || '';
  const to   = params.get('To')   || '';
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
  const hoursArr = parseHours(hoursJson);

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

  /* 3) Decide reply */
  let reply;
  let kind = 'auto';

  // quick shortcuts
  if (/^c$/i.test(body)) {
    reply = 'Confirmed ✅ See you soon! Reply HELP for help or STOP to opt out.';
  } else if (/^reschedule$/i.test(body)) {
    reply = 'Sure — what date and time would you like instead?';
  } else {
    kind = 'ai';

    // 3a) pull history & slots
    let history = [];
    try {
      history = await fetchRecentHistory({ messagesSheetId, spaKey: spaSheetKey, to, from });
    } catch (e) { console.error('History fetch failed:', e.message); }

    const slots = extractSlotsFromMessages(history, body, svcIndex);
    const missing = missingFields(slots);

    // 3b) are we awaiting confirmation? (scan last assistant msg)
    const lastAssistant = [...history].reverse().find(m => m.role==='assistant')?.content || '';
   const awaitingConfirm = /confirm/i.test(lastAssistant);
if (awaitingConfirm && /\b(yes|y|yeah|yep|confirm|book)\b/i.test(body)) {
      // normalize “tomorrow / Fri” now (again, in case a tweak happened)
      const dt = resolveLocalDateTime({ dateWord: slots.whenDate, timeWord: slots.whenTime, tz });
      if (!dt) {
        reply = 'Got it — one more detail: what date and time would you like?';
      } else {
        const within = isWithinHours({ tz, whenYmd: dt.ymd, whenHhmm: dt.hhmm, hours: hoursArr });
        if (!within.ok) {
          if (within.reason==='closed') {
            reply = `We’re closed that day. What time works during business hours?`;
          } else {
            reply = `That’s outside our hours (${within.window}). What time works within that window?`;
          }
        } else {
          // all good → append a single row to bookings
          try {
            await appendRow({
              sheetId: bookingsSheetId,
              tabName: 'bookings',
              row: [
                now,                 // timestamp_iso
                '',                  // booking_id
                spaSheetKey,         // spa_id
                'sms',               // channel
                slots.name,          // name
                from,                // phone
                '',                  // email
                slots.service,       // service
                dt.label,            // start_time (normalized local)
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
          reply = `Booked request noted: ${slots.service} for ${slots.name} on ${dt.label} (${tz}). We’ll confirm shortly.`;
        }
      }
    }

    // 3d) Not confirming yet → gather/validate & propose
    if (!reply) {
      // If any slot missing, ask only for the missing field(s)
      if (missing.length) {
        const ask = [];
        if (missing.includes('service')) ask.push('service');
        if (missing.includes('date'))    ask.push('date');
        if (missing.includes('time'))    ask.push('time');
        if (missing.includes('name'))    ask.push('first name');
        reply = `Got it. Please share your ${ask.join(', ')}.`;
      } else {
        // all fields present → normalize datetime, check hours, then propose with YES/NO
        const dt = resolveLocalDateTime({ dateWord: slots.whenDate, timeWord: slots.whenTime, tz });
        if (!dt) {
          reply = `Thanks! To confirm, what exact date and time would you like?`;
        } else {
          const within = isWithinHours({ tz, whenYmd: dt.ymd, whenHhmm: dt.hhmm, hours: hoursArr });
          if (!within.ok) {
            if (within.reason==='closed') {
              reply = `We’re closed that day. What time works during business hours?`;
            } else {
              reply = `That’s outside our hours (${within.window}). What time within that window works for you?`;
            }
          } else {
            reply = `Great — ${slots.service} for ${slots.name} on ${dt.label} (${tz}). Reply YES to confirm, or tell me a change.`;
          }
        }
      }

      // System prompt to keep AI compact & consistent
      const servicesLine = (svcFromCfg || DEFAULT_SERVICES).map(s => s.price ? `${s.key} (~$${s.price})` : s.key).join(', ');
      const systemPrompt =
`You are a helpful receptionist for ${spaDisplayName}.
Tone: friendly, concise, professional; 1–3 SMS-length sentences max.
Never assert confirmed availability. Normalize relative dates to explicit dates in timezone: ${tz}.
Services: ${servicesLine || 'standard services'}.
Known so far:
- Service: ${slots.service || '—'}
- Date: ${slots.whenDate || '—'}
- Time: ${slots.whenTime || '—'}
- Name: ${slots.name || '—'}`;

      // Let AI polish the reply text (we already decided the logic above)
      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.3,
          messages: [
            { role: "system", content: systemPrompt },
            ...history,
            { role: "user", content: body },
            { role: "assistant", content: reply }
          ]
        });
        reply = (completion.choices?.[0]?.message?.content || reply).trim();
      } catch (e) {
        console.error('OpenAI polish error:', e.message);
      }
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

  return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
};
