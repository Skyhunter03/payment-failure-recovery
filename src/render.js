// Renders a customer message as plain text for the console. This IS the
// delivery mechanism: nothing is emailed, SMSed, or pushed. There is no way to
// accidentally contact a real person.

const STEP_MARK = {
  done: '[x]',
  active: '[~]',
  pending: '[ ]',
  unknown: '[?]',
  skipped: '[-]',
};

export function renderMessage(message) {
  const lines = [];
  lines.push('──────────────────────────────────────────────');
  lines.push(`  ${message.headline}`);
  lines.push('──────────────────────────────────────────────');
  lines.push(`1. Did my money leave?      ${message.questions.didMyMoneyLeave}`);
  lines.push(`2. Is it coming back?       ${message.questions.isItComingBack}`);
  lines.push(`3. Pay again right now?      ${message.questions.shouldIPayAgainNow}`);
  lines.push(`4. Still get what I wanted?  ${message.questions.howDoIStillGetWhatIWanted}`);
  lines.push('');
  lines.push('  Where your money is:');
  for (const step of message.tracker) {
    const mark = STEP_MARK[step.status] || '[?]';
    lines.push(`    ${mark} ${step.label} — ${step.note}`);
  }
  lines.push('──────────────────────────────────────────────');
  return lines.join('\n');
}

// Build a deliver() bound to a logger. Logs a structured line AND prints the
// human-readable card to stdout.
export function makeConsoleDeliver(logger) {
  return function deliver({ paymentId, orderId, message }) {
    logger.info('message_delivered', {
      paymentId,
      orderId,
      channel: 'console-only',
      state: message.state,
    });
    process.stdout.write('\n' + renderMessage(message) + '\n\n');
  };
}
