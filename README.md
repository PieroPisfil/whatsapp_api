# WhatsApp API

Backend ligero para enviar y recibir mensajes de WhatsApp con `whatsapp-web.js`, cola BullMQ y Redis.

## Modos de envío

| Modo | Endpoint | Comportamiento |
|------|----------|----------------|
| `notification` (default) | `POST /mode` | Envío rápido, delays cortos |
| `bulk` | `POST /mode` | Typing simulado + delays 3–10 s |

Ambos usan `POST /send`. El modo y las URLs de webhook se **persisten en Redis**.

## Requisitos

- Node.js 20+
- Redis
- Chromium (incluido en la imagen Docker)

## Configuración

Copia `.env.example` a `.env` y completa los valores:

```bash
cp .env.example .env
```

Variables importantes:

- `SECRET_WORD` / `JWT_SECRET` (≥32 chars): autenticación
- `WEBHOOK_URLS`: destinos iniciales de mensajes entrantes
- `WEBHOOK_SECRET`: firma HMAC de webhooks (`X-Webhook-Signature`)
- `BODY_LIMIT` / `MAX_MEDIA_BYTES`: límites de payload

## Arranque local

```bash
npm install
# Redis debe estar corriendo
npm run dev
```

Producción con PM2:

```bash
npm start
```

## Docker

```bash
docker compose up -d --build
```

La API queda en `127.0.0.1:3001` (instancia 1).

## API rápida

1. `POST /login` → `{ "secret_word": "..." }` → token JWT  
2. Usar `Authorization: Bearer <token>` en el resto  
3. `GET /session` → QR o estado conectado  
4. `POST /send` → encola mensaje y devuelve `jobId`  
5. `GET /jobs/:id` → estado del job (`waiting`, `active`, `completed`, `failed`, …)

### Envío

```json
POST /send
{
  "number": "51999999999",
  "message": "Hola",
  "mediaUrl": "https://example.com/img.png",
  "mediaData": "<base64>",
  "mimetype": "image/png",
  "filename": "img.png",
  "isDocument": false
}
```

Respuesta:

```json
{ "status": "QUEUED", "jobId": "51999999999-1710000000000", "message": "Mensaje agregado a la cola" }
```

### Verificar firma de webhook

El receptor debe validar:

```
X-Webhook-Signature: sha256=<hmac_sha256_hex(body_raw, WEBHOOK_SECRET)>
```

sobre el body JSON crudo.

## Notas

- `/send` responde `503` si WhatsApp no está conectado.
- Jobs completados se limpian (1 h / máx. 200); fallidos se retienen 7 días / máx. 500.
- `SIGTERM`/`SIGINT` cierran HTTP, worker, cola, WhatsApp y Redis de forma ordenada.
