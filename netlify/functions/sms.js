// sms.js
const { appendRow } = require('./_sheets');
const { spaForNumber } = require('./_spa');
const twilio = require('twilio');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 8000 }); // 8s cap

// lightweight heuristics to avoid wasting GPT on trivial texts
const TRIVIAL_RE = /^(ok|okay|k|thanks|thank you|thx|👍|🙌|yes|no)\.?$/i;

function smsTrim(s) {
  // keep it SMS-friendly: single line, <= 300 chars
  return (s || "")
    .replace(/\s+/g, ' ')
    .replace(/[^\S\r\n]+/g, ' ')
    .trim()
    .slice(0, 300);
}

exports.handler = async (event) => {
  const params = new URLSearchParams(event.body || '');
  const from = params.get('From') || '';
  const to   = params.get('To')   || '';
  const body = (params.get('Body') || '').trim();
  const spaName = spaForNumber(to);
  const now = new Date().toISOString();

  // 1) Log inbound (best-effort)
  try {
    await appendRow({
      sheetId: process.env.SHEET_ID || process.env.GOOGLE_SHEETS_ID,
      tabName: 'messages',
      row: [now, spaName, '-', to, from, 'sms', 'inbound', body, 'N/A', '']
    });
  } catch (e) {
    console.error('Inbound log failed:', e.message);
  }

  // 2) Decide reply route
  let reply;
  let kind = 'auto'; // or 'ai'

  if (/^c$/i.test(body)) {
    reply = 'Confirmed ✅ See you soon! Reply HELP for help or STOP to opt out.';
  } else if (/^reschedule$/i.test(body)) {
    reply = 'Sure, please tell us your preferred date/time.';
  } else if (TRIVIAL_RE.test(body)) {
    reply = 'Got it — thank you! We’ll follow up shortly if needed.';
  } else {
    // 3) Fallback → ChatGPT for unexpected questions
    kind = 'ai';
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content:
              `You are a polite receptionist for ${spaName}. 
               Answer in 1–3 concise sentences suitable for SMS. 
               Do NOT include links unless the user explicitly asks. 
               If you are unsure, say you'll connect them with a specialist or suggest they call the spa. 
               Avoid making up prices or availability — ask a clarifying question instead.`
          },
          { role: "user", content: body }
        ],
      });
      reply = smsTrim(completion.choices?.[0]?.message?.content || '');
      if (!reply) throw new Error('Empty AI reply');
    } catch (e) {
      console.error('OpenAI error:', e.message);
      kind = 'auto';
      reply = 'Thanks for your message — we’ll get back to you shortly.';
    }
  }

  // 4) Build TwiML (always return a reply)
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);

  // 5) Log outbound (best-effort, with kind label)
  try {
    await appendRow({
      sheetId: process.env.SHEET_ID || process.env.GOOGLE_SHEETS_ID,
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
