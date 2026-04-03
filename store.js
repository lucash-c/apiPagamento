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
      JSON.stringify({ payments: {}, callbackEvents: {} }, null, 2),
      "utf8"
    );
  }
}

export async function createStore(filePath) {
  await ensureFile(filePath);

  let queue = Promise.resolve();

  async function readState() {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
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
  };
}
