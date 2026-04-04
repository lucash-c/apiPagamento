import fs from "fs/promises";
import path from "path";

function nowIso() {
  return new Date().toISOString();
}

async function ensureFile(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(
      filePath,
      JSON.stringify({ payments: {}, callbackEvents: {}, refunds: {} }, null, 2),
      "utf8"
    );
  }
}

export async function createStore(filePath) {
  await ensureFile(filePath);

  let queue = Promise.resolve();

  async function readState() {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.payments) parsed.payments = {};
    if (!parsed.callbackEvents) parsed.callbackEvents = {};
    if (!parsed.refunds) parsed.refunds = {};
    return parsed;
  }

  async function writeState(state) {
    await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
  }

  async function inTx(fn) {
    const run = queue.then(async () => {
      const state = await readState();
      const result = await fn(state);
      await writeState(state);
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }

  function enrichPayment(payment, state) {
    const event = state.callbackEvents[`payment.approved:${payment.payment_id}`] || null;
    return {
      ...payment,
      callback_status: event?.status || null,
      callback_attempts: event?.attempts || 0,
    };
  }

  return {
    async upsertPayment(paymentInput) {
      return inTx(async (state) => {
        const existing = state.payments[paymentInput.payment_id] || null;
        const merged = {
          created_at: existing?.created_at || nowIso(),
          updated_at: nowIso(),
          ...existing,
          ...paymentInput,
          correlation_id: paymentInput.correlation_id ?? existing?.correlation_id ?? null,
          external_reference:
            paymentInput.external_reference ?? existing?.external_reference ?? null,
          txid: paymentInput.txid ?? existing?.txid ?? null,
          callback_url: paymentInput.callback_url ?? existing?.callback_url ?? null,
          payer_email: paymentInput.payer_email ?? existing?.payer_email ?? null,
        };

        state.payments[paymentInput.payment_id] = merged;
        return enrichPayment(merged, state);
      });
    },

    async getPaymentByPaymentId(paymentId) {
      return inTx(async (state) => {
        const payment = state.payments[paymentId] || null;
        return payment ? enrichPayment(payment, state) : null;
      });
    },

    async createOrGetCallbackEvent({ event_key, payment_id, loja_id, callback_url }) {
      return inTx(async (state) => {
        if (!state.callbackEvents[event_key]) {
          state.callbackEvents[event_key] = {
            event_key,
            payment_id,
            loja_id,
            callback_url: callback_url || null,
            status: "pending",
            attempts: 0,
            last_error: null,
            response_status: null,
            response_body: null,
            created_at: nowIso(),
            updated_at: nowIso(),
            confirmed_at: null,
          };
        }
        return state.callbackEvents[event_key];
      });
    },

    async markCallbackSending(eventKey) {
      return inTx(async (state) => {
        const event = state.callbackEvents[eventKey];
        if (!event) return;
        event.status = "sent";
        event.attempts += 1;
        event.last_attempt_at = nowIso();
        event.updated_at = nowIso();
      });
    },

    async markCallbackConfirmed(eventKey, responseStatus, responseBody) {
      return inTx(async (state) => {
        const event = state.callbackEvents[eventKey];
        if (!event) return;
        event.status = "confirmed";
        event.response_status = responseStatus;
        event.response_body = responseBody;
        event.confirmed_at = nowIso();
        event.updated_at = nowIso();
      });
    },

    async markCallbackFailed(eventKey, error, responseStatus = null, responseBody = null) {
      return inTx(async (state) => {
        const event = state.callbackEvents[eventKey];
        if (!event) return;
        event.status = "failed";
        event.last_error = error;
        event.response_status = responseStatus;
        event.response_body = responseBody;
        event.updated_at = nowIso();
      });
    },

    async markCallbackNotRequired(eventKey) {
      return inTx(async (state) => {
        const event = state.callbackEvents[eventKey];
        if (!event) return;
        event.status = "not_required";
        event.updated_at = nowIso();
      });
    },

    async createRefundAttempt(refundInput) {
      return inTx(async (state) => {
        const id = refundInput.id || `refund_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        const record = {
          id,
          payment_id: String(refundInput.payment_id),
          loja_id: String(refundInput.loja_id),
          correlation_id: refundInput.correlation_id || null,
          status: refundInput.status || "pending",
          refunded_amount: refundInput.refunded_amount ?? null,
          reason: refundInput.reason || null,
          metadata: refundInput.metadata || null,
          provider_refund_id: refundInput.provider_refund_id || null,
          provider_status: refundInput.provider_status || null,
          provider_payload: refundInput.provider_payload || null,
          idempotency_key: refundInput.idempotency_key,
          requested_at: refundInput.requested_at || nowIso(),
          provider_requested_at: refundInput.provider_requested_at || null,
          finished_at: refundInput.finished_at || null,
          created_at: nowIso(),
          updated_at: nowIso(),
        };

        state.refunds[id] = record;
        return record;
      });
    },

    async updateRefund(refundId, updates) {
      return inTx(async (state) => {
        const current = state.refunds[refundId];
        if (!current) return null;
        const merged = {
          ...current,
          ...updates,
          updated_at: nowIso(),
        };
        state.refunds[refundId] = merged;
        return merged;
      });
    },

    async getRefundByIdempotencyKey(idempotencyKey) {
      return inTx(async (state) => {
        const found = Object.values(state.refunds).find(
          (refund) => refund.idempotency_key === idempotencyKey
        );
        return found || null;
      });
    },

    async listRefundsByPaymentId(paymentId) {
      return inTx(async (state) =>
        Object.values(state.refunds)
          .filter((refund) => refund.payment_id === String(paymentId))
          .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      );
    },
  };
}
