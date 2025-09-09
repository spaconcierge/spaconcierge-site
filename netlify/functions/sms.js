function looksLikeBooking(body, idx) {
  const t = String(body || '');
  const lower = t.toLowerCase();

  // Hard blocks: route cancel/change to their own flows
  if (CANCEL_KEYWORDS.test(lower) || CHANGE_KEYWORDS.test(lower)) return false;

  const hasService = !!pickService(t, idx);
  const hasDateOrTime = !!extractDateHint(t) || !!extractTimeHint(t);
  const hasFor = /\b(for\b|book\s+under\b)/i.test(t);

  // Strong signals
  if ((hasService && hasDateOrTime) || (hasFor && (hasDateOrTime || hasService))) return true;

  // Bare booking intent enters FSM at name step
  if (BOOK_KEYWORDS.test(lower)) return true;

  return false;
}

async function advanceBookingFSM({ runtime, from, to, body, activeBookings, servicesIdx, hoursMap }) {
  const { spaSheetKey, messagesSheetId, tz } = runtime;
  const phoneKey = normalize(from);
  const key = `${spaSheetKey}|${phoneKey}`;
  const nowISO = new Date().toISOString();
  let session = bookingStateMemo.get(key);
  if (!session) session = { phone: phoneKey, spa: spaSheetKey, state: 'idle', data: {}, lastUpdatedISO: nowISO };

  console.log(`advanceBookingFSM: ${key} state=${session.state} data=${JSON.stringify(session.data)}`);

  // Timeout: reset if >24h
  const last = Date.parse(session.lastUpdatedISO || 0);
  if (isFinite(last) && Date.now() - last > 24*3600*1000) {
    console.log(`advanceBookingFSM: session timeout for ${key}, resetting to idle`);
    session = { phone: phoneKey, spa: spaSheetKey, state: 'idle', data: {}, lastUpdatedISO: nowISO };
  }

  const text = String(body || '');
  const lower = text.toLowerCase();
  // Simple CHANGE handling: restart at name
  if (CHANGE_KEYWORDS.test(lower) || NEW_KEYWORDS.test(lower)) {
    console.log(`advanceBookingFSM: CHANGE/NEW detected for ${key}, resetting to awaiting_name`);
    session.state = 'awaiting_name';
    session.data = {};
    session.lastUpdatedISO = nowISO;
    bookingStateMemo.set(key, session);
    await saveBookingSession({ messagesSheetId, spaKey: spaSheetKey, to, from, session });
    return { reply: 'No problem — what name should I put this under?' };
  }

  // State machine
  if (session.state === 'idle') session.state = 'awaiting_name';

  // Try to capture all-at-once info
  const svc = pickService(text, servicesIdx);
  const dateHint = extractDateHint(text);
  const timeHint = extractTimeHint(text);
  const nm = extractForName(text) || nameFrom(text, servicesIdx);
  // Plain, lowercase name capture when awaiting_name (e.g., "michael")
  if (!nm && session.state === 'awaiting_name' && !session.data.name) {
    const plainNameRe = /^[A-Za-z][A-Za-z'’\-]{1,29}(?:\s+[A-Za-z'’\-]{1,29}){0,2}$/;
    const raw = text.trim();
    if (plainNameRe.test(raw) && !NAME_STOPWORDS.has(raw.toLowerCase())) {
      // Prefer a fuzzy match to known names if available
      const knownNames = Array.from(indexBookingsByName(activeBookings).keys());
      const hit = knownNames.length ? fuzzyMatchName(raw, knownNames) : '';
      session.data.name = hit ? hit : titleCase(raw);
    }
  }
  
  // Known-name reconciliation
  const knownNames = Array.from(indexBookingsByName(activeBookings).keys());
  
  // If message includes a name and there's a close known match, adopt that spelling immediately
  if (nm && knownNames.length > 0 && !session.data.name) {
    const matchedName = fuzzyMatchName(nm, knownNames);
    if (matchedName) {
      session.data.name = matchedName; // Use exact known spelling
    }
  }
  
  if (nm && !session.data.name) session.data.name = titleCase(nm);
  if (dateHint && !session.data.ymd) session.data.ymd = normalizeDateHint(dateHint, tz);
  if (timeHint && !session.data.hhmm) session.data.hhmm = normalizeTimeHint(timeHint);
  if (svc && !session.data.service) session.data.service = svc;

  // Known-name disambiguation at FSM name step
  if (knownNames.length > 1 && !session.data.name) {
    session.state = 'awaiting_name';
    session.lastUpdatedISO = nowISO;
    bookingStateMemo.set(key, session);
    await saveBookingSession({ messagesSheetId, spaKey: spaSheetKey, to, from, session });
    return { reply: `I see bookings for ${knownNames.join(' and ')}. Who is this for?` };
  }

  // Progression
  if (!session.data.name) {
    session.state = 'awaiting_name';
    session.lastUpdatedISO = nowISO;
    bookingStateMemo.set(key, session);
    await saveBookingSession({ messagesSheetId, spaKey: spaSheetKey, to, from, session });
    return { reply: choose([
      'Sure — what name should I put this under?',
      'Happy to help. What\'s the first name for the booking?',
      'Great — whose name should I use for the booking?'
    ]) };
  }
  if (!session.data.ymd || !session.data.hhmm) {
    session.state = 'awaiting_datetime';
    session.lastUpdatedISO = nowISO;
    bookingStateMemo.set(key, session);
    await saveBookingSession({ messagesSheetId, spaKey: spaSheetKey, to, from, session });
    return { reply: choose([
      'Nice — what day and time works for you?',
      'Got it — which day/time would you like?',
      'Thanks! What\'s a good day and time?'
    ]) };
  }
  // Check if time has already passed
  if (isPastSlot(session.data.ymd, session.data.hhmm, tz)) {
    session.state = 'awaiting_datetime';
    session.data.ymd = '';
    session.data.hhmm = '';
    session.lastUpdatedISO = nowISO;
    bookingStateMemo.set(key, session);
    await saveBookingSession({ messagesSheetId, spaKey: spaSheetKey, to, from, session });
    return { reply: 'Looks like that time\'s already gone by — could you pick another day or time?' };
  }
  // Validate hours before asking service
  if (!withinHours(session.data.ymd, session.data.hhmm, tz, hoursMap)) {
    const y = session.data.ymd;
    const wd = weekdayFromYMD(y);
    const cfg = hoursMap ? hoursMap[wd] : null;
    const windowText = cfg ? `${cfg.open}–${cfg.close}` : 'closed';
    session.state = 'awaiting_datetime';
    session.data.ymd = '';
    session.data.hhmm = '';
    session.lastUpdatedISO = nowISO;
    bookingStateMemo.set(key, session);
    await saveBookingSession({ messagesSheetId, spaKey: spaSheetKey, to, from, session });
    const replyText = windowText === 'closed' ? 'We\'re closed that day. Could you pick another day/time?' : `That time is outside our hours (${windowText}). Another time?`;
    return { reply: replyText };
  }
  if (!session.data.service) {
    session.state = 'awaiting_service';
    session.lastUpdatedISO = nowISO;
    bookingStateMemo.set(key, session);
    await saveBookingSession({ messagesSheetId, spaKey: spaSheetKey, to, from, session });
    const offered = (runtime.services || DEFAULT_SERVICES).map(s => s.key).join(', ');
    return { reply: choose([
      `Almost done! Which service would you like? We offer ${offered}.`,
      `Great — which service? Options: ${offered}.`
    ]) };
  }

  // Ready to confirm — duplicate guard first
  const whenNice = niceWhen(session.data.ymd, session.data.hhmm, tz);
  const proposing = {
    name: session.data.name,
    service: session.data.service,
    ymd: session.data.ymd,
    hhmm: session.data.hhmm
  };

  if (isDuplicateBooking(activeBookings, proposing)) {
    console.log(`advanceBookingFSM: duplicate detected for ${key}, resetting datetime`);
    session.state = 'awaiting_datetime';
    session.data.ymd = '';
    session.data.hhmm = '';
    session.lastUpdatedISO = nowISO;
    bookingStateMemo.set(key, session);
    await saveBookingSession({ messagesSheetId, spaKey: spaSheetKey, to, from, session });
    const dupMsg = `You already have ${session.data.service} for ${session.data.name} on ${whenNice}. Do you want another time or to reschedule the existing one?`;
    return { reply: dupMsg };
  }

  // Final confirmation guard: validate fields strictly
  const offeredKeys = (runtime.services || DEFAULT_SERVICES).map(s => s.key);
  if (!session.data.name || NAME_STOPWORDS.has(String(session.data.name || '').toLowerCase())) {
    session.state = 'awaiting_name';
    session.data.name = '';
    session.lastUpdatedISO = nowISO;
    bookingStateMemo.set(key, session);
    await saveBookingSession({ messagesSheetId, spaKey: spaSheetKey, to, from, session });
    return { reply: 'Could I get your first name to put the booking under?' };
  }
  if (!withinHours(session.data.ymd, session.data.hhmm, tz, hoursMap)) {
    const y = session.data.ymd;
    const wd = weekdayFromYMD(y);
    const cfg = hoursMap ? hoursMap[wd] : null;
    const windowText = cfg ? `${cfg.open}–${cfg.close}` : 'closed';
    session.state = 'awaiting_datetime';
    session.data.ymd = '';
    session.data.hhmm = '';
    session.lastUpdatedISO = nowISO;
    bookingStateMemo.set(key, session);
    await saveBookingSession({ messagesSheetId, spaKey: spaSheetKey, to, from, session });
    const replyText = windowText === 'closed' ? 'We\'re closed that day. Could you pick another day/time?' : `That time is outside our hours (${windowText}). Another time?`;
    return { reply: replyText };
  }
  if (!offeredKeys.includes(String(session.data.service || ''))) {
    session.state = 'awaiting_service';
    session.data.service = '';
    session.lastUpdatedISO = nowISO;
    bookingStateMemo.set(key, session);
    await saveBookingSession({ messagesSheetId, spaKey: spaSheetKey, to, from, session });
    const offered = offeredKeys.join(', ');
    return { reply: `Sorry, we don’t offer that service here. Our services are: ${offered}. Which one would you like?` };
  }

  // Persist session state
  console.log(`advanceBookingFSM: transitioning to awaiting_confirm for ${key}`);
  session.state = 'awaiting_confirm';
  session.lastUpdatedISO = nowISO;
  bookingStateMemo.set(key, session);
  await saveBookingSession({ messagesSheetId, spaKey: spaSheetKey, to, from, session });

  // Log a confirm_request so the CONFIRM handler can find it
  const confirmText = `Just to confirm — booking for ${session.data.name}: ${session.data.service} on ${whenNice}. If that's correct, please reply CONFIRM. Or reply CHANGE to adjust.`;

  try {
    console.log(`advanceBookingFSM: logging confirm_request for ${key}`);
    await appendRow({
      sheetId: messagesSheetId,
      tabName: 'messages',
      row: [
        new Date().toISOString(),
        spaSheetKey,
        '-',
        to,
        from,
        'sms',
        'outbound:confirm_request',
        confirmText,
        'N/A',
        buildProposalJSON({
          name: session.data.name,
          service: session.data.service,
          date: session.data.ymd,
          time: session.data.hhmm,
          tz
        })
      ]
    });
  } catch (e) {
    console.error('FSM confirm_request log failed:', e.message);
  }

  return { reply: confirmText };
}
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
const crypto = require('crypto');
let OpenAI = require('openai'); OpenAI = OpenAI.default || OpenAI;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 8000 });
const TRACE = /^true$/i.test(process.env.TRACE_LOGS || '');

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
const NEW_KEYWORDS     = /\b(new|another|add|book (?:another|new))\b/i;
const BOOK_KEYWORDS    = /\b(book|booking|appointment|schedule)\b/i;
const CHANGE_KEYWORDS  = /\b(change|instead|different|reschedule|modify|move)\b/i;
const CANCEL_KEYWORDS  = /\b(cancel|delete|remove|drop)\b/i;
const OPT_OUT_KEYWORDS = /^(stop|cancel|end|optout|quit|revoke|stopall|unsubscribe)$/i;
const OPT_IN_KEYWORDS  = /^(start|unstop|yes)$/i;
const HELP_KEYWORDS    = /^(help)$/i;

