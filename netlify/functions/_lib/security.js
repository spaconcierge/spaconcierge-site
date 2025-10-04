// Security utilities for webhook validation and rate limiting
const twilio = require('twilio');
const crypto = require('crypto');

// In-memory rate limit store (consider Redis for production multi-instance)
const rateLimitStore = new Map();

/**
 * Verify Twilio webhook signature
 * @param {Object} event - Netlify function event
 * @returns {boolean} - True if signature is valid
 */
function verifyTwilioSignature(event) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.error('TWILIO_AUTH_TOKEN not configured');
    return false;
  }

  const signature = event.headers['x-twilio-signature'] || event.headers['X-Twilio-Signature'];
  if (!signature) {
    console.warn('Missing Twilio signature header');
    return false;
  }

  // Reconstruct the URL
  const protocol = event.headers['x-forwarded-proto'] || 'https';
  const host = event.headers.host;
  const url = `${protocol}://${host}${event.path}`;

  try {
    const params = new URLSearchParams(event.body || '');
    const paramsObject = Object.fromEntries(params.entries());
    return twilio.validateRequest(authToken, signature, url, paramsObject);
  } catch (error) {
    console.error('Twilio signature validation error:', error.message);
    return false;
  }
}

/**
 * Verify Calendly webhook signature
 * @param {Object} event - Netlify function event
 * @returns {boolean} - True if signature is valid
 */
function verifyCalendlySignature(event) {
  const signingKey = process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
  if (!signingKey) {
    console.warn('CALENDLY_WEBHOOK_SIGNING_KEY not configured - skipping verification');
    return true; // Allow if not configured (backward compatible)
  }

  const signature = event.headers['calendly-webhook-signature'] || event.headers['Calendly-Webhook-Signature'];
  if (!signature) {
    console.warn('Missing Calendly signature header');
    return false;
  }

  try {
    const timestamp = signature.split(',').find(s => s.startsWith('t='))?.split('=')[1];
    const v1 = signature.split(',').find(s => s.startsWith('v1='))?.split('=')[1];

    if (!timestamp || !v1) return false;

    // Check timestamp is within 5 minutes
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp)) > 300) {
      console.warn('Calendly webhook timestamp too old');
      return false;
    }

    const signedPayload = `${timestamp}.${event.body}`;
    const expectedSignature = crypto
      .createHmac('sha256', signingKey)
      .update(signedPayload)
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(v1),
      Buffer.from(expectedSignature)
    );
  } catch (error) {
    console.error('Calendly signature validation error:', error.message);
    return false;
  }
}

/**
 * Rate limiting implementation
 * @param {string} key - Identifier (e.g., phone number)
 * @param {number} maxRequests - Max requests allowed
 * @param {number} windowMs - Time window in milliseconds
 * @returns {Object} - { allowed: boolean, remaining: number, resetAt: number }
 */
function checkRateLimit(key, maxRequests = 10, windowMs = 60000) {
  const now = Date.now();
  const record = rateLimitStore.get(key) || { count: 0, resetAt: now + windowMs };

  // Reset if window expired
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + windowMs;
  }

  record.count++;
  rateLimitStore.set(key, record);

  const allowed = record.count <= maxRequests;
  const remaining = Math.max(0, maxRequests - record.count);

  // Cleanup old entries (simple garbage collection)
  if (rateLimitStore.size > 10000) {
    const cutoff = now - windowMs * 2;
    for (const [k, v] of rateLimitStore.entries()) {
      if (v.resetAt < cutoff) rateLimitStore.delete(k);
    }
  }

  return { allowed, remaining, resetAt: record.resetAt };
}

/**
 * Normalize phone number for rate limiting
 * @param {string} phone - Phone number
 * @returns {string} - Normalized phone
 */
function normalizePhoneForRateLimit(phone) {
  if (!phone) return '';
  return String(phone).replace(/[^\d]/g, '').replace(/^1/, '');
}

/**
 * Validate environment variables are present
 * @param {string[]} required - Required env var names
 * @throws {Error} - If any required vars are missing
 */
function validateEnvVars(required) {
  const missing = required.filter(name => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

/**
 * Check if request is from production environment
 * @returns {boolean}
 */
function isProduction() {
  return process.env.CONTEXT === 'production' || process.env.NODE_ENV === 'production';
}

/**
 * Sanitize error message for client response
 * @param {Error} error - Error object
 * @returns {string} - Safe error message
 */
function sanitizeError(error) {
  if (isProduction()) {
    return 'An error occurred. Please try again later.';
  }
  return error.message || 'Unknown error';
}

module.exports = {
  verifyTwilioSignature,
  verifyCalendlySignature,
  checkRateLimit,
  normalizePhoneForRateLimit,
  validateEnvVars,
  isProduction,
  sanitizeError
};
