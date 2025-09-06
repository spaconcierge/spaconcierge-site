// netlify/functions/_spa.js  (CJS)  — replace file
let map = {};
try {
  // support both names for consistency with voice.js
  const raw = process.env.SPA_CONFIG_JSON || process.env.SPA_CONFIG || '{}';
  map = JSON.parse(raw);
} catch { map = {}; }

function spaForNumber(twilioTo) {
  return (map[twilioTo] && map[twilioTo].name)
      || process.env.DEFAULT_SPA_NAME
      || 'SpaConcierge';
}
module.exports = { spaForNumber };
