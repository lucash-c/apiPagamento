import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { createApp } from "../app.js";
import { createStore } from "../store.js";

function makeResponse(status, data, isText = false) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (isText) return JSON.parse(data);
      return data;
    },
    async text() {
      return isText ? data : JSON.stringify(data);
    },
  };
}

async function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${addr.port}`,
      });
    });
  });
}

test("cria pagamento, persiste e mantém status após restart lógico", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pay-test-"));
  const dataFile = path.join(tempDir, "store.json");
  const sheetCsv = "lojaId,mercado_pago_access_token\nloja-a,token-a\nloja-b,token-b\n";

  const requests = [];
  const httpClient = async (url, options = {}) => {
    requests.push({ url, options });

    if (url === "https://sheet.local") return makeResponse(200, sheetCsv, true);

    if (url === "https://api.mercadopago.com/v1/payments" && options.method === "POST") {
      const body = JSON.parse(options.body);
      return makeResponse(201, {
        id: "mp-100",
        status: "pending",
        description: body.description,
        transaction_amount: body.transaction_amount,
        payment_method_id: body.payment_method_id,
        external_reference: body.external_reference,
        metadata: body.metadata,
        payer: body.payer,
        point_of_interaction: { transaction_data: { qr_code: "pix", ticket_url: "url" } },
      });
    }

    throw new Error(`URL inesperada: ${url}`);
  };

  const env = {
    SHEET_PROPRIETARIOS: "https://sheet.local",
    API_BASE_URL: "https://api.local",
    CALLBACK_SHARED_SECRET: "secret",
  };

  const store1 = await createStore(dataFile);
  const app1 = createApp({ db: store1, httpClient, env, logger: { error() {}, warn() {} } });
  const { server, baseUrl } = await startServer(app1);

  const createRes = await fetch(`${baseUrl}/pagar/loja-a`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ valor: 59.9, descricao: "Pedido A", correlation_id: "sess-1" }),
  });
  assert.equal(createRes.status, 200);

  const statusRes = await fetch(`${baseUrl}/status/mp-100`);
  const statusPayload = await statusRes.json();
  assert.equal(statusPayload.status, "pending");
  assert.equal(statusPayload.lojaId, "loja-a");

  await new Promise((resolve) => server.close(resolve));

  const store2 = await createStore(dataFile);
  const saved = await store2.getPaymentByPaymentId("mp-100");
  assert.equal(saved.status, "pending");
  assert.equal(saved.loja_id, "loja-a");
  assert.equal(saved.correlation_id, "sess-1");
  assert.ok(requests.some((r) => r.url === "https://sheet.local"));
});

test("webhook aprovado dispara callback autenticado e é idempotente", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pay-test-"));
  const dataFile = path.join(tempDir, "store.json");
  const sheetCsv = "lojaId,mercado_pago_access_token\nloja-a,token-a\nloja-b,token-b\n";

  let callbackHits = 0;
  const mpGetTokens = [];

  const httpClient = async (url, options = {}) => {
    if (url === "https://sheet.local") return makeResponse(200, sheetCsv, true);

    if (url === "https://api.mercadopago.com/v1/payments" && options.method === "POST") {
      const body = JSON.parse(options.body);
      return makeResponse(201, {
        id: "mp-200",
        status: "pending",
        description: body.description,
        transaction_amount: body.transaction_amount,
        payment_method_id: body.payment_method_id,
        external_reference: body.external_reference,
        metadata: body.metadata,
        payer: body.payer,
      });
    }

    if (url === "https://api.mercadopago.com/v1/payments/mp-200") {
      mpGetTokens.push(options.headers.Authorization);
      return makeResponse(200, {
        id: "mp-200",
        status: "approved",
        description: "Pedido A",
        transaction_amount: 59.9,
        payment_method_id: "pix",
        external_reference: "loja-a:sess-2",
        metadata: { loja_id: "loja-a", correlation_id: "sess-2" },
        point_of_interaction: { transaction_data: { transaction_id: "tx-abc" } },
      });
    }

    if (url === "https://backend.local/callback") {
      callbackHits += 1;
      assert.ok(options.headers["X-Callback-Signature"].startsWith("sha256="));
      assert.equal(options.headers["X-Idempotency-Key"], "payment.approved:mp-200");
      return makeResponse(200, { ok: true });
    }

    throw new Error(`URL inesperada: ${url}`);
  };

  const env = {
    SHEET_PROPRIETARIOS: "https://sheet.local",
    API_BASE_URL: "https://api.local",
    CALLBACK_SHARED_SECRET: "secret",
  };

  const store = await createStore(dataFile);
  const app = createApp({ db: store, httpClient, env, logger: { error() {}, warn() {} } });
  const { server, baseUrl } = await startServer(app);

  await fetch(`${baseUrl}/pagar/loja-a`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      valor: 59.9,
      descricao: "Pedido A",
      correlation_id: "sess-2",
      callback_url: "https://backend.local/callback",
    }),
  });

  const webhookBody = { action: "payment.updated", data: { id: "mp-200" } };
  await fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(webhookBody),
  });

  await fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(webhookBody),
  });

  const statusRes = await fetch(`${baseUrl}/status/mp-200`);
  const status = await statusRes.json();
  assert.equal(status.status, "approved");
  assert.equal(status.callback.status, "confirmed");
  assert.equal(callbackHits, 1);
  assert.deepEqual(mpGetTokens, ["Bearer token-a", "Bearer token-a"]);

  await new Promise((resolve) => server.close(resolve));
});

test("isolamento multiloja impede uso de token da loja errada", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pay-test-"));
  const dataFile = path.join(tempDir, "store.json");
  const sheetCsv = "lojaId,mercado_pago_access_token\nloja-a,token-a\nloja-b,token-b\n";

  const seenAuth = [];

  const httpClient = async (url, options = {}) => {
    if (url === "https://sheet.local") return makeResponse(200, sheetCsv, true);

    if (url === "https://api.mercadopago.com/v1/payments" && options.method === "POST") {
      const body = JSON.parse(options.body);
      return makeResponse(201, {
        id: body.metadata.loja_id === "loja-a" ? "mp-a" : "mp-b",
        status: "pending",
        description: body.description,
        transaction_amount: body.transaction_amount,
        payment_method_id: body.payment_method_id,
        external_reference: body.external_reference,
        metadata: body.metadata,
        payer: body.payer,
      });
    }

    if (url === "https://api.mercadopago.com/v1/payments/mp-b") {
      seenAuth.push(options.headers.Authorization);
      if (options.headers.Authorization !== "Bearer token-b") {
        return makeResponse(401, { error: "unauthorized" });
      }
      return makeResponse(200, {
        id: "mp-b",
        status: "approved",
        description: "Pedido B",
        transaction_amount: 10,
        payment_method_id: "pix",
        external_reference: "loja-b:sess-b",
        metadata: { loja_id: "loja-b", correlation_id: "sess-b" },
      });
    }

    if (url === "https://backend.local/callback-b") {
      return makeResponse(200, { ok: true });
    }

    throw new Error(`URL inesperada: ${url}`);
  };

  const env = {
    SHEET_PROPRIETARIOS: "https://sheet.local",
    API_BASE_URL: "https://api.local",
    CALLBACK_SHARED_SECRET: "secret",
  };

  const store = await createStore(dataFile);
  const app = createApp({ db: store, httpClient, env, logger: { error() {}, warn() {} } });
  const { server, baseUrl } = await startServer(app);

  await fetch(`${baseUrl}/pagar/loja-a`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ valor: 9, descricao: "Pedido A", correlation_id: "sess-a" }),
  });

  await fetch(`${baseUrl}/pagar/loja-b`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      valor: 10,
      descricao: "Pedido B",
      correlation_id: "sess-b",
      callback_url: "https://backend.local/callback-b",
    }),
  });

  const webhook = await fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { id: "mp-b" } }),
  });

  assert.equal(webhook.status, 200);
  assert.deepEqual(seenAuth, ["Bearer token-b"]);

  await new Promise((resolve) => server.close(resolve));
});

test("rota nova de intent PIX prioriza token do payload e retorna contrato esperado", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pay-test-"));
  const dataFile = path.join(tempDir, "store.json");
  const sheetCsv = "lojaId,mercado_pago_access_token\nloja-a,token-da-planilha\n";

  const seenAuth = [];
  const httpClient = async (url, options = {}) => {
    if (url === "https://sheet.local") return makeResponse(200, sheetCsv, true);
    if (url === "https://api.mercadopago.com/v1/payments" && options.method === "POST") {
      seenAuth.push(options.headers.Authorization);
      const body = JSON.parse(options.body);
      return makeResponse(201, {
        id: "mp-300",
        status: "pending",
        transaction_amount: body.transaction_amount,
        payment_method_id: body.payment_method_id,
        external_reference: body.external_reference,
        metadata: body.metadata,
        point_of_interaction: {
          transaction_data: {
            qr_code_base64: "base64-qr",
            qr_code: "000201...",
            transaction_id: "tx-300",
          },
        },
      });
    }
    throw new Error(`URL inesperada: ${url}`);
  };

  const env = {
    SHEET_PROPRIETARIOS: "https://sheet.local",
    API_BASE_URL: "https://api.local",
    CALLBACK_SHARED_SECRET: "secret",
  };

  const store = await createStore(dataFile);
  const app = createApp({ db: store, httpClient, env, logger: { error() {}, warn() {} } });
  const { server, baseUrl } = await startServer(app);

  const response = await fetch(`${baseUrl}/api/payments/pix/intents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      loja_id: "loja-a",
      public_key: "pub-key",
      correlation_id: "corr-300",
      amount: 50,
      payment_method: "pix",
      order_payload: { cart_id: "C1" },
      mercado_pago_access_token: "token-do-payload",
    }),
  });

  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.payment_id, "mp-300");
  assert.equal(payload.correlation_id, "corr-300");
  assert.equal(payload.pix.qr_code_base64, "base64-qr");
  assert.equal(payload.pix.qr_code_text, "000201...");
  assert.equal(payload.pix.txid, "tx-300");
  assert.deepEqual(seenAuth, ["Bearer token-do-payload"]);

  await new Promise((resolve) => server.close(resolve));
});

