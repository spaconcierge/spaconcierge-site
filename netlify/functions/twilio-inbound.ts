// netlify/functions/twilio-inbound.ts
import type { Handler } from '@netlify/functions';
import { getConfigs } from './_lib/config';
import { logMessage } from './_lib/logging';

export const handler: Handler = async (event) => {
  const params = new URLSearchParams(event.body || '');
  const to = params.get('To') || '';
  const from = params.get('From') || '';
  const body = (params.get('Body') || '').trim();

  const { byNumber, bySpaId } = await getConfigs();
  const spa_id = byNumber[to] || Object.values(bySpaId)[0]?.spa_id || 'default';

  // Log inbound
  await logMessage(spa_id, { direction: 'in', to_e164: to, from_e164: from, body });

  // Handle STOP/HELP/START: Twilio Messaging Service auto-handles carrier-level filtering.
  // You can still add your own notes if you detect these here.

  // Basic auto-reply (use greeting or after-hours based on time & hours_json)
  const conf = bySpaId[spa_id];
  const reply = conf?.greeting_template || "Hi! How can we help with booking or pricing today? Reply STOP to opt out.";
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply}</Message></Response>`;

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/xml' },
    body: twiml
  };
};
