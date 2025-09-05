// voice.js
const twilio = require('twilio');
exports.handler = async (event) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  // Say the CTA and gather speech or 1 key
  const gather = twiml.gather({
    input: 'speech dtmf',
    numDigits: 1,
    timeout: 6,
    action: '/.netlify/functions/consent',
    method: 'POST'
  });

  gather.say(
    'Thanks for calling. We can text you booking help and appointment updates. ' +
    'To receive texts, press 1 or say Yes. To decline, press 2 or say No.'
  );

  // If they say nothing, end gently
  twiml.say('Okay, goodbye.');
  return {
    statusCode: 200,
    headers: {'Content-Type':'text/xml'},
    body: twiml.toString()
  };
};
