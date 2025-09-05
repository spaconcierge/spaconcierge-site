// /netlify/functions/voice.js
const qs = require("querystring");
const twilio = require("twilio");

// Twilio REST client (needed to send the confirmation SMS)
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// If you have a Messaging Service SID (recommended), set it in Netlify env
// Otherwise we'll fall back to TWILIO_NUMBER.
const MSG_SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID || "";
const FALLBACK_FROM = process.env.TWILIO_NUMBER || "";

// Reuse this everywhere so all prompts use Polly.Joanna
const VOICE_OPTS = { voice: "Polly.Matthew", language: "en-US" };

exports.handler = async (event) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  try {
    // Twilio posts x-www-form-urlencoded on voice webhooks
    const params =
      event.httpMethod === "POST"
        ? qs.parse(event.body || "")
        : (event.queryStringParameters || {});

    const from = params.From || "";
    const to = params.To || "";
    const digits = (params.Digits || "").trim();
    const speechRaw = (params.SpeechResult || "").trim();
    const speech = speechRaw.toLowerCase();

    // Simple helpers
    const saidYes =
      digits === "1" ||
      /\b(yes|yeah|yep|affirmative|sure|ok|okay)\b/.test(speech);
    const saidNo =
      digits === "2" ||
      /\b(no|nope|negative|nah)\b/.test(speech);

    // --- prompt function (so we can reuse the exact same gather) ---
    const promptForConsent = () => {
      // bargeIn: true lets a user start speaking before the prompt ends
      const gather = twiml.gather({
        input: "speech dtmf",
        numDigits: 1,
        action: "/.netlify/functions/voice", // self-post to the same function
        method: "POST",
        timeout: 6,
        speechTimeout: "auto",
        bargeIn: true,
        profanityFilter: false,
        hints: "yes, no, one, two, 1, 2, opt in, opt-out"
      });
      gather.say(
        VOICE_OPTS,
        "Thanks for calling. We can text you booking help and appointment updates. " +
        "To receive texts, press 1 or say Yes. To decline, press 2 or say No. " +
        "You may receive up to three messages per appointment. Message and data rates may apply. " +
        "You can get help by replying HELP, or opt out anytime by replying STOP. " +
        "Consent is not a condition of purchase."
      );
      // If gather times out with no input, we’ll speak this:
      twiml.say(VOICE_OPTS, "We did not receive any input. Goodbye.");
    };

    // First hit (no input yet) -> prompt
    if (!digits && !speechRaw) {
      promptForConsent();
      return {
        statusCode: 200,
        headers: { "Content-Type": "text/xml" },
        body: twiml.toString(),
      };
    }

    // Handle yes
    if (saidYes) {
      // Try to send the confirmation SMS
      try {
        const messagePayload = {
          to: from,
          body:
            "You’re opted in to appointment updates (1–3 msgs per visit). Msg&Data rates may apply. " +
            "For help reply HELP; to opt out reply STOP.",
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
          // recipient previously opted out; they need to text START
          twiml.say(
            VOICE_OPTS,
            "We could not send a text because this number has unsubscribed in the past. " +
            "Please text the word START to this number to re-enable messages. Goodbye."
          );
          twiml.hangup();
        } else if (smsErr.code === 21606 || smsErr.code === 21608) {
          twiml.say(
            VOICE_OPTS,
            "This destination cannot receive SMS from us right now. " +
            "Please try another number. Goodbye."
          );
          twiml.hangup();
        } else {
          twiml.say(
            VOICE_OPTS,
            "We had trouble sending the confirmation text. Please try again later. Goodbye."
          );
          twiml.hangup();
        }
      }

      return {
        statusCode: 200,
        headers: { "Content-Type": "text/xml" },
        body: twiml.toString(),
      };
    }

    // Handle no
    if (saidNo) {
      twiml.say(VOICE_OPTS, "No problem. We won’t text you. Goodbye.");
      twiml.hangup();
      return {
        statusCode: 200,
        headers: { "Content-Type": "text/xml" },
        body: twiml.toString(),
      };
    }

    // Unrecognized -> re-prompt once (common reason for “works on 2nd press”)
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

    return {
      statusCode: 200,
      headers: { "Content-Type": "text/xml" },
      body: twiml.toString(),
    };
  } catch (err) {
    console.error("voice.js fatal error:", err);
    const tw = new twilio.twiml.VoiceResponse();
    tw.say(VOICE_OPTS, "Sorry, something went wrong. Goodbye.");
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/xml" },
      body: tw.toString(),
    };
  }
};