// In-memory FSM store for warm instances
const bookingStateMemo = new Map(); // key: `${spa}|${phone}` -> BookingState

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

function choose(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  return arr[Math.floor(Math.random() * arr.length)];
}

// Normalize E.164 to canonical digits (reuse normalize())
function normalizePhone(e164) {
  return normalize(e164);
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

// Google Sheets (read-write)
async function getSheetsRW() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey  = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) throw new Error('Missing GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY');

  const auth = new google.auth.JWT(
    clientEmail,
    undefined,
    privateKey,
    ['https://www.googleapis.com/auth/spreadsheets']
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
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`);
    if (re.test(t)) return idx.variantToKey.get(v) || '';
  }
  return '';
}

function normalizeServiceName(svc) {
  const s = String(svc || '').trim().toLowerCase();
  if (!s) return '';
  // strip trailing plural 's' if present
  return s.endsWith('s') ? s.slice(0, -1) : s;
}

/* -------------------------- Slot extraction ------------------------- */
// expanded slightly to be tolerant of “6pm”, “18:30”, etc.
const timeRe  = /\b(?:[01]?\d|2[0-3])(?::\d{2})?\s*(?:am|pm)?\b/i;
const dayRe   = /\b(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i;
const dateRe  = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/;
const monthRe = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?\b/i;
const relRe   = /\b(?:today|tomorrow|tmrw|this (?:mon|tue|wed|thu|fri|sat|sun|weekend)|weekend)\b/i;

// Name phrases (allow multiword names and O'…/De La …, case-insensitive)
const namePhraseRe  = /\b(?:my name(?:'s)? is|name is|i am|i'm|im|this is|call me|it's)\s+([A-Za-z][A-Za-z'’\-]{1,29}(?:\s+[A-Za-z][A-Za-z'’\-]{1,29}){0,2})\b/i;
const NAME_STOPWORDS = new Set(['hi','hey','hello','thanks','thank','ok','okay','yeah','yep','sure','please','it','no','can']);

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

function extractForName(text) {
  const t = String(text || '');
  const patterns = [
    /\bfor\s+(?:my\s+(?:son|daughter|wife|husband|partner)\s+)?([A-Za-z][A-Za-z'’\-]{1,29})\b/i,
    /\bbook\s+under\s+([A-Za-z][A-Za-z'’\-]{1,29})\b/i,
  ];
  for (const re of patterns) {
    const m = re.exec(t);
    if (m) {
      const nm = titleCase(m[1]);
      if (!NAME_STOPWORDS.has(nm.toLowerCase())) return nm;
    }
  }
  return '';
}

// --- Nickname/alias and fuzzy matching helpers ---
const NICK_ALIASES = {
  nick: 'nicholas', mike: 'michael', alex: 'alexander', liz: 'elizabeth', beth: 'elizabeth',
  tony: 'anthony', will: 'william', bill: 'william', chris: 'christopher', kate: 'katherine'
};
function normName(s) { return String(s||'').trim().toLowerCase().replace(/[^a-z]/g,''); }
function aliasName(s) {
  const n = normName(s);
  return NICK_ALIASES[n] ? NICK_ALIASES[n] : s;
}
function fuzzyMatchName(inputName, knownNames) {
  if (!inputName || !knownNames?.length) return '';
  const aliased = aliasName(inputName);
  const nIn = normName(aliased);
  // exact
  for (const k of knownNames) if (normName(k) === nIn) return k;
  // startsWith either way
  for (const k of knownNames) {
    const nk = normName(k);
    if (nk.startsWith(nIn) || nIn.startsWith(nk)) return k;
  }
  // nearest by length diff (fallback)
  let best = '', bestDiff = Infinity;
  for (const k of knownNames) {
    const diff = Math.abs(normName(k).length - nIn.length);
    if (diff < bestDiff) { best = k; bestDiff = diff; }
  }
  return best || '';
}

// Service includes helper (tolerant of variants and plurals)
function svcIncludes(candidate, key) {
  const a = normalizeServiceName(candidate);
  const b = normalizeServiceName(key);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
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

// --- Civil-time helpers (no Date timezone math) ---
function weekdayFromYMD(ymd) {
  // ymd: "YYYY-MM-DD" -> 0=Sun...6=Sat using Zeller's congruence (Gregorian)
  if (!ymd) return 0;
  const [Y, M0, D] = ymd.split('-').map(n => +n);
  let m = M0, y = Y;
  if (m < 3) { m += 12; y -= 1; }
  const K = y % 100;
  const J = Math.floor(y / 100);
  const h = (D + Math.floor((13*(m+1))/5) + K + Math.floor(K/4) + Math.floor(J/4) + 5*J) % 7; // 0=Sat..6=Fri
  // convert to 0=Sun..6=Sat
  return (h + 6) % 7;
}
const WD_ABBR = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MON_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function hhmm12(hhmm) {
  const [h, m] = (hhmm || '00:00').split(':').map(n=>+n);
  const ap = h >= 12 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2,'0')} ${ap}`;
}
function isPastSlot(ymd, hhmm, tz) {
  if (!ymd || !hhmm) return false;
  const now = nowPartsInTZ(tz);
  const today = `${String(now.year).padStart(4,'0')}-${String(now.month).padStart(2,'0')}-${String(now.day).padStart(2,'0')}`;
  const nowHM = `${String(now.hour).padStart(2,'0')}:${String(now.minute).padStart(2,'0')}`;
  if (ymd < today) return true;
  if (ymd > today) return false;
  return hhmm < nowHM;
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
  if (!ymd || !hhmm) return true;
  const wd = weekdayFromYMD(ymd); // 0=Sun..6=Sat
  // If no hours are configured, do not block
  if (!hoursMap) return true;
  const cfg = hoursMap[wd] || null;
  // Explicitly closed if day exists as null
  if (cfg === null) return false;
  // Only enforce when a window is configured for that day
  if (cfg && cfg.open && cfg.close) {
    return hhmm >= cfg.open && hhmm <= cfg.close;
  }
  // No window configured -> do not block
  return true;
}
function tzShortCode(tz) {
  if (!tz) return '';
  const tzMap = {
    'America/New_York': 'ET',
    'America/Chicago': 'CT',
    'America/Denver': 'MT',
    'America/Los_Angeles': 'PT',
    'America/Phoenix': 'MST',
    'America/Anchorage': 'AKT',
    'Pacific/Honolulu': 'HST'
  };
  return tzMap[tz] || tz.split('/').pop().slice(0,2).toUpperCase();
}
function niceWhen(ymd, hhmm, tz) {
  if (!ymd) return '';
  const [Y,M,D] = ymd.split('-').map(n=>+n);
  const wd = WD_ABBR[weekdayFromYMD(ymd)];
  const mon = MON_ABBR[(M-1)];
  const time12 = hhmm12(hhmm || '00:00');
  const tzShort = tzShortCode(tz);
  
  return `${wd}, ${mon} ${D}, ${time12}${tzShort ? ` ${tzShort}` : ''}`;
}

