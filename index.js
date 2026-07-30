import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import qrcode from 'qrcode';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

import { client, SESSION_PATH } from './whatsapp.js';
import { messageQueue } from './queue.js';
import { connection } from './redis.js';
import { worker, setBulkMode, getBulkMode, initBulkMode } from './worker.js';
import { loadWebhookUrls, saveWebhookUrls } from './store.js';
import { verify, sign } from './middlewares/jwt.js';

const BODY_LIMIT = process.env.BODY_LIMIT || '10mb';
const MAX_MEDIA_BYTES = Number(process.env.MAX_MEDIA_BYTES || 8 * 1024 * 1024);
const WEBHOOK_TIMEOUT_MS = Number(process.env.WEBHOOK_TIMEOUT_MS || 5000);
const WEBHOOK_MEDIA_TIMEOUT_MS = Number(process.env.WEBHOOK_MEDIA_TIMEOUT_MS || 15000);

process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[Process] Uncaught Exception:', error);
});

const app = express();
const port = process.env.PORT || 3000;

let WEBHOOK_URLS = [];
let phoneNumber;
let server;
let shuttingDown = false;

app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ limit: BODY_LIMIT, extended: true }));

app.post('/login', (req, res) => {
  const { secret_word } = req.body;

  if (!secret_word || secret_word !== process.env.SECRET_WORD) {
    return res.status(401).json({ error: 'Palabra secreta incorrecta o no proporcionada.' });
  }

  try {
    const token = sign({ app: 'whatsapp_api' });
    res.json({ token });
  } catch (error) {
    console.error('Error en login:', error.message);
    res.status(500).json({ error: 'No se pudo generar el token por un error de configuración del servidor.' });
  }
});

app.use(verify);

let qrCodeData = null;
let clientReady = false;

function estimateBase64Bytes(data) {
  const clean = String(data).includes(';base64,')
    ? String(data).split(';base64,').pop()
    : String(data);
  return Math.floor(clean.length * 0.75);
}

function buildWebhookRequest(payload, hasMedia) {
  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json' };
  const secret = process.env.WEBHOOK_SECRET;

  if (secret) {
    const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
    headers['X-Webhook-Signature'] = `sha256=${signature}`;
  }

  return {
    body,
    headers,
    timeout: hasMedia ? WEBHOOK_MEDIA_TIMEOUT_MS : WEBHOOK_TIMEOUT_MS
  };
}

function sanitizeJobData(data = {}) {
  return {
    to: data.to,
    hasMessage: Boolean(data.message),
    hasMediaUrl: Boolean(data.mediaUrl),
    hasMediaData: Boolean(data.mediaData),
    mimetype: data.mimetype || null,
    filename: data.filename || null,
    isDocument: Boolean(data.isDocument)
  };
}

client.on('qr', (qr) => {
  try {
    qrCodeData = qr;
    clientReady = false;
    console.log(`[${new Date().toLocaleTimeString()}] Nuevo QR generado. Esperando escaneo...`);
  } catch (err) {
    console.error('Error en el manejador de QR:', err.message);
  }
});

client.on('ready', () => {
  console.log('¡Cliente de WhatsApp listo!');
  qrCodeData = null;
  clientReady = true;

  if (client.info && client.info.wid) {
    phoneNumber = client.info.wid.user;
    console.log(`Sesión iniciada con el número: ${phoneNumber}`);
  }
});

client.on('auth_failure', (msg) => {
  console.error('Fallo de autenticación', msg);
  clientReady = false;
});

client.on('disconnected', (reason) => {
  console.warn('WhatsApp desconectado:', reason);
  clientReady = false;
});

client.on('message', async (msg) => {
  const isSelf = msg.from === msg.to;

  if ((msg.fromMe && !isSelf) || msg.from === 'status@broadcast') return;

  console.log(`Mensaje recibido de ${msg.from}: ${msg.body} ${isSelf ? '(Auto-mensaje)' : ''}`);

  if (WEBHOOK_URLS.length === 0) {
    console.log('No hay URLs de webhook configuradas. Ignorando mensaje entrante.');
    return;
  }

  try {
    let mediaData = null;
    if (msg.hasMedia) {
      try {
        const media = await msg.downloadMedia();
        if (media) {
          mediaData = {
            mimetype: media.mimetype,
            data: media.data,
            filename: media.filename
          };
        }
      } catch (err) {
        console.error('[Webhook] Error al descargar media:', err.message);
      }
    }

    const payload = {
      from: msg.from,
      to: msg.to,
      isSelf,
      name: msg._data?.notifyName || 'Desconocido',
      body: msg.body,
      type: msg.type,
      hasMedia: msg.hasMedia,
      media: mediaData,
      timestamp: msg.timestamp,
      isGroup: msg.isGroupMsg,
      number: msg.from.replace('@c.us', '')
    };

    const { body, headers, timeout } = buildWebhookRequest(payload, Boolean(mediaData));

    const results = await Promise.allSettled(
      WEBHOOK_URLS.map((url) =>
        axios.post(url, body, {
          headers,
          timeout,
          maxBodyLength: Infinity,
          maxContentLength: Infinity
        })
      )
    );

    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.error(`Webhook ${index} falló:`, result.reason.message);
      } else {
        console.log(`Webhook ${index} enviado exitosamente`);
      }
    });
  } catch (error) {
    console.error('Error enviando al Webhook:', error.message);
  }
});

