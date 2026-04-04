import crypto from "crypto";

function nowIso() {
  return new Date().toISOString();
}

function stableStringify(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function buildRefundIdempotencyKey({ paymentId, lojaId, correlationId, reason, metadata }) {
  const raw = [
    String(paymentId || "").trim(),
    String(lojaId || "").trim(),
    String(correlationId || "").trim(),
    String(reason || "").trim(),
    stableStringify(metadata || {}),
  ].join("|");
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function mapProviderStatusToLocal(providerStatus) {
  const normalized = String(providerStatus || "").toLowerCase();
  if (normalized === "approved" || normalized === "refunded") return "refunded";
  if (normalized === "in_process" || normalized === "pending") return "in_process";
  if (normalized === "rejected") return "rejected";
  return "failed";
}

function sanitizeReason(reason) {
  return String(reason || "").trim();
}

export function createRefundService({
  db,
  httpClient,
  getAccessTokenByLoja,
  logger = console,
}) {
  if (!db) throw new Error("db is required");
  if (!httpClient) throw new Error("httpClient is required");
  if (!getAccessTokenByLoja) throw new Error("getAccessTokenByLoja is required");

  async function requestRefund({
    paymentId,
    lojaId,
    correlationId = null,
    reason,
    metadata = null,
  }) {
    const normalizedPaymentId = String(paymentId || "").trim();
    const normalizedLojaId = String(lojaId || "").trim();
    const normalizedCorrelationId = String(correlationId || "").trim();
    const normalizedReason = sanitizeReason(reason);

    if (!normalizedLojaId) return { status: 400, body: { error: "loja_id é obrigatório" } };
    if (!normalizedReason) return { status: 400, body: { error: "reason é obrigatório" } };

    const payment = await db.getPaymentByPaymentId(normalizedPaymentId);
    if (!payment) return { status: 404, body: { error: "Pagamento não encontrado" } };

    if (payment.loja_id !== normalizedLojaId) {
      return { status: 404, body: { error: "Pagamento não encontrado para loja informada" } };
    }

    if (normalizedCorrelationId && payment.correlation_id !== normalizedCorrelationId) {
      return {
        status: 409,
        body: { error: "correlation_id divergente para o pagamento informado" },
      };
    }

    const idempotencyKey = buildRefundIdempotencyKey({
      paymentId: normalizedPaymentId,
      lojaId: normalizedLojaId,
      correlationId: normalizedCorrelationId || payment.correlation_id || "",
      reason: normalizedReason,
      metadata: metadata || {},
    });

    const existingByKey = await db.getRefundByIdempotencyKey(idempotencyKey);
    if (existingByKey) {
      return {
        status: existingByKey.status === "in_process" ? 202 : 200,
        body: {
          idempotent: true,
          refund: existingByKey,
        },
      };
    }

    const refundsByPayment = await db.listRefundsByPaymentId(normalizedPaymentId);
    const alreadyRefunded = refundsByPayment.find((item) => item.status === "refunded");
    if (alreadyRefunded || payment.status === "refunded") {
      return {
        status: 200,
        body: {
          idempotent: true,
          refund: alreadyRefunded || null,
          message: "Pagamento já reembolsado",
        },
      };
    }

    const inProgress = refundsByPayment.find(
      (item) => item.status === "pending" || item.status === "in_process"
    );
    if (inProgress) {
      return {
        status: 202,
        body: {
          idempotent: true,
          refund: inProgress,
          message: "Refund já em andamento",
        },
      };
    }

    if (payment.status !== "approved") {
      return { status: 409, body: { error: "Pagamento não está elegível para refund" } };
    }

    const accessToken = await getAccessTokenByLoja(normalizedLojaId);
    if (!accessToken) {
      return { status: 500, body: { error: "Token não encontrado para loja informada" } };
    }

    const refund = await db.createRefundAttempt({
      payment_id: normalizedPaymentId,
      loja_id: normalizedLojaId,
      correlation_id: normalizedCorrelationId || payment.correlation_id || null,
      reason: normalizedReason,
      metadata: metadata || null,
      idempotency_key: idempotencyKey,
      status: "pending",
      requested_at: nowIso(),
    });

    await db.updateRefund(refund.id, { status: "in_process", provider_requested_at: nowIso() });

    try {
      const mpRes = await httpClient(
        `https://api.mercadopago.com/v1/payments/${normalizedPaymentId}/refunds`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "X-Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({}),
        }
      );

      const raw = await mpRes.text();
      const providerPayload = raw ? JSON.parse(raw) : {};
      if (!mpRes.ok) {
        await db.updateRefund(refund.id, {
          status: "failed",
          provider_payload: providerPayload,
          provider_status: providerPayload?.status || null,
          provider_refund_id: providerPayload?.id ? String(providerPayload.id) : null,
          updated_at: nowIso(),
          finished_at: nowIso(),
        });
        return {
          status: 502,
          body: {
            error: "Falha ao solicitar refund no provedor",
            refund_id: refund.id,
          },
        };
      }

      const localStatus = mapProviderStatusToLocal(providerPayload?.status);
      const updatedRefund = await db.updateRefund(refund.id, {
        status: localStatus,
        provider_payload: providerPayload,
        provider_status: providerPayload?.status || null,
        provider_refund_id: providerPayload?.id ? String(providerPayload.id) : null,
        refunded_amount:
          providerPayload?.amount !== undefined && providerPayload?.amount !== null
            ? Number(providerPayload.amount)
            : null,
        updated_at: nowIso(),
        finished_at: localStatus === "in_process" ? null : nowIso(),
      });

      if (localStatus === "refunded") {
        await db.upsertPayment({
          payment_id: normalizedPaymentId,
          loja_id: normalizedLojaId,
          status: "refunded",
        });
      }

      return {
        status: localStatus === "in_process" ? 202 : 200,
        body: {
          ok: true,
          refund: updatedRefund,
        },
      };
    } catch (error) {
      logger.error("Erro ao processar refund:", error.message);
      await db.updateRefund(refund.id, {
        status: "failed",
        provider_payload: { error: error.message },
        updated_at: nowIso(),
        finished_at: nowIso(),
      });
      return {
        status: 502,
        body: { error: "Falha inesperada ao solicitar refund", refund_id: refund.id },
      };
    }
  }

  return { requestRefund, buildRefundIdempotencyKey };
}