// Parse a booking row start_time into { ymd, hhmm } using existing normalizers
function parseStartTimeToYmdHhmm(start_time, tz) {
  const text = String(start_time || '').trim();
  if (!text) return { ymd: '', hhmm: '' };

  // 1) Try direct YYYY-MM-DD HH:mm [TZ]
  const m1 = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?:\s+[A-Za-z]{2,4})?$/.exec(text);
  if (m1) return { ymd: m1[1], hhmm: m1[2] };

  // 2) Fuzzy like "Sep 9 3pm" or other variants
  const dateHint = extractDateHint(text) || text;
  const timeHint = extractTimeHint(text) || text;
  const ymd = normalizeDateHint(dateHint, tz);
  const hhmm = normalizeTimeHint(timeHint);
  if (ymd && hhmm) return { ymd, hhmm };
  return { ymd: '', hhmm: '' };
}

/* -------------------- Bookings fetch (read-only) -------------------- */
async function fetchActiveBookings({ bookingsSheetId, spaKey, phone, tz, lookbackDays = 7, lookaheadDays = 90 }) {
  const sheets = await getSheetsRO();
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: bookingsSheetId, range: 'bookings!A:Q' });
  const rows = resp.data.values || [];
  if (!rows.length) return [];

  const normPhone = normalizePhone(phone);
  const phonesMatch = (candidate) => {
    const c = normalizePhone(candidate);
    if (!c || !normPhone) return false;
    return c === normPhone || c === '1' + normPhone || '1' + c === normPhone;
  };

  // Civil-time filtering (no UTC Date math)
  const now = nowPartsInTZ(tz);
  const todayYMD = `${String(now.year).padStart(4,'0')}-${String(now.month).padStart(2,'0')}-${String(now.day).padStart(2,'0')}`;
  
  // Pure civil date arithmetic (no JS Date timezone drift)
  const civilAddDays = (ymd, days) => {
    // ymd: "YYYY-MM-DD", days: integer (±)
    let [y, m, d] = ymd.split('-').map(n => +n);
    const monthLen = (yy, mm) => {
      const thirty = new Set([4,6,9,11]);
      if (mm === 2) { const leap = (yy%4===0 && yy%100!==0) || (yy%400===0); return leap ? 29 : 28; }
      return thirty.has(mm) ? 30 : 31;
    };
    let n = d + days;
    while (n < 1) { m -= 1; if (m < 1) { m = 12; y -= 1; } n += monthLen(y, m); }
    while (n > monthLen(y, m)) { n -= monthLen(y, m); m += 1; if (m > 12) { m = 1; y += 1; } }
    return `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(n).padStart(2,'0')}`;
  };
  
  const lowerBoundYMD = civilAddDays(todayYMD, -lookbackDays);
  const upperBoundYMD = civilAddDays(todayYMD, lookaheadDays);

  console.log(`fetchActiveBookings: spa=${spaKey}, phone=${normPhone}, tz=${tz}, range=${lowerBoundYMD} to ${upperBoundYMD}`);

  const out = [];
  let nonMatchLogs = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const spa_id   = r[2] || '';
    const name     = r[4] || '';
    const phoneCol = r[5] || '';
    const service  = r[7] || '';
    const startStr = r[8] || '';
    const rowTz    = r[9] || tz || '';
    const status   = (r[13] || '').toString().toLowerCase();

    if (spa_id !== spaKey) {
      if (TRACE && nonMatchLogs < 3) { console.log('fetchActiveBookings skip: spa mismatch', { row: i+1, spa_id, expected: spaKey }); nonMatchLogs++; }
      continue;
    }
    if (!phonesMatch(phoneCol)) {
      if (TRACE && nonMatchLogs < 3) { console.log('fetchActiveBookings skip: phone mismatch', { row: i+1, phoneCol, phone }); nonMatchLogs++; }
      continue;
    }
    if (!['pending','confirmed'].includes(status)) {
      if (TRACE && nonMatchLogs < 3) { console.log('fetchActiveBookings skip: status not active', { row: i+1, status }); nonMatchLogs++; }
      continue;
    }

    const { ymd, hhmm } = parseStartTimeToYmdHhmm(startStr, rowTz || tz);
    if (!ymd || !hhmm) continue;

    // Civil-time range check (string comparison)
    if (ymd < lowerBoundYMD || ymd > upperBoundYMD) continue;

    out.push({ name, service, ymd, hhmm, tz: rowTz || tz, status, rowIndex: i + 1 });
    if (TRACE) {
      console.log('fetchActiveBookings matched row', { rowIndex: i+1, spa_id, phoneCol, startStr, status });
    }
  }
  
  console.log(`fetchActiveBookings: found ${out.length} active bookings`);
  return out;
}

