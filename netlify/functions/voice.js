// /netlify/functions/voice.js
const qs = require("querystring");
const twilio = require("twilio");

// Optional: only needed if you want to send the confirmation SMS right now.
// Make sure these env vars exist in Netlify.
// const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

exports.handler = async (event) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  try {
    // Twilio posts application/x-www-form-urlencoded
    const params =
      event.httpMethod === "POST"
        ? qs.parse(event.body || "")
        : (event.queryStringParameters || {});
    const digits = (params.Digits || "").trim();
    const speech = (params.SpeechResult || "").toLowerCase();
    const from = params.From;
    const to = params.To;

    // Helper: restart gather (same function as action)
    const gatherPrompt = () => {
      const gather = twiml.gather({
        input: "speech dtmf",
        numDigits: 1,
        action: "/.netlify/functions/voice",
        method: "POST",
        timeout: 5,
      });
      gather.say(
        "Thanks for calling. We can text you booking help and appointment updates. " +
          "To receive texts, press 1 or say Yes. To decline, press 2 or say No."
      );
      // Fallback if no input
      twiml.say("We did not receive any input. Goodbye.");
    };

    // First-time hit (no digits yet) => prompt
    if (!digits && !speech) {
      gatherPrompt();
      return {
        statusCode: 200,
        headers: { "Content-Type": "text/xml" },
        body: twiml.toString(),
      };
    }

    const saidYes = ["yes", "yeah", "yep", "affirmative"].includes(speech);
    const saidNo = ["no", "nope", "negative"].includes(speech);

    if (digits === "1" || saidYes) {
      // ===== CONFIRMATION SMS (optional now; add once env vars are set) =====
      // await client.messages.create({
      //   to: from,
      //   from: to, // or your configured sending number
      //   body:
      //     "You’re opted in to appointment updates (1–3 msgs per visit). Msg&Data rates may apply. " +
      //     "For help reply HELP; to opt out reply STOP.",
      // });

      twiml.say("Thanks! You’re opted in. We’ll text you shortly. Goodbye.");
      twiml.hangup();

    } else if (digits === "2" || saidNo) {
      twiml.say("No problem. We won’t text you. Goodbye.");
      twiml.hangup();

    } else {
      // Unrecognized input → reprompt
      const g = twiml.gather({
        input: "speech dtmf",
        numDigits: 1,
        action: "/.netlify/functions/voice",
        method: "POST",
        timeout: 5,
      });
      g.say("Sorry, I didn’t catch that. Press 1 for yes, or 2 for no.");
      twiml.say("Goodbye.");
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "text/xml" },
      body: twiml.toString(),
    };
  } catch (err) {
    // Never let the function crash the call; always return TwiML.
    console.error("voice.js error:", err);
    twiml.say("Sorry, something went wrong. Goodbye.");
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/xml" },
      body: twiml.toString(),
    };
  }
};
