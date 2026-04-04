# apiPagamento (PIX multiloja)

Serviço de integração com Mercado Pago para criação e confirmação automática de pagamentos PIX em ambiente **multiloja**.

## O que mudou

- Persistência local em arquivo (`DATA_FILE`) para pagamentos e eventos de callback (sem depender de memória volátil).
- Correlação forte por `payment_id` + `loja_id` + `correlation_id` + `external_reference`.
- Webhook resolve loja de forma determinística via registro local, sem varrer tokens de todas as lojas.
- Callback backend-to-backend assinado com HMAC (`X-Callback-Signature`) e com chave de idempotência (`X-Idempotency-Key`).
- Status `/status/:id` lido da persistência.

## Variáveis de ambiente

- `PORT` (opcional): porta HTTP, padrão `4000`.
- `SHEET_PROPRIETARIOS` (**obrigatória**): URL CSV com colunas `lojaId,mercado_pago_access_token`.
- `API_BASE_URL` (**obrigatória**): base URL pública da API para registrar `notification_url` no Mercado Pago.
- `CALLBACK_SHARED_SECRET` (**obrigatória para callbacks**): segredo HMAC usado na assinatura do callback.
- `DATA_FILE` (opcional): caminho do arquivo de persistência, padrão `./data/payments-store.json`.

## Endpoints

### `POST /pagar/:lojaId`

Compatível com contrato atual e estendido com campos opcionais para correlação/callback.

Payload:

```json
{
  "descricao": "Pedido da loja",
  "valor": 59.9,
  "metodo": "pix",
  "payer": { "email": "cliente@teste.com" },
  "correlation_id": "checkout-session-123",
  "callback_url": "https://backend-principal.exemplo.com/api/payments/pix/callback"
}
```

Comportamento:

- Envia `external_reference` e `metadata` com `loja_id` + `correlation_id` para o Mercado Pago.
- Persiste pagamento localmente vinculado à loja.

### `POST /webhook`

- Recebe evento do Mercado Pago.
- Usa `payment_id` do evento para buscar o pagamento local e identificar a loja.
- Consulta o Mercado Pago com **token da loja correta**.
- Atualiza persistência.
- Se status for `approved`, dispara callback assinado para o backend principal.

### `GET /status/:id`

Retorna status persistido do pagamento.

### `POST /callbacks/retry/:paymentId`

Retentativa manual segura do callback de aprovação (somente para pagamentos `approved`).

### `POST /api/payments/:paymentId/refund` (interno/operacional)

Solicita refund seguro para pagamento PIX já aprovado, com validações fortes de multiloja, correlação e idempotência local.

Payload:

```json
{
  "loja_id": "uuid-da-loja",
  "correlation_id": "corr-123",
  "reason": "pedido_recusado_pela_loja",
  "metadata": {
    "operator": "system",
    "source": "manual"
  }
}
```

Regras de segurança:

- pagamento deve existir localmente;
- `payment_id` deve pertencer à `loja_id` informada (sem cross-tenant);
- se `correlation_id` for enviado, deve coincidir com o persistido;
- pagamento precisa estar `approved` para ser elegível;
- se já estiver reembolsado, a resposta é idempotente (sem duplicar operação);
- se existir refund em andamento para o mesmo pagamento, retorna resposta segura/idempotente.

Estados locais de refund:

- `pending`
- `in_process`
- `refunded`
- `failed`
- `rejected`

Campos auditáveis persistidos por tentativa:

- id interno do refund
- `payment_id`, `loja_id`, `correlation_id`
- `reason`, `metadata`
- `idempotency_key`
- status local
- `provider_refund_id`, `provider_status`, `provider_payload`
- `refunded_amount`
- timestamps (`created_at`, `updated_at`, `requested_at`, `finished_at`)

## Callback enviado ao backend principal

Payload:

```json
{
  "event": "payment.approved",
  "payment_id": "123456789",
  "loja_id": "loja-abc",
  "status": "approved",
  "amount": 59.9,
  "correlation_id": "checkout-session-123",
  "txid": "...",
  "external_reference": "loja-abc:checkout-session-123"
}
```

Headers:

- `X-Callback-Timestamp`: ISO timestamp.
- `X-Callback-Signature`: `sha256=<hmac_hex>` calculado sobre `${timestamp}.${raw_json}`.
- `X-Callback-Event`: `payment.approved`.
- `X-Idempotency-Key`: `payment.approved:<payment_id>`.

## Idempotência

- Webhook repetido não duplica callback confirmado.
- Evento de callback usa chave única por pagamento aprovado (`payment.approved:<payment_id>`).
- Tentativas e estado do callback ficam persistidos (`pending/sent/failed/confirmed/not_required`).

## Testes

```bash
npm test
```

Cobertura implementada:

- criação de pagamento e persistência,
- status após restart lógico,
- aprovação por webhook,
- callback assinado,
- idempotência em webhook repetido,
- isolamento multiloja no uso de token.
