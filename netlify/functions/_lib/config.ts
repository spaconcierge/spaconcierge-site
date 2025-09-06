// netlify/functions/_lib/config.ts
import { readSheet } from './googleSheets';

type SpaConfig = {
  spa_id: string;
  spa_name: string;
  msid: string;
  sms_number: string;
  voice_number?: string;
  reception_number?: string;
  tz: string;
  hours_json?: string;
  greeting_template?: string;
  after_hours_template?: string;
  book_link?: string;
  sheets_ops_bookings_id?: string;
  sheets_ops_messages_id?: string;
};

let cache: { bySpaId: Record<string, SpaConfig>; byNumber: Record<string, string> } | null = null;
let cacheAt = 0;

export async function getConfigs(force = false) {
  const MAX_AGE_MS = 5 * 60 * 1000; // 5 min cache
  if (!force && cache && Date.now() - cacheAt < MAX_AGE_MS) return cache;

  const spreadsheetId = process.env.SHEETS_CONFIG_ID!;
  const { headers, data } = await readSheet({ spreadsheetId, tabName: 'spas' });
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));

  const bySpaId: Record<string, SpaConfig> = {};
  const byNumber: Record<string, string> = {}; // e164 -> spa_id

  for (const row of data) {
    const get = (k: string) => row[idx[k]] || '';
    const conf: SpaConfig = {
      spa_id: get('spa_id'),
      spa_name: get('spa_name'),
      msid: get('msid'),
      sms_number: get('sms_number'),
      voice_number: get('voice_number'),
      reception_number: get('reception_number'),
      tz: get('tz') || process.env.DEFAULT_TIMEZONE || 'America/New_York',
      hours_json: get('hours_json'),
      greeting_template: get('greeting_template'),
      after_hours_template: get('after_hours_template'),
      book_link: get('book_link'),
      sheets_ops_bookings_id: get('https://docs.google.com/spreadsheets/d/1QqWKehxNLbIaaSvdJTa6FzBuFrLGUbo4wCReZa90U0A/edit?gid=0#gid=0'),
      sheets_ops_messages_id: get('https://docs.google.com/spreadsheets/d/1QqWKehxNLbIaaSvdJTa6FzBuFrLGUbo4wCReZa90U0A/edit?gid=0#gid=0'),
    };
    if (conf.spa_id) bySpaId[conf.spa_id] = conf;
    if (conf.sms_number) byNumber[conf.sms_number] = conf.spa_id;
  }

  cache = { bySpaId, byNumber };
  cacheAt = Date.now();
  return cache;
}
