// /netlify/functions/voice.js
const qs = require("querystring");
const twilio = require("twilio");

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const MSG_SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID || "";
const FALLBACK_FROM = process.env.TWILIO_NUMBER || "";

// Load per-spa config from ENV (number -> { spaName, voice })
let SPA_CONFIG = {};
try {
  SPA_CONFIG = JSON.parse(process.env.SPA_CONFIG || "{}");
} catch (_) {
  SPA_CONFIG = {};
}

// Helper: pick VOICE_OPTS for the called number
function voiceOptsFor(toNumber) {
  const cfg = SPA_CONFIG[toNumber] || {};
  const voice = cfg.voice || "Polly.Joanna"; // default if not configured
  return { voice, language: "en-US" };
}

exports.handler = async (event) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  try {
    const params =
      event.httpMethod === "POST"
        ? qs.parse(event.body || "")
        : (event.queryStringParameters || {});

    const from = params.From || "";
    const to = params.To || "";
    const digits = (params.Digits || "").trim();
    const speechRaw = (params.SpeechResult || "").trim();
    const speech = speechRaw.toLowerCase();

    const VOICE_OPTS = voiceOptsFor(to);
    const spaName = (SPA_CONFIG[to] && SPA_CONFIG[to].spaName) || "our spa";

    const saidYes =
      digits === "1" || /\b(yes|yeah|yep|affirmative|sure|ok|okay)\b/.test(speech);
    const saidNo =
      digits === "2" || /\b(no|nope|negative|nah)\b/.test(speech);

    const promptForConsent = () => {
      const gather = twiml.gather({
        input: "speech dtmf",
        numDigits: 1,
        action: "/.netlify/functions/voice",
        method: "POST",
        timeout: 6,
        speechTimeout: "auto",
        bargeIn: true,
        profanityFilter: false,
        hints: "yes, no, one, two, 1, 2, opt in, opt-out",
      });
      gather.say(
        VOICE_OPTS,
        "Thanks for calling. We can text you booking help and appointment updates. " +
          "To receive texts, press 1 or say Yes. To decline, press 2 or say No. " +
          "You may receive up to three messages per appointment. Message and data rates may apply. " +
          "You can get help by replying HELP, or opt out anytime by replying STOP. " +
          "Consent is not a condition of purchase."
      );
      twiml.say(VOICE_OPTS, "We did not receive any input. Goodbye.");
    };

    if (!digits && !speechRaw) {
      promptForConsent();
      return { statusCode: 200, headers: { "Content-Type": "text/xml" }, body: twiml.toString() };
    }

    if (saidYes) {
      try {
        const messagePayload = {
          to: from,
          body:
            `You’re opted in to ${spaName} appointment updates (1–3 msgs per visit). ` +
            "Msg&Data rates may apply. For help reply HELP; to opt out reply STOP. What can we help you with?",
        };
        if (MSG_SERVICE_SID) {
          messagePayload.messagingServiceSid = MSG_SERVICE_SID;
        } else {
          messagePayload.from = FALLBACK_FROM;
        }

        console.log("Sending opt-in confirmation SMS:", messagePayload);
        await client.messages.create(messagePayload);

        twiml.say(VOICE_OPTS, "Thanks. You’re opted in. We’ll text you shortly. Goodbye.");
        twiml.hangup();
      } catch (smsErr) {
        console.error("SMS send failed:", smsErr.code, smsErr.message);

        if (smsErr.code === 21610) {
          twiml.say(
            VOICE_OPTS,
            "We could not send a text because this number has unsubscribed in the past. " +
              "Please text the word START to this number to re-enable messages. Goodbye."
          );
        } else if (smsErr.code === 21606 || smsErr.code === 21608) {
          twiml.say(
            VOICE_OPTS,
            "This destination cannot receive SMS from us right now. Please try another number. Goodbye."
          );
        } else {
          twiml.say(
            VOICE_OPTS,
            "We had trouble sending the confirmation text. Please try again later. Goodbye."
          );
        }
        twiml.hangup();
      }

      return { statusCode: 200, headers: { "Content-Type": "text/xml" }, body: twiml.toString() };
    }

    if (saidNo) {
      twiml.say(VOICE_OPTS, "No problem. We won’t text you. Goodbye.");
      twiml.hangup();
      return { statusCode: 200, headers: { "Content-Type": "text/xml" }, body: twiml.toString() };
    }

    const reprompt = twiml.gather({
      input: "speech dtmf",
      numDigits: 1,
      action: "/.netlify/functions/voice",
      method: "POST",
      timeout: 6,
      speechTimeout: "auto",
      bargeIn: true,
      hints: "yes, no, one, two, 1, 2",
    });
    reprompt.say(VOICE_OPTS, "Sorry, I didn’t catch that. Press 1 for Yes, or 2 for No.");
    twiml.say(VOICE_OPTS, "Goodbye.");

    return { statusCode: 200, headers: { "Content-Type": "text/xml" }, body: twiml.toString() };
  } catch (err) {
    console.error("voice.js fatal error:", err);
    const tw = new twilio.twiml.VoiceResponse();
    tw.say({ voice: "Polly.Joanna", language: "en-US" }, "Sorry, something went wrong. Goodbye.");
    return { statusCode: 200, headers: { "Content-Type": "text/xml" }, body: tw.toString() };
  }
};
