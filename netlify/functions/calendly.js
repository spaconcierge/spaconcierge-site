import { google } from "googleapis";
import twilio from "twilio";
import { verifyCalendlySignature } from "./_lib/security.js";

// Append a row to Google Sheets
async function appendRow(values){
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: "Bookings!A1",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] }
  });
}

async function notifySlack(text){
  if (!process.env.SLACK_WEBHOOK) return;
  await fetch(process.env.SLACK_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
}

export const handler = async (event) => {
  if (event.httpMethod !== "POST")
    return { statusCode: 405, body: "Method Not Allowed" };

  // Security: Verify Calendly signature (if configured)
  if (process.env.CALENDLY_WEBHOOK_SIGNING_KEY) {
    if (!verifyCalendlySignature(event)) {
      console.error('Invalid Calendly webhook signature');
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Unauthorized' })
      };
    }
  }

  // Calendly posts JSON (Webhooks v2). We'll be lenient on shape.
  const body = JSON.parse(event.body || "{}");
  const payload = body.payload || body;

  // Try the common fields
  const invitee = payload.invitee || {};
  const ev      = payload.event || payload;
  const name    = invitee.name || ev.name || "";
  const email   = invitee.email || "";
  const qa      = invitee.questions_and_answers || [];
  const phoneQA = qa.find(q => /phone/i.test(q.question || ""))?.answer || "";
  const phone   = phoneQA.replace(/[^\d+]/g,"");
  const service = ev?.event_type?.name || ev?.name || "Appointment";
  const start   = ev?.start_time || ev?.start_time_pretty || "";
  const tz      = ev?.timezone || payload?.timezone || "";

  // Sheet row
  const row = [
    new Date().toISOString(),
    name, phone, email, service,
    start, tz, "missed_call_sms", "", ""
  ];

  try { 
    await appendRow(row); 
  } catch (e) { 
    console.error("Sheets append failed:", e?.message || e); 
  }

  // Staff alert
  await notifySlack(`✅ New booking: *${name}* — ${service} at ${start}`);

  // Optional client confirm via SMS (if a phone was captured)
  if (phone && process.env.TWILIO_ACCOUNT_SID) {
    try {
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await client.messages.create({
        from: process.env.TWILIO_NUMBER,
        to: phone,
        body: `You're booked: ${service} on ${start}. Need to adjust? You can reply here.`
      });
    } catch (e) {
      console.error("Twilio confirm SMS failed:", e?.message || e);
    }
  }

  return { statusCode: 200, body: "ok" };
};
