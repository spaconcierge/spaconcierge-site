// Simple, premium-feel SMS assistant (LLM is a later upgrade)
function escapeXml(str=""){return str.replace(/[<>&'"]/g,s=>({"<":"&lt;",">":"&gt;","&":"&amp;","'":"&apos;",'"':"&quot;"}[s]));}

const REPLIES = [
  { test: /(book|appt|appointment|schedule)/i,
    reply: () => `Fastest way to book is here: ${process.env.CALENDLY_LINK}\nIf you’d like, tell me a day/time and I’ll hold a slot.` },
  { test: /(price|cost|how much)/i,
    reply: () => `Typical treatments start around $150–$300 depending on service. Happy to confirm for you—what are you looking for?` },
  { test: /(hours?|open)/i,
    reply: () => `We’re open Mon–Fri 9–6 and Sat 10–4. What day works for you?` },
  { test: /(address|where|location)/i,
    reply: () => `We’re at 123 Main St, Suite 200. Parking in the rear. Need directions?` },
];

export const handler = async (event) => {
  const p = new URLSearchParams(event.body || "");
  const body = (p.get("Body") || "").trim();

  let reply = `I can help you book right now: ${process.env.CALENDLY_LINK}`;

  for (const r of REPLIES) if (r.test.test(body)) { reply = r.reply(); break; }

  // Return TwiML so Twilio replies via SMS
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`;
  return { statusCode: 200, headers: { "Content-Type": "text/xml" }, body: twiml };
};
