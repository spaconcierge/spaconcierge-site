# SpaConcierge Site

Landing page and serverless functions for SpaConcierge — AI missed call booking assistant for med-spas.

## Features

- **Automated SMS booking** - AI-powered conversational booking via SMS
- **Voice consent collection** - TCPA-compliant opt-in flow
- **Calendly integration** - Webhook handling for appointment confirmations
- **Google Sheets backend** - Simple database for bookings and messages
- **Multi-spa support** - Configure multiple spa locations

## Security

This application implements several security best practices:

✅ **Webhook Authentication** - Twilio signature verification  
✅ **Rate Limiting** - Protection against SMS bombing  
✅ **Security Headers** - CSP, HSTS, X-Frame-Options  
✅ **Input Validation** - Sanitized user inputs  
✅ **Environment Variables** - Secure credential storage

See [SECURITY.md](SECURITY.md) for full details.

## Setup

### Prerequisites

- Node.js 18+
- Netlify account
- Twilio account
- OpenAI API key
- Google Cloud service account

### Environment Variables

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Required variables:
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_NUMBER`
- `OPENAI_API_KEY`
- `GOOGLE_SHEETS_ID`
- `GOOGLE_CLIENT_EMAIL`
- `GOOGLE_PRIVATE_KEY`

### Local Development

```bash
npm install
netlify dev
```

### Deployment

Deploys automatically via Netlify when pushing to `main` branch.

Set environment variables in Netlify dashboard: Site settings → Environment variables

## Project Structure

```
netlify/functions/
├── _lib/
│   ├── security.js      # Webhook validation & rate limiting
│   ├── config.ts        # Multi-spa configuration
│   └── googleSheets.ts  # Google Sheets helpers
├── sms.js              # Main SMS conversation handler
├── voice.js            # Voice call consent flow
├── consent.js          # Consent processing
└── calendly.js         # Calendly webhook handler
```

## API Endpoints

- `POST /.netlify/functions/sms` - Twilio SMS webhook
- `POST /.netlify/functions/voice` - Twilio voice webhook
- `POST /.netlify/functions/consent` - Consent processing
- `POST /.netlify/functions/calendly` - Calendly webhook

## Testing

### Test Twilio Webhooks Locally

```bash
# Install Twilio CLI
npm install -g twilio-cli

# Forward webhooks to local
twilio phone-numbers:update +1234567890 \
  --sms-url http://localhost:8888/.netlify/functions/sms
```

### Test Security

```bash
# Test without signature (should fail)
curl -X POST http://localhost:8888/.netlify/functions/voice \
  -d "From=+1234567890&To=+1987654321&Body=test"

# Test with invalid signature (should fail)
curl -X POST http://localhost:8888/.netlify/functions/voice \
  -H "X-Twilio-Signature: invalid" \
  -d "From=+1234567890&To=+1987654321&Body=test"
```

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

Proprietary - SpaConcierge 2024

## Support

For questions or issues:
- Email: matt@getspaconcierge.com
- Security issues: See [SECURITY.md](SECURITY.md)