/* --------------------- Bookings helpers (index/dupe) ---------------- */
function indexBookingsByName(bookings) {
  const byName = new Map();
  for (const b of bookings || []) {
    const key = titleCase(String(b.name || '').trim());
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(b);
  }
  return byName;
}
function round15(hhmm) {
  const [h, m] = (hhmm || '00:00').split(':').map(n=>+n);
  const rounded = Math.round(m / 15) * 15;
  const carry = Math.floor(rounded / 60);
  const mm = rounded % 60;
  const hh = (h + carry) % 24;
  return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
}

function isDuplicateBooking(existing, proposed) {
  const nameKey = titleCase(proposed.name || '');
  const svcKey = normalizeServiceName(proposed.service);
  const target = round15(proposed.hhmm);
  
  console.log(`isDuplicateBooking: checking ${nameKey} ${svcKey} ${proposed.ymd} ${target} against ${existing.length} existing`);
  
  return (existing || []).some(b => {
    if (titleCase(b.name) !== nameKey) return false;
    if (normalizeServiceName(b.service) !== svcKey) return false;
    if (b.ymd !== proposed.ymd) return false;
    return round15(b.hhmm) === target;
  });
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
async function loadBookingSession({ messagesSheetId, spaKey, to, from }) {
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
    if (status !== 'session:booking') continue;
    try {
      const json = JSON.parse(notes);
      if (json && json.state) return json;
    } catch(_) {}
  }
  return null;
}
async function saveBookingSession({ messagesSheetId, spaKey, to, from, session }) {
  const payload = JSON.stringify(session);
  await appendRow({ sheetId: messagesSheetId, tabName: 'messages', row: [new Date().toISOString(), spaKey, '-', to, from, 'sms', 'session:booking', '(session)', 'N/A', payload] });
}
async function clearBookingSession({ messagesSheetId, spaKey, to, from, key }) {
  const nowISO = new Date().toISOString();
  const session = { phone: key.split('|')[1], spa: spaKey, state: 'idle', data: {}, lastUpdatedISO: nowISO };
  await saveBookingSession({ messagesSheetId, spaKey, to, from, session });
  bookingStateMemo.set(key, session);
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
    // Ignore proposals older than 24h
    const ts = r[0] || '';
    const tms = Date.parse(ts);
    if (isFinite(tms)) {
      const ageMs = Date.now() - tms;
      if (ageMs > 24 * 3600 * 1000) continue;
    }
    try {
      const json = JSON.parse(notes);
      if (json && json.service && json.date && json.time && json.name) return json;
    } catch(_) {}
  }
  return null;
}
function buildProposalJSON({ name, service, date, time, tz }) {
  const raw = `${service}|${name}|${date}|${time}|${tz}|${Date.now()}`;
  const proposal_id = crypto.createHash('sha1').update(raw).digest('hex');
  return JSON.stringify({ name, service, date, time, tz, proposal_id });
}