app.get('/session', async (req, res) => {
  if (clientReady) {
    return res.json({ status: 'CONNECTED', message: 'WhatsApp ya está listo', phone_number: phoneNumber });
  }

  if (!qrCodeData) {
    return res.json({ status: 'WAITING', message: 'Esperando generación de QR...' });
  }

  try {
    const qrImage = await qrcode.toDataURL(qrCodeData);
    res.json({
      status: 'QR_READY',
      qr_code: qrImage
    });
  } catch {
    res.status(500).json({ error: 'Error generando imagen QR' });
  }
});

app.post('/logout', async (req, res) => {
  try {
    if (clientReady) {
      await client.logout();
      clientReady = false;
      qrCodeData = null;
      phoneNumber = null;

      await client.destroy();
      client.initialize();

      res.json({ status: 'LOGGED_OUT', message: 'Sesión cerrada exitosamente. Generando nuevo QR...' });
    } else {
      res.status(400).json({ error: 'No hay una sesión activa para cerrar.' });
    }
  } catch (error) {
    console.error('Error en logout:', error);
    res.status(500).json({ error: 'Error al intentar cerrar sesión' });
  }
});

app.post('/reset', async (req, res) => {
  try {
    await client.destroy();
    clientReady = false;
    qrCodeData = null;
    phoneNumber = null;

    const sessionPath = path.resolve(SESSION_PATH);

    if (fs.existsSync(sessionPath)) {
      const files = fs.readdirSync(sessionPath);
      for (const file of files) {
        const fullPath = path.join(sessionPath, file);
        fs.rmSync(fullPath, { recursive: true, force: true });
      }
      console.log('Contenido de la sesión eliminado (manteniendo el punto de montaje).');
    }

    client.initialize();

    res.json({ status: 'RESET_COMPLETE', message: 'Sistema reseteado. Escanea el nuevo QR.' });
  } catch (error) {
    console.error('Error en hard reset:', error);
    try { client.initialize(); } catch { /* ignore */ }

    res.status(500).json({ error: 'Error crítico al resetear la instancia' });
  }
});

app.post('/is_on_whatsapp', async (req, res) => {
  const { number } = req.body;

  if (!clientReady) {
    return res.status(503).json({
      status: 'ERROR',
      message: 'El cliente de WhatsApp no está listo. Por favor, escanea el QR primero.'
    });
  }

  if (!number) {
    return res.status(400).json({
      status: 'ERROR',
      message: 'El campo "number" es obligatorio.'
    });
  }

  try {
    const cleanNumber = String(number).replace(/\D/g, '');
    const id = await client.getNumberId(cleanNumber);

    res.json({
      exists: !!id,
      jid: id ? id._serialized : null,
      number: cleanNumber
    });
  } catch (error) {
    console.error('Error verificando número:', error);
    res.status(500).json({ error: 'Error interno al verificar el número.' });
  }
});

app.post('/send', async (req, res) => {
  const { number, message, mediaUrl, mediaData, mimetype, filename, isDocument } = req.body;

  if (!clientReady) {
    return res.status(503).json({
      status: 'ERROR',
      message: 'El cliente de WhatsApp no está listo. Por favor, escanea el QR primero.'
    });
  }

  if (!number || (!message && !mediaUrl && !mediaData)) {
    return res.status(400).json({
      status: 'ERROR',
      message: 'El número y al menos un mensaje o archivo son obligatorios.'
    });
  }

  if (mediaData && !mimetype) {
    return res.status(400).json({
      status: 'ERROR',
      message: 'El campo "mimetype" es obligatorio cuando se envía "mediaData" (ej: image/png).'
    });
  }

  if (mediaData && estimateBase64Bytes(mediaData) > MAX_MEDIA_BYTES) {
    return res.status(413).json({
      status: 'ERROR',
      message: `El archivo supera el límite de ${MAX_MEDIA_BYTES} bytes.`
    });
  }

  const job = await messageQueue.add('send', {
    to: number,
    message,
    mediaUrl,
    mediaData,
    mimetype,
    filename,
    isDocument
  }, {
    jobId: `${String(number).replace(/\D/g, '') || 'unknown'}-${Date.now()}`
  });

  res.json({
    status: 'QUEUED',
    jobId: job.id,
    message: 'Mensaje agregado a la cola'
  });
});

