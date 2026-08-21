import { classifyMoneyState } from '../core/classify.js';
import { decideRecovery } from '../core/recovery.js';
import { buildCustomerMessage } from '../core/message.js';

// Reconstructs the customer message from a stored `failures` row — the SAME
// classify/recovery/message pipeline the webhook handler runs live, run again
// at read time. One code path for both a real webhook failure and a demo one
// (POST /api/simulate-failure just writes a row through the same saveFailure).
export function messageFromFailureRow(row) {
  const entity = {
    error_reason: row.reason,
    error_step: row.error_step,
    acquirer_data: JSON.parse(row.acquirer_data_json || '{}'),
    amount: row.amount_paise,
    method: null,
  };
  const classification = classifyMoneyState(entity);
  const recovery = decideRecovery(entity.error_reason, { originalMethod: entity.method });
  const message = buildCustomerMessage({
    classification,
    recovery,
    amountPaise: row.amount_paise ?? 0,
    eventDate: new Date(row.created_at),
  });
  return {
    id: row.payment_id,
    orderId: row.order_id,
    source: row.source,
    createdAt: row.created_at,
    ...message,
  };
}
