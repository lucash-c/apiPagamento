import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import Papa from "papaparse";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4000;
const SHEET_URL = process.env.SHEET_PROPRIETARIOS;

// 🔹 Lê a planilha e retorna um mapa { lojaId: access_token }
async function getTokensFromSheet() {
  const res = await fetch(SHEET_URL);
  if (!res.ok) throw new Error("Erro ao buscar planilha de proprietários");

  const csv = await res.text();
  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });

  const tokens = {};
  parsed.data.forEach(row => {
    if (row.lojaId && row.mercado_pago_access_token) {
      tokens[row.lojaId.trim()] = row.mercado_pago_access_token.trim();
    }
  });

  return tokens;
}

// 🔹 Endpoint de pagamento
app.post("/pagar/:lojaId", async (req, res) => {
  try {
    const { lojaId } = req.params;
    const { descricao, valor, metodo = "pix", payer } = req.body;

    const tokens = await getTokensFromSheet();
    const ACCESS_TOKEN = tokens[lojaId];

    if (!ACCESS_TOKEN) {
      return res.status(400).json({ error: "Loja não encontrada ou sem token" });
    }

    const payload = {
      transaction_amount: Number(valor),
      description: descricao || `Pedido da ${lojaId}`,
      payment_method_id: metodo, // "pix", "visa", "master", etc
      payer: payer || { email: "cliente@teste.com" }
    };

    const mpRes = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await mpRes.json();
    res.json(data);

  } catch (error) {
    console.error("Erro no pagamento:", error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 API de Pagamentos multi-lojas rodando na porta ${PORT}`);
});