app.get('/jobs/:id', async (req, res) => {
  try {
    const job = await messageQueue.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job no encontrado.' });
    }

    const state = await job.getState();

    res.json({
      id: job.id,
      state,
      data: sanitizeJobData(job.data),
      attemptsMade: job.attemptsMade,
      failedReason: job.failedReason || null,
      timestamp: job.timestamp,
      processedOn: job.processedOn || null,
      finishedOn: job.finishedOn || null
    });
  } catch (error) {
    console.error('Error consultando job:', error.message);
    res.status(500).json({ error: 'No se pudo consultar el estado del job.' });
  }
});

app.post('/webhook/set', async (req, res) => {
  const { webhook_url, webhook_urls } = req.body;

  if (!webhook_url && !(webhook_urls && Array.isArray(webhook_urls))) {
    return res.status(400).json({
      error: 'Se requiere "webhook_url" o "webhook_urls".'
    });
  }

  let urls = [];
  if (webhook_urls && Array.isArray(webhook_urls)) urls = webhook_urls;
  if (webhook_url) urls.push(webhook_url);

  try {
    urls = urls.map((u) => new URL(u).toString().trim());
  } catch {
    return res.status(400).json({ error: 'Al menos una URL proporcionada no es válida.' });
  }

  WEBHOOK_URLS = Array.from(new Set(urls));
  await saveWebhookUrls(WEBHOOK_URLS);

  res.json({
    status: 'SUCCESS',
    message: 'URLs del webhook actualizadas correctamente.',
    webhook_urls: WEBHOOK_URLS
  });
});

app.delete('/webhook/delete', async (req, res) => {
  const { webhook_url } = req.body || {};

  if (!webhook_url) {
    WEBHOOK_URLS = [];
    await saveWebhookUrls(WEBHOOK_URLS);
    return res.json({ status: 'SUCCESS', message: 'Todas las URLs de webhook fueron eliminadas.', webhook_urls: WEBHOOK_URLS });
  }

  try {
    new URL(webhook_url);
  } catch {
    return res.status(400).json({ error: 'La URL proporcionada no es válida.' });
  }

  const before = WEBHOOK_URLS.length;
  WEBHOOK_URLS = WEBHOOK_URLS.filter((u) => u !== webhook_url && u !== webhook_url.trim());
  const removed = before !== WEBHOOK_URLS.length;
  await saveWebhookUrls(WEBHOOK_URLS);

  res.json({ status: 'SUCCESS', message: removed ? 'URL eliminada.' : 'URL no encontrada.', webhook_urls: WEBHOOK_URLS });
});

app.get('/webhook/get', (req, res) => {
  res.json({
    webhook_urls: WEBHOOK_URLS,
    signature_enabled: Boolean(process.env.WEBHOOK_SECRET)
  });
});

app.get('/mode', (req, res) => {
  res.json({ mode: getBulkMode() ? 'bulk' : 'notification' });
});

app.post('/mode', async (req, res) => {
  const { mode } = req.body;

  if (mode === 'bulk') {
    await setBulkMode(true);
    return res.json({ status: 'SUCCESS', message: 'Modo masivo activado. Se aplicarán delays largos y aleatorios.' });
  }

  if (mode === 'notification') {
    await setBulkMode(false);
    return res.json({ status: 'SUCCESS', message: 'Modo notificaciones activado. Envío rápido habilitado.' });
  }

  return res.status(400).json({ error: 'Modo inválido. Usa "bulk" o "notification".' });
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Process] Señal ${signal} recibida. Cerrando de forma ordenada...`);

  const forceTimer = setTimeout(() => {
    console.error('[Process] Timeout en shutdown. Forzando salida.');
    process.exit(1);
  }, 30000);
  forceTimer.unref?.();

  try {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      console.log('[Process] Servidor HTTP cerrado.');
    }

    await worker.close();
    console.log('[Process] Worker cerrado.');

    await messageQueue.close();
    console.log('[Process] Cola cerrada.');

    try {
      await client.destroy();
      console.log('[Process] Cliente WhatsApp destruido.');
    } catch (err) {
      console.warn('[Process] Error al destruir cliente WhatsApp:', err.message);
    }

    await connection.quit();
    console.log('[Process] Redis desconectado.');

    clearTimeout(forceTimer);
    process.exit(0);
  } catch (err) {
    console.error('[Process] Error durante shutdown:', err);
    clearTimeout(forceTimer);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function start() {
  WEBHOOK_URLS = await loadWebhookUrls(process.env.WEBHOOK_URLS);
  await initBulkMode();

  server = app.listen(port, () => {
    console.log(`API escuchando en http://localhost:${port}`);
    console.log('Iniciando cliente de WhatsApp...');
    client.initialize();
  });
}

start().catch((err) => {
  console.error('[Process] No se pudo iniciar la API:', err);
  process.exit(1);
});
