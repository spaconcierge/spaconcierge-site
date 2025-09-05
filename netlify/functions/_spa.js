// _spa.js
let map = {};
try {
  map = JSON.parse(process.env.SPA_CONFIG_JSON || '{}');
} catch {}

function spaForNumber(twilioTo) {
  // map like { "+14155551234": { name: "Glow Spa" } }
  return (map[twilioTo] && map[twilioTo].name)
      || process.env.DEFAULT_SPA_NAME
      || 'SpaConcierge';
}

module.exports = { spaForNumber };
