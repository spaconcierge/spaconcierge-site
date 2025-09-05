// /netlify/functions/voice.js
const qs = require("querystring");
const twilio = require("twilio");

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  APP_ENV, // optional (e.g., "production")
} = process.env;

const client =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

exports.handler = async (event) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  try {
    // Twilio posts application/x-www-form-urlencoded
    const params =
      event.httpMethod === "POST"
        ? qs.parse(event.body || "")
        : event.queryStringParameters || {};

    const digits = (params.Digits || "").trim();
    const speech = (params.SpeechResult || "").trim().toLowerCase();
    const from = params.From; // caller
    const to = params.To; // your Twilio number

    // Helper to (re)prompt user
    const prompt = (prelude) => {
      if (prelude) twiml.say(prelude);
      const gather = twiml.gather({
        input: "speech dtmf",
        numDigits: 1,
        action: "/.netlify/functions/voice",
        method: "POST",
        timeout: 6,
      });
      gather.say(
        "Thanks for calling. We can text you booking help and appointment updates. " +
          "To receive texts, press 1 or say Yes. To decline, press 2 or say No."
      );
      // If no input, end politely (TwiML continues after <Gather> timeout)
      twiml.say("We did not receive any input. Goodbye.");
    };

    // First entry (no input yet)
    if (!digits && !speech) {
      prompt();
      return {
        statusCode: 200,
        headers: { "Content-Type": "text/xml" },
        body: twiml.toString(),
      };
    }

    // Normalize speech into yes/no buckets
    const yesWords = new Set(["yes", "yeah", "yep", "affirmative", "yup", "correct"]);
    const noWords = new Set(["no", "nope", "negative", "nah"]);

    const saidYes = yesWords.has(speech);
    const saidNo = noWords.has(speech);

    if (digits === "1" || saidYes) {
      // Build confirmation SMS body
      const smsBody =
        "You’re opted in to appointment updates (1–3 msgs per visit). " +
        "Msg&Data rates may apply. For help reply HELP; to opt out reply STOP.";

      let sendError = null;

      // Only send if we have credentials and we want to actually deliver in this environment
      if (client && (APP_ENV ? APP_ENV === "production" : true)) {
        try {
          const msg = await client.messages.create({
            to: from,
            from: TWILIO_NUMBER || to, // prefer explicit env; fallback to called number
            body: smsBody,
          });
          console.log("Opt-in SMS sent:", msg.sid);
        } catch (err) {
          sendError = err;
          console.error("Error sending opt-in SMS:", err.code, err.message);
        }
      } else {
        console.log("Skipping SMS send (no client or not production):", { from, to });
      }

      if (sendError && sendError.code === 21610) {
        // User previously replied STOP to this sender
        twiml.say(
          "It looks like texting is blocked for this number. " +
            "If you want to receive texts again, please send START to our number and call back."
        );
      } else if (sendError) {
        twiml.say("We had trouble sending the text. Please try again later.");
      } else {
        twiml.say("Thanks! You’re opted in. We’ll text you shortly. Goodbye.");
      }
      twiml.hangup();

    } else if (digits === "2" || saidNo) {
      twiml.say("No problem. We won’t text you. Goodbye.");
      twiml.hangup();

    } else {
      // Unrecognized — reprompt once
      prompt("Sorry, I didn’t catch that.");
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "text/xml" },
      body: twiml.toString(),
    };
  } catch (err) {
    console.error("voice.js error:", err);
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const twiml = new VoiceResponse();
    twiml.say("Sorry, something went wrong. Goodbye.");
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/xml" },
      body: twiml.toString(),
    };
  }
};
