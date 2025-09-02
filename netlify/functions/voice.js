import twilio from "twilio";

export const handler = async (event) => {
  // Twilio sends x-www-form-urlencoded
  const params = new URLSearchParams(event.body || "");
  const from = params.get("From") || "";
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

  // Fire-and-forget SMS so callers can switch to text immediately
  if (from) {
    try {
      await client.messages.create({
        from: process.env.TWILIO_NUMBER,
        to: from,
        body: `Hi—it’s SpaConcierge. I can help by text. Tap to book instantly: ${process.env.CALENDLY_LINK}\nReply STOP to opt out.`
      });
    } catch (e) {
      console.error("SMS send failed", e?.message || e);
    }
  }

  // Short, friendly voice message (then hang up)
  const twiml = `
    <?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say voice="Polly.Matthew">Thanks for calling, Tristan. Hope you're having a great day LOL</Say>
      <Hangup/>
    </Response>`.trim();

  return { statusCode: 200, headers: { "Content-Type": "text/xml" }, body: twiml };
};