test("rota nova de status valida isolamento por loja e correlation_id sem quebrar legado", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pay-test-"));
  const dataFile = path.join(tempDir, "store.json");
  const sheetCsv = "lojaId,mercado_pago_access_token\nloja-a,token-a\n";

  const httpClient = async (url, options = {}) => {
    if (url === "https://sheet.local") return makeResponse(200, sheetCsv, true);
    if (url === "https://api.mercadopago.com/v1/payments" && options.method === "POST") {
      const body = JSON.parse(options.body);
      return makeResponse(201, {
        id: "mp-400",
        status: "pending",
        transaction_amount: body.transaction_amount,
        payment_method_id: body.payment_method_id,
        external_reference: body.external_reference,
        metadata: body.metadata,
      });
    }
    throw new Error(`URL inesperada: ${url}`);
  };

  const env = {
    SHEET_PROPRIETARIOS: "https://sheet.local",
    API_BASE_URL: "https://api.local",
    CALLBACK_SHARED_SECRET: "secret",
  };

  const store = await createStore(dataFile);
  const app = createApp({ db: store, httpClient, env, logger: { error() {}, warn() {} } });
  const { server, baseUrl } = await startServer(app);

  await fetch(`${baseUrl}/pagar/loja-a`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ valor: 25, descricao: "Pedido legado", correlation_id: "corr-400" }),
  });

  const okStatusRes = await fetch(
    `${baseUrl}/api/payments/mp-400?loja_id=loja-a&correlation_id=corr-400`
  );
  assert.equal(okStatusRes.status, 200);
  const okPayload = await okStatusRes.json();
  assert.equal(okPayload.payment_id, "mp-400");
  assert.equal(okPayload.status, "pending");
  assert.equal(okPayload.loja_id, "loja-a");
  assert.equal(okPayload.correlation_id, "corr-400");

  const wrongLojaRes = await fetch(
    `${baseUrl}/api/payments/mp-400?loja_id=loja-b&correlation_id=corr-400`
  );
  assert.equal(wrongLojaRes.status, 404);

  const wrongCorrelationRes = await fetch(
    `${baseUrl}/api/payments/mp-400?loja_id=loja-a&correlation_id=outro`
  );
  assert.equal(wrongCorrelationRes.status, 404);

  const legacyStatusRes = await fetch(`${baseUrl}/status/mp-400`);
  assert.equal(legacyStatusRes.status, 200);
  const legacyPayload = await legacyStatusRes.json();
  assert.equal(legacyPayload.paymentId, "mp-400");

  await new Promise((resolve) => server.close(resolve));
});
