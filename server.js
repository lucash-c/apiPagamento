import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import Papa from "papaparse";
import cors from "cors";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const SHEET_URL = process.env.SHEET_PROPRIETARIOS;

// 🔹 Armazena status dos pagamentos recebidos via webhook
const pagamentos = {}; // { pagamentoId: { status, lojaId, valor, descricao } }

// 🔹 Lê a planilha e retorna um mapa { lojaId: access_token }
async function getTokensFromSheet() {
  const res = await fetch(SHEET_URL);
  if (!res.ok) throw new Error("Erro ao buscar planilha de proprietários");

  const csv = await res.text();
  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });

  const tokens = {};
  parsed.data.forEach((row) => {
    if (row.lojaId && row.mercado_pago_access_token) {
      tokens[row.lojaId.trim()] = row.mercado_pago_access_token.trim();
    }
  });
  return tokens;
}

// 🔹 Endpoint de pagamento PIX
app.post("/pagar/:lojaId", async (req, res) => {
  try {
    const { lojaId } = req.params;
    const { descricao, valor, metodo = "pix", payer } = req.body;

    const tokens = await getTokensFromSheet();
    const ACCESS_TOKEN = tokens[lojaId];

    if (!ACCESS_TOKEN) {
      return res
        .status(400)
        .json({ error: "Loja não encontrada ou sem token do Mercado Pago" });
    }

    const payload = {
      transaction_amount: Number(valor),
      description: descricao || `Pedido da ${lojaId}`,
      payment_method_id: metodo, // Ex: 'pix'
      payer: payer || { email: "cliente@teste.com" },
      notification_url: `${process.env.API_BASE_URL}/webhook`, // 🔹 URL pública da sua VPS
    };

    const mpRes = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await mpRes.json();

    // 🔹 Guarda o status inicial na memória
    if (data.id) {
      pagamentos[data.id] = {
        status: data.status || "pending",
        lojaId,
        valor,
        descricao,
      };
    }

    res.json(data);
  } catch (error) {
    console.error("Erro no pagamento:", error);
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Webhook do Mercado Pago (avisos automáticos de pagamento)
app.post("/webhook", async (req, res) => {
  try {
    const evento = req.body;

    // Mercado Pago envia { action: "payment.updated", data: { id: "<payment_id>" } }
    if (evento?.data?.id) {
      const pagamentoId = evento.data.id;

      // opcional: consultar API do Mercado Pago pra pegar status atual
      const tokens = await getTokensFromSheet();
      let statusFinal = "unknown";

      // Como não sabemos qual loja, tentamos com todos tokens (multi-lojas)
      for (const [lojaId, token] of Object.entries(tokens)) {
        const resp = await fetch(
          `https://api.mercadopago.com/v1/payments/${pagamentoId}`,
          {
            headers: { Authorization: `Bearer ${token}` },
          }
        );
        if (resp.ok) {
          const json = await resp.json();
          statusFinal = json.status;
          pagamentos[pagamentoId] = {
            status: json.status,
            lojaId,
            valor: json.transaction_amount,
            descricao: json.description,
          };
          break;
        }
      }

      console.log(`📩 Webhook recebido: ${pagamentoId} => ${statusFinal}`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Erro no webhook:", err);
    res.sendStatus(500);
  }
});

// 🔹 Simula a aprovação de pagamento PIX (modo teste)
app.post("/simular/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${process.env.MP_TEST_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ status: "approved" })
    });

    const data = await mpRes.json();
    res.json({ success: data.status === "approved", data });
  } catch (err) {
    console.error("Erro ao simular pagamento:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// 🔹 Endpoint para o frontend checar status de um pagamento
app.get("/status/:id", (req, res) => {
  const { id } = req.params;
  const info = pagamentos[id];
  if (info) {
    return res.json({ status: info.status });
  } else {
    return res.json({ status: "pending" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 API de Pagamentos multi-lojas rodando na porta ${PORT}`);
});