// Structured JSON logs, one object per line, request id carried on every line.
// Delivery of customer messages is ALSO just a log here — nothing is ever sent.

function emit(level, requestId, msg, fields) {
  const line = {
    ts: new Date().toISOString(),
    level,
    requestId: requestId ?? null,
    msg,
    ...fields,
  };
  // One line, one JSON object. stdout for info/debug, stderr for warn/error.
  const text = JSON.stringify(line);
  if (level === 'error' || level === 'warn') process.stderr.write(text + '\n');
  else process.stdout.write(text + '\n');
}

// A logger bound to a single request id, so callers can't forget to pass it.
export function makeLogger(requestId) {
  return {
    requestId,
    debug: (msg, fields = {}) => emit('debug', requestId, msg, fields),
    info: (msg, fields = {}) => emit('info', requestId, msg, fields),
    warn: (msg, fields = {}) => emit('warn', requestId, msg, fields),
    error: (msg, fields = {}) => emit('error', requestId, msg, fields),
  };
}

// For process-level lines that have no request context.
export const rootLog = makeLogger(null);
