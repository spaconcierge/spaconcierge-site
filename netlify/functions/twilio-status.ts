// netlify/functions/twilio-status.ts
import type { Handler } from '@netlify/functions';
import { getConfigs } from './_lib/config';
import { logMessage } from './_lib/logging';

export const handler: Handler = async (event) => {
  const p = new URLSearchParams(event.body || '');
  const messageSid = p.get('MessageSid') || '';
  const to = p.get('To') || '';
  const from = p.get('From') || '';
  const status = p.get('MessageStatus') || '';
  const error_code = p.get('ErrorCode') || '';
  const msid = p.get('MessagingServiceSid') || '';

  const { byNumber, bySpaId } = await getConfigs();
  const spa_id = byNumber[to] || Object.values(bySpaId)[0]?.spa_id || 'default';

  await logMessage(spa_id, {
    direction: 'out',
    to_e164: to,
    from_e164: from,
    status,
    error_code: error_code || '',
    message_sid: messageSid,
    msid
  });

  return { statusCode: 204, body: '' };
};
