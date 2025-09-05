// netlify/functions/_lib/logging.ts
import { appendRows } from './googleSheets';
import { getConfigs } from './config';

function nowISO() {
  return new Date().toISOString();
}

export async function logMessage(spa_id: string, row: {
  direction: 'in' | 'out';
  to_e164?: string;
  from_e164?: string;
  body?: string;
  status?: string;
  error_code?: string;
  message_sid?: string;
  msid?: string;
  campaign_id?: string;
  segments?: number | string;
  price?: number | string;
  intent?: string;
  matched_keyword?: string;
}) {
  const { bySpaId } = await getConfigs();
  const conf = bySpaId[spa_id];
  const spreadsheetId = conf?.sheets_ops_messages_id || process.env.SHEETS_OPS_FALLBACK_ID!;
  const values = [[
    nowISO(),
    spa_id,
    row.direction || '',
    row.to_e164 || '',
    row.from_e164 || '',
    row.body || '',
    row.status || '',
    row.error_code || '',
    row.message_sid || '',
    row.msid || conf?.msid || '',
    row.campaign_id || '',
    row.segments ?? '',
    row.price ?? '',
    row.intent || '',
    row.matched_keyword || ''
  ]];
  await appendRows({ spreadsheetId, tabName: 'messages', values });
}

export async function logBooking(spa_id: string, booking: {
  channel?: string;
  name?: string;
  phone?: string;
  email?: string;
  service?: string;
  start_time_local?: string;
  timezone?: string;
  source?: string;
  notes?: string;
  staff?: string;
  status?: string;
  price?: number | string;
  revenue?: number | string;
  external_apt_id?: string;
  utm_campaign?: string;
}) {
  const { bySpaId } = await getConfigs();
  const conf = bySpaId[spa_id];
  const spreadsheetId = conf?.sheets_ops_bookings_id || process.env.SHEETS_OPS_FALLBACK_ID!;
  const booking_id = `bk_${Date.now()}_${Math.floor(Math.random() * 1e5)}`;
  const values = [[
    new Date().toISOString(), booking_id, spa_id,
    booking.channel || '',
    booking.name || '', booking.phone || '', booking.email || '',
    booking.service || '',
    booking.start_time_local || '', booking.timezone || conf?.tz || '',
    booking.source || '',
    booking.notes || '', booking.staff || '',
    booking.status || 'requested',
    booking.price ?? '', booking.revenue ?? '',
    booking.external_apt_id || '', booking.utm_campaign || ''
  ]];
  await appendRows({ spreadsheetId, tabName: 'bookings', values });
  return booking_id;
}