/* --------------------- Sheets update + action logging --------------- */
async function updateBookingFields({ spreadsheetId, rowIndex, updatesArray }) {
  // updatesArray is full row Q columns (A..Q) content
  const sheets = await getSheetsRW();
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `bookings!A${rowIndex}:Q${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [updatesArray] }
  });
}
async function appendAction({ sheetId, spaId, phone, name, action, details, status = 'open' }) {
  try {
    await appendRow({
      sheetId,
      tabName: 'actions',
      row: [new Date().toISOString(), spaId, phone, name || '', action, details || '', status]
    });
  } catch (e) {
    console.error('appendAction failed:', e.message);
  }
}

function padRowToQ(row) {
  const out = Array.isArray(row) ? row.slice() : [];
  while (out.length < 17) out.push('');
  return out;
}

/* ----------------------- LLM slot extraction pass ------------------- */
async function llmExtractSlots({ spaDisplayName, tz, services, history, userText, prefaceSys = '' }) {
  const now = nowPartsInTZ(tz);
  const svcKeys = (services || []).map(s => s.key);
  const sys =
`${prefaceSys}You are a friendly, conversational receptionist for ${spaDisplayName}. Be warm but concise.
Extract ONLY from the user's latest request; ignore stale confirmations.
Return ONLY JSON with keys: service, date_text, time_text, name.
- service: one of [${svcKeys.join(', ')}] if possible; else "".
- date_text: user's hint for date (e.g., "tomorrow", "Sep 12", "Friday"); else "".
- time_text: user's hint for time (e.g., "2pm", "14:30"); else "".
- name: first + optional last name if stated; else "".
If the user generally says they want to book but does not provide service and/or date/time, do not infer; leave missing fields empty. Do not ask for their name here.
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

  /* 3) Operator commands */
  if (/^debug$/i.test(body)) {
    // Fetch active bookings for debug info
    let debugBookings = [];
    let totalRows = 0;
    try {
      debugBookings = await fetchActiveBookings({ bookingsSheetId, spaKey: spaSheetKey, phone: from, tz });
      // Get total row count
      const sheets = await getSheetsRO();
      const resp = await sheets.spreadsheets.values.get({ spreadsheetId: bookingsSheetId, range: 'bookings!A:Q' });
      totalRows = (resp.data.values || []).length;
    } catch (e) {
      console.error('Debug fetch failed:', e.message);
    }
    
    const maskId = (id) => id ? `***${id.slice(-6)}` : 'none';
    const lines = debugBookings.slice(0, 3).map(b => `${titleCase(b.name)} — ${b.service} — ${b.ymd} ${b.hhmm} (${b.status})`);
    const debugText = `spa: ${spaSheetKey}
tz: ${tz}
messagesSheetId: ${maskId(messagesSheetId)}
bookingsSheetId: ${maskId(bookingsSheetId)}
tab: bookings
scanned: ${totalRows}
matched: ${debugBookings.length}
${lines.length ? lines.join('\n') : 'no matches'}`;
    
    const twiml = new twilio.twiml.MessagingResponse(); twiml.message(debugText);
    try { await appendRow({ sheetId: messagesSheetId, tabName: 'messages', row: [nowISO, spaSheetKey, '-', to, from, 'sms', 'outbound:auto', debugText, 'N/A', ''] }); } catch {}
    return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
  }

  if (/^reset$/i.test(body)) {
    const fsmKey = `${spaSheetKey}|${normalize(from)}`;
    console.log(`RESET: clearing FSM session for ${fsmKey}`);
    try {
      await clearBookingSession({ messagesSheetId, spaKey: spaSheetKey, to, from, key: fsmKey });
    } catch (e) { console.error('Reset failed:', e.message); }
    const reply = 'Session cleared. To start a booking, tell me your name.';
    const twiml = new twilio.twiml.MessagingResponse(); twiml.message(reply);
    try { await appendRow({ sheetId: messagesSheetId, tabName: 'messages', row: [nowISO, spaSheetKey, '-', to, from, 'sms', 'outbound:auto', reply, 'N/A', ''] }); } catch {}
    return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
  }

  if (/^whoami$/i.test(body)) {
    const reply = `Phone: ${normalize(from)}
Spa: ${spaSheetKey}
TZ: ${tz}`;
    const twiml = new twilio.twiml.MessagingResponse(); twiml.message(reply);
    try { await appendRow({ sheetId: messagesSheetId, tabName: 'messages', row: [nowISO, spaSheetKey, '-', to, from, 'sms', 'outbound:auto', reply, 'N/A', ''] }); } catch {}
    return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
  }

  /* 4) Quick commands */
  if (/^c(onfirm)?$/i.test(body)) {
    // Confirm the most recent proposal for this to/from pair
    let created = false, reply;
    try {
      let proposal = await findPendingProposal({ messagesSheetId, spaKey: spaSheetKey, to, from });
      if (!proposal) {
        const fsmKey = `${spaSheetKey}|${normalize(from)}`;
        const session = bookingStateMemo.get(fsmKey);
        if (session && session.state === 'awaiting_confirm' && session.data?.name && session.data?.service && session.data?.ymd && session.data?.hhmm) {
          proposal = { name: session.data.name, service: session.data.service, date: session.data.ymd, time: session.data.hhmm, tz };
        }
      }
      if (proposal) {
        // If we had an FSM session awaiting_confirm, reset it
        const fsmKey = `${spaSheetKey}|${normalize(from)}`;
        if (bookingStateMemo.has(fsmKey)) await clearBookingSession({ messagesSheetId, spaKey: spaSheetKey, to, from, key: fsmKey });
        const { name, service, date, time } = proposal;

        // Duplicate check at CONFIRM time (idempotency)
        console.log(`CONFIRM: checking duplicates for ${name} ${service} ${date} ${time}`);
        const currentBookings = await fetchActiveBookings({ bookingsSheetId, spaKey: spaSheetKey, phone: from, tz });
        const proposing = { name, service, ymd: date, hhmm: time };
        if (isDuplicateBooking(currentBookings, proposing)) {
          console.log(`CONFIRM: duplicate detected, not appending`);
          const whenNice = niceWhen(date, time, tz);
          reply = `You already have ${service} for ${name} on ${whenNice}. Do you want another time or to reschedule the existing one?`;
        } else {
          console.log(`CONFIRM: no duplicate, appending booking`);
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
            (() => { const z = tzShortCode(tz || ''); return z ? `${date} ${time} ${z}` : `${date} ${time}`; })(),   // start_time
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
          reply = `Booked (pending): ${name} · ${service} on ${niceWhen(date, time, tz)}. We'll confirm shortly. Reply HELP for help or STOP to opt out.`;
        }
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

  /* 4) Fetch current bookings for this number (read-only) */
  let activeBookings = [];
  try {
    activeBookings = await fetchActiveBookings({ bookingsSheetId, spaKey: spaSheetKey, phone: from, tz });
  } catch (e) {
    console.error('fetchActiveBookings failed:', e.message);
  }
  const bookingsByName = indexBookingsByName(activeBookings);
  const knownNames = Array.from(bookingsByName.keys());

  // Intent handling: CANCEL and RESCHEDULE/CHANGE lightweight flows
  const lowerBodyEarly = body.toLowerCase();
  if (CANCEL_KEYWORDS.test(lowerBodyEarly)) {
    // Try to identify which booking to cancel
    if (!activeBookings.length) {
      const reply = `I don’t see any upcoming bookings for this number. If I’m missing one, tell me the service and date.`;
      const twiml = new twilio.twiml.MessagingResponse(); twiml.message(reply);
      try { await appendRow({ sheetId: messagesSheetId, tabName: 'messages', row: [nowISO, spaSheetKey, '-', to, from, 'sms', 'outbound:auto', reply, 'N/A', ''] }); } catch {}
      return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
    }

    const hintedNameRaw = extractForName(body) || nameFrom(body, svcIndex);
    const targetByName = fuzzyMatchName(hintedNameRaw, knownNames) || hintedNameRaw || '';
    let candidates = activeBookings;
    if (targetByName) candidates = candidates.filter(b => titleCase(b.name) === titleCase(targetByName));

    // Disambiguate using service/date/time hints
    const svc = pickService(body, svcIndex);
    const dateHint = extractDateHint(body);
    const timeHint = extractTimeHint(body);
    const ymd = dateHint ? normalizeDateHint(dateHint, tz) : '';
    const hhmm = timeHint ? normalizeTimeHint(timeHint) : '';

    if (svc) {
      candidates = candidates.filter(b => svcIncludes(b.service, svc));
    }
    if (ymd) candidates = candidates.filter(b => b.ymd === ymd);
    if (hhmm) candidates = candidates.filter(b => round15(b.hhmm) === round15(hhmm));

    if (candidates.length === 0) {
      const lines = activeBookings
        .slice(0, 3)
        .map(b => `${titleCase(b.name)} — ${b.service} — ${niceWhen(b.ymd, b.hhmm, b.tz || tz)}`);
      const reply = `I couldn’t find that booking. Which appointment should I cancel?\n- ${lines.join('\n- ')}`;
      const twiml = new twilio.twiml.MessagingResponse(); twiml.message(reply);
      try { await appendRow({ sheetId: messagesSheetId, tabName: 'messages', row: [nowISO, spaSheetKey, '-', to, from, 'sms', 'outbound:auto', reply, 'N/A', ''] }); } catch {}
      return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
    }
    if (candidates.length > 1) {
      const lines = candidates
        .slice(0, 5)
        .map(b => `${titleCase(b.name)} — ${b.service} — ${niceWhen(b.ymd, b.hhmm, b.tz || tz)}`);
      const reply = `Which appointment should I cancel?\n- ${lines.join('\n- ')}\nReply with the service and date (e.g., "cancel massage Tue 11:00").`;
      const twiml = new twilio.twiml.MessagingResponse(); twiml.message(reply);
      try { await appendRow({ sheetId: messagesSheetId, tabName: 'messages', row: [nowISO, spaSheetKey, '-', to, from, 'sms', 'outbound:auto', reply, 'N/A', ''] }); } catch {}
      return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
    }

    const toCancel = candidates[0];
    if (toCancel) {
      // Read the existing row to preserve columns
      const rows = await getSheetsROValues(bookingsSheetId, `bookings!A${toCancel.rowIndex}:Q${toCancel.rowIndex}`);
      const row = padRowToQ(rows[0] || []);
      row[13] = 'cancelled'; // status col N (index 13)
      try {
        await updateBookingFields({ spreadsheetId: bookingsSheetId, rowIndex: toCancel.rowIndex, updatesArray: row });
        const reply = `All set — I’ve cancelled ${titleCase(toCancel.name)}’s ${toCancel.service} on ${niceWhen(toCancel.ymd, toCancel.hhmm, toCancel.tz || tz)}.`;
        const twiml = new twilio.twiml.MessagingResponse(); twiml.message(reply);
        try { await appendRow({ sheetId: messagesSheetId, tabName: 'messages', row: [nowISO, spaSheetKey, '-', to, from, 'sms', 'outbound:auto', reply, 'N/A', ''] }); } catch {}
        try {
          const fsmKey = `${spaSheetKey}|${normalize(from)}`;
          console.log(`CANCEL: clearing FSM session for ${fsmKey}`);
          await clearBookingSession({ messagesSheetId, spaKey: spaSheetKey, to, from, key: fsmKey });
        } catch (e) { console.error('clearBookingSession (cancel) failed:', e.message); }
        return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
    } catch (e) {
        console.error('Cancel update failed:', e.message);
        await appendAction({ sheetId: messagesSheetId, spaId: spaSheetKey, phone: from, name: toCancel.name, action: 'cancel_requested', details: `${toCancel.service} ${toCancel.ymd} ${toCancel.hhmm}` });
        const reply = `I couldn’t update that just now, but I’ve flagged it for our team.`;
        const twiml = new twilio.twiml.MessagingResponse(); twiml.message(reply);
        try { await appendRow({ sheetId: messagesSheetId, tabName: 'messages', row: [nowISO, spaSheetKey, '-', to, from, 'sms', 'outbound:auto', reply, 'N/A', ''] }); } catch {}
        try {
          const fsmKey = `${spaSheetKey}|${normalize(from)}`;
          console.log(`CANCEL: clearing FSM session for ${fsmKey} (fallback)`);
          await clearBookingSession({ messagesSheetId, spaKey: spaSheetKey, to, from, key: fsmKey });
        } catch (e2) { console.error('clearBookingSession (cancel) failed:', e2.message); }
        return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
      }
    }
  }

  if (CHANGE_KEYWORDS.test(lowerBodyEarly) || /^reschedule$/i.test(body)) {
    // Try to identify a likely target appointment: prefer single known name or name mentioned in body
    let targetName = '';
    const hintedName = extractForName(body) || nameFrom(body, svcIndex);
    if (hintedName) {
      const hit = fuzzyMatchName(hintedName, knownNames);
      if (hit) targetName = hit;
    }
    if (!targetName && knownNames.length > 1) {
      const reply = `I see bookings for ${knownNames.join(' and ')}. Who is this for?`;
      const twiml = new twilio.twiml.MessagingResponse(); twiml.message(reply);
      try { await appendRow({ sheetId: messagesSheetId, tabName: 'messages', row: [nowISO, spaSheetKey, '-', to, from, 'sms', 'outbound:auto', reply, 'N/A', ''] }); } catch {}
      return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
    }
    if (!targetName && knownNames.length === 1) targetName = knownNames[0];

    // Civil time comparisons (no UTC Date math)
    const nowParts = nowPartsInTZ(tz);
    const todayYMD = `${String(nowParts.year).padStart(4,'0')}-${String(nowParts.month).padStart(2,'0')}-${String(nowParts.day).padStart(2,'0')}`;
    const nowHM = `${String(nowParts.hour).padStart(2,'0')}:${String(nowParts.minute).padStart(2,'0')}`;
    
    let candidates = activeBookings
      .filter(b => (targetName ? titleCase(b.name) === targetName : true))
      .filter(b => (b.ymd > todayYMD) || (b.ymd === todayYMD && b.hhmm > nowHM))
      .sort((a, b) => (a.ymd.localeCompare(b.ymd) || a.hhmm.localeCompare(b.hhmm)));

    // If service mentioned, prefer matching service
    const svc = pickService(body, svcIndex);
    if (svc) {
      const filtered = candidates.filter(b => svcIncludes(b.service, svc));
      if (filtered.length) candidates = filtered;
    }

    const pick = candidates[0] || activeBookings[0];
    if (pick) {
      // If the message includes a time/date, attempt immediate update; else ask for new time
      const newDateHint = extractDateHint(body);
      const newTimeHint = extractTimeHint(body);
      const newYmd = newDateHint ? normalizeDateHint(newDateHint, tz) : '';
      const newHhmm = newTimeHint ? normalizeTimeHint(newTimeHint) : '';
      if (newYmd && newHhmm) {
        if (isPastSlot(newYmd, newHhmm, tz)) {
          const reply = 'That time has already passed. Another time?';
          const twiml = new twilio.twiml.MessagingResponse(); twiml.message(reply);
          try { await appendRow({ sheetId: messagesSheetId, tabName: 'messages', row: [nowISO, spaSheetKey, '-', to, from, 'sms', 'outbound:auto', reply, 'N/A', ''] }); } catch {}
    return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
  }
        if (!withinHours(newYmd, newHhmm, tz, hoursMap)) {
          const wd = weekdayFromYMD(newYmd);
          const cfg = hoursMap ? hoursMap[wd] : null;
          const windowText = cfg ? `${cfg.open}–${cfg.close}` : 'closed';
    const reply = windowText === 'closed'
      ? `We’re closed that day. Could you pick another day/time?`
            : `That time is outside our hours (${windowText}). Another time?`;

    const twiml = new twilio.twiml.MessagingResponse(); twiml.message(reply);
    try { await appendRow({ sheetId: messagesSheetId, tabName: 'messages', row: [nowISO, spaSheetKey, '-', to, from, 'sms', 'outbound:auto', reply, 'N/A', ''] }); } catch {}
    return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
        }
        try {
          const rows = await getSheetsROValues(bookingsSheetId, `bookings!A${pick.rowIndex}:Q${pick.rowIndex}`);
          const row = padRowToQ(rows[0] || []);
          const z = tzShortCode(pick.tz || tz || '');
          row[8] = z ? `${newYmd} ${newHhmm} ${z}` : `${newYmd} ${newHhmm}`; // start_time col I (index 8)
          await updateBookingFields({ spreadsheetId: bookingsSheetId, rowIndex: pick.rowIndex, updatesArray: row });
          const reply = `Done — I’ve moved ${titleCase(pick.name)}’s ${pick.service} to ${niceWhen(newYmd, newHhmm, pick.tz || tz)}.`;
          const twiml = new twilio.twiml.MessagingResponse(); twiml.message(reply);
          try { await appendRow({ sheetId: messagesSheetId, tabName: 'messages', row: [nowISO, spaSheetKey, '-', to, from, 'sms', 'outbound:auto', reply, 'N/A', ''] }); } catch {}
          try {
            const fsmKey = `${spaSheetKey}|${normalize(from)}`;
            console.log(`RESCHEDULE: clearing FSM session for ${fsmKey}`);
            await clearBookingSession({ messagesSheetId, spaKey: spaSheetKey, to, from, key: fsmKey });
          } catch (e) { console.error('clearBookingSession (reschedule) failed:', e.message); }
          return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
        } catch (e) {
          console.error('Reschedule update failed:', e.message);
          await appendAction({ sheetId: messagesSheetId, spaId: spaSheetKey, phone: from, name: pick.name, action: 'reschedule_requested', details: `${pick.service} ${pick.ymd} ${pick.hhmm} -> ${newYmd} ${newHhmm}` });
          const reply = `I couldn’t update that just now, but I’ve flagged it for our team.`;
          const twiml = new twilio.twiml.MessagingResponse(); twiml.message(reply);
          try { await appendRow({ sheetId: messagesSheetId, tabName: 'messages', row: [nowISO, spaSheetKey, '-', to, from, 'sms', 'outbound:auto', reply, 'N/A', ''] }); } catch {}
          try {
            const fsmKey = `${spaSheetKey}|${normalize(from)}`;
            console.log(`RESCHEDULE: clearing FSM session for ${fsmKey} (fallback)`);
            await clearBookingSession({ messagesSheetId, spaKey: spaSheetKey, to, from, key: fsmKey });
          } catch (e2) { console.error('clearBookingSession (reschedule) failed:', e2.message); }
          return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
        }
      } else {
        const reply = `I see ${titleCase(pick.name)} — ${pick.service} — ${niceWhen(pick.ymd, pick.hhmm, pick.tz || tz)}. What’s your new date and time?`;
        const twiml = new twilio.twiml.MessagingResponse(); twiml.message(reply);
        try { await appendRow({ sheetId: messagesSheetId, tabName: 'messages', row: [nowISO, spaSheetKey, '-', to, from, 'sms', 'outbound:auto', reply, 'N/A', ''] }); } catch {}
        return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
      }
    }
  }

  // Load or hydrate FSM session
  const fsmKey = `${spaSheetKey}|${normalize(from)}`;
  if (!bookingStateMemo.has(fsmKey)) {
    try {
      const persisted = await loadBookingSession({ messagesSheetId, spaKey: spaSheetKey, to, from });
      if (persisted && persisted.spa === spaSheetKey) bookingStateMemo.set(fsmKey, persisted);
    } catch (e) { console.error('loadBookingSession failed:', e.message); }
  }

  // Router: FSM vs Q&A vs AI booking flow
  const looksBooking = looksLikeBooking(body, svcIndex);
  const session = bookingStateMemo.get(fsmKey);
  if (session && session.state !== 'idle') {
    const { reply } = await advanceBookingFSM({ runtime, from, to, body, activeBookings, servicesIdx: svcIndex, hoursMap });
    const tw = new twilio.twiml.MessagingResponse(); tw.message(reply);
    try { await appendRow({ sheetId: messagesSheetId, tabName: 'messages', row: [nowISO, spaSheetKey, '-', to, from, 'sms', 'outbound:auto', reply, 'N/A', ''] }); } catch {}
    return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: tw.toString() };
  }
  if (looksBooking) {
    const { reply } = await advanceBookingFSM({ runtime, from, to, body, activeBookings, servicesIdx: svcIndex, hoursMap });
    const tw = new twilio.twiml.MessagingResponse(); tw.message(reply);
    try { await appendRow({ sheetId: messagesSheetId, tabName: 'messages', row: [nowISO, spaSheetKey, '-', to, from, 'sms', 'outbound:auto', reply, 'N/A', ''] }); } catch {}
    return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: tw.toString() };
  }

  /* 5) AI path (Q&A default) */
  let history = [];
  try {
    history = await fetchRecentHistory({ messagesSheetId, spaKey: spaSheetKey, to, from });
  } catch (e) { console.error('History fetch failed:', e.message); }

  // History scope: if user indicates NEW/CHANGE/CANCEL, only consider latest inbound
  let effectiveHistory = history;
  const lowerBody = body.toLowerCase();
  if (CHANGE_KEYWORDS.test(lowerBody) || NEW_KEYWORDS.test(lowerBody) || CANCEL_KEYWORDS.test(lowerBody)) {
    effectiveHistory = [{ role: 'user', content: body }];
  }

  // Conversational Q&A only (no booking proposals here)
  try {
    const facts = [];
    if (activeBookings.length) {
      const lines = activeBookings.slice(0,4).map(b => `${titleCase(b.name)} — ${b.service} — ${niceWhen(b.ymd, b.hhmm, b.tz || tz)} (${b.status})`);
      facts.push(`Known bookings for this number:\n- ${lines.join('\n- ')}`);
    }
    const offered = (services || DEFAULT_SERVICES).map(s => s.key).join(', ');
    if (offered) facts.push(`Services we offer: ${offered}.`);

    const sys = `You are a friendly, concise receptionist for ${spaDisplayName}. Answer conversationally.
Do not initiate booking yourself.
If the user says they want to book but does not provide service and a date/time, reply exactly: "Of course! Please tell me the service and a day/time you’d like."
Do not ask for their name at this stage — the guided steps will handle it once service and time are provided.
${facts.length ? `\nContext:\n${facts.join('\n')}\n` : ''}`;

    const reply = await openaiChat(
      [{ role: 'system', content: sys }, ...effectiveHistory, { role: 'user', content: body }],
      { temperature: 0.3 }
    );

    let text = reply || `Happy to help. What can I clarify?`;
    // Guardrail: avoid accidental booking confirmations in Q&A mode
    const guardRe = /\b(reply\s+confirm|confirm\s+to\s+book)\b/i;
    if (guardRe.test(text)) {
      text = 'Happy to help — would you like to book? I can take your name and get started.';
    }
    const twiml = new twilio.twiml.MessagingResponse(); twiml.message(text);
    try { await appendRow({ sheetId: messagesSheetId, tabName: 'messages', row: [nowISO, spaSheetKey, '-', to, from, 'sms', 'outbound:ai', text, 'N/A', ''] }); } catch {}
  return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
  } catch (e) {
    console.error('Q&A generation failed:', e.message);
    const tw = new twilio.twiml.MessagingResponse(); tw.message('Got it. How can I help further?');
    return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: tw.toString() };
  }
};

/*
Manual test script (SMS):

1) DEBUG
   - Shows spa, tz, masked sheet IDs, tab, scanned, matched=0 when you cleared Bookings.
2) WHOAMI
   - Shows normalized phone, spa key, tz.
3) Book flow strictness:
   - "I'd like to book a massage" -> ask for name
   - "Alex" -> ask date/time
   - "today 2pm" (after 2pm local) -> "That time has already passed..."
   - "Fri 8pm" (outside hours) -> "outside our hours ..."
   - "Fri 2pm" -> ask service (if not pre-parsed)
   - "massage" -> confirm line; "CONFIRM" -> 1 row appended with "YYYY-MM-DD HH:mm" (no timezone suffix)
4) Duplicate check:
   - Try to book same slot again -> duplicate message
5) Reschedule:
   - "change to Sat 9pm" -> outside hours rejection
   - "change to Sat 2pm" -> row updated (I column), message confirms
6) Cancel:
   - "cancel massage Fri 2pm" -> status becomes cancelled
7) Operator:
   - RESET -> session cleared; next "book" restarts at name
*/
