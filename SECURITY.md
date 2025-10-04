# Security Policy

## Supported Versions

We release security updates for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| Latest  | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability, please email matt@getspaconcierge.com with:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

**Please do not open public issues for security vulnerabilities.**

We will respond within 48 hours and provide a timeline for a fix.

## Security Features

### Webhook Authentication
- All Twilio webhooks are verified using signature validation
- Calendly webhooks support optional signature verification
- Invalid signatures are rejected with 401 responses

### Rate Limiting
- SMS endpoints limited to 10 requests per minute per phone number
- Configurable via environment variables
- In-memory store with automatic cleanup

### Data Protection
- PII (phone numbers, names, messages) stored in Google Sheets
- Service account authentication for Google APIs
- HTTPS enforced for all communications
- Security headers configured (CSP, HSTS, X-Frame-Options)

### Input Validation
- Phone numbers normalized and validated
- Date/time inputs sanitized
- Service names validated against whitelist

### Environment Variables
- Sensitive credentials stored in environment variables
- Never committed to repository
- Validated at function startup

## Security Headers

All pages include:
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Strict-Transport-Security: max-age=31536000`
- `Content-Security-Policy` with strict directives
- `Referrer-Policy: strict-origin-when-cross-origin`

## Best Practices

### For Developers
1. Never commit `.env` files or credentials
2. Use `.env.example` as a template
3. Rotate API keys regularly
4. Review security logs weekly
5. Keep dependencies updated

### For Deployment
1. Use Netlify environment variables for secrets
2. Enable branch deploy previews with caution
3. Monitor function execution logs
4. Set up alerts for unusual activity
5. Test webhook endpoints with invalid signatures

## Compliance

### TCPA Compliance
- Explicit opt-in required for SMS
- STOP/HELP keywords supported
- Message frequency disclosed
- Consent logged with timestamps

### Data Privacy
- Customer data stored in Google Sheets
- No third-party data sharing
- Data retention: As per Google Sheets settings
- Right to deletion: Contact matt@getspaconcierge.com

## Known Limitations

1. **Rate Limiting**: Currently in-memory (lost on cold starts). Consider Redis for production.
2. **Session State**: Booking FSM state is in-memory. Falls back to Google Sheets.
3. **Google Sheets**: Not encrypted at rest by default. Consider Google Cloud KMS.

## Security Changelog

### 2025-10-04 - Security Hardening
- Added Twilio webhook signature verification
- Implemented rate limiting for SMS endpoints
- Added comprehensive security headers
- Removed production debug commands
- Created security utilities module
- Added environment variable validation

## Contact

For security concerns: matt@getspaconcierge.com
