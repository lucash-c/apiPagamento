import express from "express";
import crypto from "crypto";
import Papa from "papaparse";
import cors from "cors";

const PIX_EXPIRATION_MINUTES = 15;

function normalizeLojaId(lojaId = "") {
  return String(lojaId).trim();
}

function buildPixExpirationTimestamp(baseDate = new Date()) {
  const expiresAt = new Date(baseDate.getTime() + PIX_EXPIRATION_MINUTES * 60 * 1000);
  return expiresAt.toISOString();
}

function buildHmacSignature(secret, timestamp, payloadString) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${payloadString}`)
    .digest("hex");
}

export function createApp({ db, httpClient, env = process.env, logger = console }) {
  if (!db) throw new Error("db is required");
  if (!httpClient) throw new Error("httpClient is required");

  const app = express();
  app.use(cors());
  app.use(express.json());

  const SHEET_URL = env.SHEET_PROPRIETARIOS;

  async function getTokensFromSheet() {
    if (!SHEET_URL) throw new Error("SHEET_PROPRIETARIOS não configurado");

    const res = await httpClient(SHEET_URL);
    if (!res.ok) throw new Error("Erro ao buscar planilha de proprietários");

    const csv = await res.text();
    const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });

    const tokens = {};
    parsed.data.forEach((row) => {
      if (row.lojaId && row.mercado_pago_access_token) {
        tokens[normalizeLojaId(row.lojaId)] = row.mercado_pago_access_token.trim();
      }
    });
    return tokens;
  }

  async function getTokenByLoja(lojaId) {
    const tokens = await getTokensFromSheet();
    return tokens[normalizeLojaId(lojaId)] || null;
  }

  async function resolveAccessToken({ lojaId, explicitAccessToken = null }) {
    if (explicitAccessToken) return String(explicitAccessToken).trim();
    return getTokenByLoja(lojaId);
  }

  async function fetchMercadoPagoPayment(paymentId, accessToken) {
    const resp = await httpClient(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Erro ao consultar pagamento no Mercado Pago: ${resp.status} ${body}`);
    }
    return resp.json();
  }

  async function registerOrUpdatePaymentFromProvider({
    lojaId,
    payment,
    fallback = {},
  }) {
    const record = {
      payment_id: String(payment.id),
      loja_id: normalizeLojaId(lojaId || payment.metadata?.loja_id || fallback.loja_id),
      amount: Number(payment.transaction_amount ?? fallback.amount ?? 0),
      description: payment.description || fallback.description || "",
      status: payment.status || fallback.status || "pending",
      metodo: payment.payment_method_id || fallback.metodo || "pix",
      correlation_id:
        payment.metadata?.correlation_id || fallback.correlation_id || null,
      external_reference:
        payment.external_reference || fallback.external_reference || null,
      txid:
        payment.point_of_interaction?.transaction_data?.transaction_id ||
        fallback.txid ||
        null,
      callback_url:
        fallback.callback_url || payment.metadata?.callback_url || null,
      payer_email: payment.payer?.email || fallback.payer_email || null,
      expires_at: payment.date_of_expiration || fallback.expires_at || null,
      provider_payload: JSON.stringify(payment),
    };

    if (!record.loja_id) {
      throw new Error("Não foi possível determinar loja_id do pagamento");
    }

    return db.upsertPayment(record);
  }

  async function sendApprovedCallback(payment, eventRecord) {
    if (!payment.callback_url) {
      await db.markCallbackNotRequired(eventRecord.event_key);
      return { skipped: true, reason: "callback_url ausente" };
    }

    const callbackSecret = env.CALLBACK_SHARED_SECRET;
    if (!callbackSecret) {
      throw new Error("CALLBACK_SHARED_SECRET não configurado");
    }

    const payload = {
      event: "payment.approved",
      payment_id: payment.payment_id,
      loja_id: payment.loja_id,
      status: payment.status,
      amount: payment.amount,
      correlation_id: payment.correlation_id,
      txid: payment.txid,
      external_reference: payment.external_reference,
    };

    const payloadString = JSON.stringify(payload);
    const timestamp = new Date().toISOString();
    const signature = buildHmacSignature(callbackSecret, timestamp, payloadString);

    await db.markCallbackSending(eventRecord.event_key);

    const response = await httpClient(payment.callback_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Callback-Timestamp": timestamp,
        "X-Callback-Signature": `sha256=${signature}`,
        "X-Callback-Event": payload.event,
        "X-Idempotency-Key": eventRecord.event_key,
      },
      body: payloadString,
    });

    const responseBody = await response.text();

    if (response.ok) {
      await db.markCallbackConfirmed(eventRecord.event_key, response.status, responseBody);
      return { confirmed: true };
    }

    await db.markCallbackFailed(
      eventRecord.event_key,
      `Callback HTTP ${response.status}: ${responseBody}`,
      response.status,
      responseBody
    );
    return { confirmed: false };
  }

  async function ensureApprovedCallback(payment) {
    const eventKey = `payment.approved:${payment.payment_id}`;
    const eventRecord = await db.createOrGetCallbackEvent({
      event_key: eventKey,
      payment_id: payment.payment_id,
      loja_id: payment.loja_id,
      callback_url: payment.callback_url,
    });

    if (eventRecord.status === "confirmed" || eventRecord.status === "not_required") {
      return { idempotentSkip: true, status: eventRecord.status };
    }

    return sendApprovedCallback(payment, eventRecord);
  }

  async function createPixPayment({
    lojaId,
    amount,
    description,
    paymentMethod = "pix",
    payer,
    correlationId,
    callbackUrl = null,
    orderPayload = null,
    explicitAccessToken = null,
    requireExplicitAccessToken = false,
  }) {
    const providedAccessToken = String(explicitAccessToken || "").trim();
    if (requireExplicitAccessToken && !providedAccessToken) {
      return {
        ok: false,
        status: 400,
        body: {
          error:
            "mercado_pago_access_token é obrigatório e deve ser enviado no payload desta rota",
        },
      };
    }

    const accessToken = requireExplicitAccessToken
      ? providedAccessToken
      : await resolveAccessToken({
          lojaId,
          explicitAccessToken: providedAccessToken || null,
        });

    if (!accessToken) {
      return {
        ok: false,
        status: 400,
        body: { error: "Loja não encontrada ou sem token do Mercado Pago" },
      };
    }

    const safeCorrelationId = correlationId || crypto.randomUUID();
    const externalReference = `${lojaId}:${safeCorrelationId}`;
    const pixExpiresAt = buildPixExpirationTimestamp();

    const payload = {
      transaction_amount: Number(amount),
      description: description || `Pedido da ${lojaId}`,
      payment_method_id: paymentMethod,
      payer: payer || { email: "cliente@teste.com" },
      notification_url: `${env.API_BASE_URL}/webhook`,
      external_reference: externalReference,
      date_of_expiration: pixExpiresAt,
      metadata: {
        loja_id: lojaId,
        correlation_id: safeCorrelationId,
        callback_url: callbackUrl,
        order_payload: orderPayload,
      },
    };

    const mpRes = await httpClient("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await mpRes.json();
    if (!mpRes.ok || !data?.id) {
      return {
        ok: false,
        status: mpRes.status || 500,
        body: {
          error: "Erro ao criar pagamento no Mercado Pago",
          details: data,
        },
      };
    }

    const stored = await registerOrUpdatePaymentFromProvider({
      lojaId,
      payment: data,
      fallback: {
        amount: Number(amount),
        description: description || `Pedido da ${lojaId}`,
        metodo: paymentMethod,
        correlation_id: safeCorrelationId,
        external_reference: externalReference,
        callback_url: callbackUrl,
        payer_email: payer?.email || "cliente@teste.com",
        expires_at: data.date_of_expiration || pixExpiresAt,
      },
    });

    return { ok: true, status: 200, body: data, stored };
  }

  // Criar pagamento PIX
  app.post("/pagar/:lojaId", async (req, res) => {
    try {
      const lojaId = normalizeLojaId(req.params.lojaId);
      const {
        descricao,
        valor,
        metodo = "pix",
        payer,
        correlation_id,
        callback_url,
      } = req.body;

      const created = await createPixPayment({
        lojaId,
        amount: valor,
        description: descricao,
        paymentMethod: metodo,
        payer,
        correlationId: correlation_id,
        callbackUrl: callback_url || null,
      });

      if (!created.ok) return res.status(created.status).json(created.body);
      return res.json({ paymentId: created.body.id, ...created.body });
    } catch (error) {
      logger.error("Erro no pagamento:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/payments/pix/intents", async (req, res) => {
    try {
      const {
        loja_id,
        public_key,
        correlation_id,
        amount,
        payment_method = "pix",
        order_payload,
        mercado_pago_access_token,
      } = req.body || {};

      const lojaId = normalizeLojaId(loja_id);
      if (!lojaId) return res.status(400).json({ error: "loja_id é obrigatório" });
      if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
        return res.status(400).json({ error: "amount inválido" });
      }

      const created = await createPixPayment({
        lojaId,
        amount,
        description: order_payload?.description || `Pedido da ${lojaId}`,
        paymentMethod: payment_method,
        payer: order_payload?.payer || { email: "cliente@teste.com" },
        correlationId: correlation_id,
        callbackUrl: order_payload?.callback_url || null,
        orderPayload: {
          ...order_payload,
          public_key,
        },
        explicitAccessToken: mercado_pago_access_token,
        requireExplicitAccessToken: true,
      });

      if (!created.ok) return res.status(created.status).json(created.body);

      const paymentData = created.body;
      const txData = paymentData.point_of_interaction?.transaction_data || {};
      return res.status(201).json({
        payment_id: String(paymentData.id),
        id: String(paymentData.id),
        correlation_id: created.stored?.correlation_id || correlation_id || null,
        pix: {
          qr_code_base64: txData.qr_code_base64 || null,
          qr_code_text: txData.qr_code || null,
          txid: txData.transaction_id || null,
          expires_at: created.stored?.expires_at || paymentData.date_of_expiration || null,
        },
      });
    } catch (error) {
      logger.error("Erro ao criar intent PIX:", error.message);
      return res.status(500).json({ error: error.message });
    }
  });

  // Webhook
  app.post("/webhook", async (req, res) => {
    try {
      const paymentId =
        req.body?.data?.id || req.body?.id || req.query["data.id"] || req.query.id;

      if (!paymentId) {
        return res.sendStatus(200);
      }

      const stored = await db.getPaymentByPaymentId(String(paymentId));
      if (!stored) {
        logger.warn(`Webhook ignorado: pagamento ${paymentId} não encontrado localmente`);
        return res.sendStatus(200);
      }

      const accessToken = await getTokenByLoja(stored.loja_id);
      if (!accessToken) {
        throw new Error(`Token não encontrado para loja ${stored.loja_id}`);
      }

      const paymentFromProvider = await fetchMercadoPagoPayment(paymentId, accessToken);

      const updated = await registerOrUpdatePaymentFromProvider({
        lojaId: stored.loja_id,
        payment: paymentFromProvider,
        fallback: {
          callback_url: stored.callback_url,
          correlation_id: stored.correlation_id,
          external_reference: stored.external_reference,
        },
      });

      if (updated.status === "approved") {
        await ensureApprovedCallback(updated);
      }

      return res.sendStatus(200);
    } catch (err) {
      logger.error("Erro no webhook:", err.message);
      return res.sendStatus(500);
    }
  });

  // Retentativa manual segura de callback
  app.post("/callbacks/retry/:paymentId", async (req, res) => {
    try {
      const paymentId = String(req.params.paymentId);
      const payment = await db.getPaymentByPaymentId(paymentId);
      if (!payment) return res.status(404).json({ error: "Pagamento não encontrado" });
      if (payment.status !== "approved") {
        return res.status(409).json({ error: "Pagamento ainda não aprovado" });
      }

      const result = await ensureApprovedCallback(payment);
      return res.json({ ok: true, result });
    } catch (error) {
      logger.error("Erro ao reenviar callback:", error.message);
      return res.status(500).json({ error: error.message });
    }
  });

  app.get("/status/:id", async (req, res) => {
    const id = String(req.params.id);
    const payment = await db.getPaymentByPaymentId(id);
    if (!payment) {
      return res.json({ paymentId: id, status: "pending" });
    }

    return res.json({
      paymentId: payment.payment_id,
      status: payment.status,
      lojaId: payment.loja_id,
      correlation_id: payment.correlation_id,
      callback: {
        status: payment.callback_status,
        attempts: payment.callback_attempts,
      },
    });
  });

  app.get("/api/payments/:paymentId", async (req, res) => {
    const paymentId = String(req.params.paymentId);
    const lojaId = normalizeLojaId(req.query.loja_id || "");
    const correlationId = String(req.query.correlation_id || "").trim();

    const payment = await db.getPaymentByPaymentId(paymentId);
    if (!payment) {
      return res.status(404).json({ error: "Pagamento não encontrado" });
    }

    if (lojaId && payment.loja_id !== lojaId) {
      return res.status(404).json({ error: "Pagamento não encontrado para loja informada" });
    }

    if (correlationId && payment.correlation_id !== correlationId) {
      return res.status(404).json({ error: "Pagamento não encontrado para correlation_id informado" });
    }

    return res.json({
      payment_id: payment.payment_id,
      id: payment.payment_id,
      status: payment.status,
      loja_id: payment.loja_id,
      store_id: payment.loja_id,
      correlation_id: payment.correlation_id,
    });
  });

  return app;
}
