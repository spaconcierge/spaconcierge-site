// /netlify/functions/voice.js
const qs = require("querystring");
const twilio = require("twilio");

// Optional SMS client (uncomment when you want to send confirmation SMS here)
// const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

exports.handler = async (event) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  try {
    // Twilio posts x-www-form-urlencoded
    const params =
      event.httpMethod === "POST"
        ? qs.parse(event.body || "")
        : (event.queryStringParameters || {});

    const from = params.From;
    const to   = params.To;

    const digits = (params.Digits || "").trim();
    const speechRaw = (params.SpeechResult || "").trim();
    const speech = speechRaw.toLowerCase();
    const confidence = params.Confidence ? Number(params.Confidence) : undefined;

    // Track gather attempts to avoid infinite loops
    const tryCount = Number(params.tryCount || 0);

    // Helpers
    const sayCommonDisclosures = (say) => {
      say.say(
        "You may receive up to three messages per appointment. " +
        "Message and data rates may apply. " +
        "You can get help by replying HELP, or opt out anytime by replying STOP. " +
        "Consent is not a condition of purchase. " +
        "Our terms are at get spa concierge dot com slash S M S terms, " +
        "and our privacy policy is at get spa concierge dot com slash S M S privacy."
      );
    };

    const startGather = (promptText, attempt) => {
      const gather = twiml.gather({
        input: "speech dtmf",
        numDigits: 1,              // for keypad
        speechTimeout: "auto",     // end when caller stops
        hints: "yes,yeah,yep,yup,affirmative,ok,no,nope,negative", // improve ASR
        action: "/.netlify/functions/voice", // POST back here
        method: "POST",
        timeout: 5,
      });
      // Carry the attempt count via <Say> + <Pause> + <Redirect> trick is not needed.
      // Twilio will include the same params (Digits/SpeechResult). We'll include our own marker:
      gather.say(
        (promptText ||
          "Thanks for calling. We can text you booking help and appointment updates. " +
          "To receive texts, press 1 or say Yes. To decline, press 2 or say No.")
      );
      // add light, neutral disclosures only on the first prompt
      if (attempt === 0) {
        sayCommonDisclosures(gather);
      }
    };

    const isYes = () => {
      if (digits === "1") return true;
      if (!speech) return false;
      const yesWords = [
        "yes","yeah","yep","yup","ok","okay","sure","affirmative","please do","go ahead"
      ];
      return yesWords.some(w => speech.includes(w)) && (confidence === undefined || confidence >= 0.3);
    };

    const isNo = () => {
      if (digits === "2") return true;
      if (!speech) return false;
      const noWords = ["no","nope","negative","nah","don’t","do not","stop"];
      return noWords.some(w => speech.includes(w)) && (confidence === undefined || confidence >= 0.3);
    };

    // 1) If no input yet -> play first gather and RETURN
    if (!digits && !speech) {
      startGather(null, tryCount);
      return { statusCode: 200, headers: { "Content-Type": "text/xml" }, body: twiml.toString() };
    }

    // 2) We received something -> decide
    if (isYes()) {
      // Optional: send confirmation SMS
      // await client.messages.create({
      //   to: from,
      //   from: to,
      //   body:
      //     "You’re opted in to appointment updates (1–3 msgs per visit). Msg&Data rates may apply. " +
      //     "For help reply HELP; to opt out reply STOP."
      // });

      twiml.say("Thanks! You are opted in. We will text you shortly. Goodbye.");
      twiml.hangup();
      return { statusCode: 200, headers: { "Content-Type": "text/xml" }, body: twiml.toString() };
    }

    if (isNo()) {
      twiml.say("No problem. We will not text you. Goodbye.");
      twiml.hangup();
      return { statusCode: 200, headers: { "Content-Type": "text/xml" }, body: twiml.toString() };
    }

    // 3) Unrecognized input -> reprompt once, then exit
    if (tryCount < 1) {
      // Reprompt once with clearer instruction
      const gather = twiml.gather({
        input: "speech dtmf",
        numDigits: 1,
        speechTimeout: "auto",
        hints: "yes,yeah,yep,yup,affirmative,ok,no,nope,negative",
        action: "/.netlify/functions/voice?tryCount=1", // mark second attempt
        method: "POST",
        timeout: 5,
      });
      gather.say("Sorry, I didn’t catch that. Press 1 or say Yes. Press 2 or say No.");
      return { statusCode: 200, headers: { "Content-Type": "text/xml" }, body: twiml.toString() };
    }

    twiml.say("Sorry, I’m still not getting a clear response. Goodbye.");
    twiml.hangup();
    return { statusCode: 200, headers: { "Content-Type": "text/xml" }, body: twiml.toString() };

  } catch (err) {
    console.error("voice.js error:", err, err?.stack);
    // Always return TwiML so Twilio doesn't error out
    twiml.say("Sorry, something went wrong. Goodbye.");
    return { statusCode: 200, headers: { "Content-Type": "text/xml" }, body: twiml.toString() };
  }
};
