const Sentry = require("@sentry/node");

// DSN comes only from the environment (SSM in prod, .env locally). No hardcoded
// fallback — leaving SENTRY_DSN unset simply disables error reporting rather than
// shipping a credential in source.
const dsn = process.env.SENTRY_DSN || undefined;

Sentry.init({
  dsn,
  enableLogs: true,

  // HIPAA: never send personally identifiable / protected health information.
  // sendDefaultPii=false keeps IP addresses, cookies, and user data out of events.
  sendDefaultPii: false,

  // Defense in depth: strip request bodies, query strings, headers and any other
  // free-text that could contain PHI (patient names, clinical notes, audio, etc.)
  // before the event ever leaves the server.
  beforeSend(event) {
    if (event.request) {
      delete event.request.data;        // request body (notes, patient info, etc.)
      delete event.request.cookies;
      delete event.request.query_string;
      if (event.request.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.cookie;
      }
      // Keep only the path, drop any query params that might carry identifiers.
      if (typeof event.request.url === "string") {
        event.request.url = event.request.url.split("?")[0];
      }
    }
    // Remove user identity details entirely.
    if (event.user) delete event.user;
    return event;
  },
});

module.exports = Sentry;
