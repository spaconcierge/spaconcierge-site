// netlify/functions/bookings-create.ts
import type { Handler } from '@netlify/functions';
import { logBooking } from './_lib/logging';

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const payload = JSON.parse(event.body || '{}');
  const spa_id = payload.spa_id;

  if (!spa_id) return { statusCode: 400, body: 'spa_id required' };

  const booking_id = await logBooking(spa_id, {
    channel: payload.channel,
    name: payload.name,
    phone: payload.phone,
    email: payload.email,
    service: payload.service,
    start_time_local: payload.start_time_local,
    timezone: payload.timezone,
    source: payload.source,
    notes: payload.notes,
    staff: payload.staff,
    status: payload.status,
    price: payload.price,
    revenue: payload.revenue,
    external_apt_id: payload.external_apt_id,
    utm_campaign: payload.utm_campaign,
  });

  return { statusCode: 200, body: JSON.stringify({ ok: true, booking_id }) };
};
