import dotenv from "dotenv";
import fetch from "node-fetch";
import { createApp } from "./app.js";
import { createStore } from "./store.js";

dotenv.config();

const PORT = process.env.PORT || 4000;
const DATA_FILE = process.env.DATA_FILE || "./data/payments-store.json";

async function bootstrap() {
  const store = await createStore(DATA_FILE);
  const app = createApp({ db: store, httpClient: fetch, env: process.env, logger: console });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 API de Pagamentos multi-lojas rodando na porta ${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error("Falha ao iniciar serviço:", err);
  process.exit(1);
});
