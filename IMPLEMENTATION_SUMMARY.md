# Soft Exit Feature Implementation

## Changes Made

This branch adds a soft exit mechanism for the booking FSM. The changes allow users to bail out of the booking process without triggering carrier STOP/unsubscribe.

### Changes Required in `netlify/functions/sms.js`:

#### 1. Add EXIT_KEYWORDS constant (after line 67, after HELP_KEYWORDS)

```javascript
const HELP_KEYWORDS    = /^(help)$/i;
// Soft exit (not carrier STOP). Do NOT include bare "stop".
const EXIT_KEYWORDS    = /\b(exit|nevermind|nvm|not now|later|hold on|forget it|stop booking|stop this)\b/i;
```

#### 2. Update looksLikeBooking() function (around line 600)

Add after the CANCEL_KEYWORDS/CHANGE_KEYWORDS check:
```javascript
// Soft exit should never be treated as booking intent
if (EXIT_KEYWORDS.test(lower)) return false;
```

#### 3. Add early EXIT handler in advanceBookingFSM() (around line 650)

Add immediately after `const lower = text.toLowerCase();`:

```javascript
// Soft EXIT: allow user to bail out of booking flow at any point (does not unsubscribe)
if (EXIT_KEYWORDS.test(lower)) {
  console.log(`advanceBookingFSM: EXIT detected for ${key}, resetting to idle`);
  session = { phone: phoneKey, spa: spaSheetKey, state: 'idle', data: {}, lastUpdatedISO: nowISO };
  bookingStateMemo.set(key, session);
  await saveBookingSession({ messagesSheetId, spaKey: spaSheetKey, to, from, session });
  try {
    await appendAction({ sheetId: messagesSheetId, spaId: spaSheetKey, phone: from, name: session?.data?.name || '', action: 'booking_exit', details: `state_was=${session.state}` });
  } catch (e) { console.error('appendAction (exit) failed:', e.message); }
  return { reply: 'No problem — I\'ve stopped the booking process. If you\'d like to book later, just tell me the service and a day/time.' };
}
```

#### 4. Add global EXIT catch in handler (around line 1900, optional but recommended)

Add after fetching active bookings and before FSM routing:

```javascript
// Soft exit outside of an active FSM session (polite no-op)
if (EXIT_KEYWORDS.test((body || '').toLowerCase())) {
  const reply = 'Got it — I\'ll pause here. When you\'re ready, tell me the service and a day/time to get started.';
  const twiml = new twilio.twiml.MessagingResponse(); twiml.message(reply);
  try {
    await appendRow({ sheetId: messagesSheetId, tabName: 'messages', row: [nowISO, spaSheetKey, '-', to, from, 'sms', 'outbound:auto', reply, 'N/A', ''] });
  } catch {}
  return { statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: twiml.toString() };
}
```

## Test Cases

### Case 1: Mid-flow exit
- User: "I'd like to book a facial"
- Bot: "Sure — what name should I put this under?"
- User: "nevermind"
- Bot: "No problem — I've stopped the booking process. If you'd like to book later, just tell me the service and a day/time."
- ✓ Session reset to idle
- ✓ No further prompts

### Case 2: Exit at datetime step
- User: "book massage"
- Bot: "Sure — what name should I put this under?"
- User: "Alex"
- Bot: "Nice — what day and time works for you?"
- User: "later"
- Bot: "No problem — I've stopped the booking process..."
- ✓ booking_exit action logged

### Case 3: Booking detector guard
- User: "maybe later, not now"
- Bot: Q&A response (not FSM entry)
- ✓ looksLikeBooking() returns false

### Case 4: STOP remains intact
- User: "STOP"
- Bot: (Carrier opt-out, empty TwiML)
- ✓ EXIT_KEYWORDS doesn't match bare "stop"
- ✓ OPT_OUT_KEYWORDS path still works

### Case 5: CHANGE/CANCEL unaffected
- User: "change to Fri 2pm" → works as before
- User: "cancel massage" → works as before
- ✓ Existing flows unchanged

## Implementation Status

- [x] Branch created: feature/exit-booking-flow
- [ ] EXIT_KEYWORDS added to sms.js
- [ ] looksLikeBooking() updated
- [ ] advanceBookingFSM() EXIT handler added
- [ ] Global EXIT catch added (optional)
- [ ] All test cases verified
- [ ] PR created

## Next Steps

1. Apply the 4 code changes listed above to `netlify/functions/sms.js`
2. Test all 5 acceptance criteria
3. Create PR with title: "Add soft exit for booking FSM (no STOP)"
4. Request review

## Notes

- EXIT_KEYWORDS intentionally excludes bare "stop" to avoid collision with Twilio STOP
- Exit is logged as action 'booking_exit' for analytics
- Session is reset to 'idle' state, not deleted
- No unsubscribe/opt-out is triggered
- Message is warm and leaves door open for future booking
