import { Worker } from 'bullmq';
import { connection } from './redis.js';
import { client, MessageMedia } from './whatsapp.js';

const CLIENT_READY_TIMEOUT = 60000; // ms para esperar reconexión de WhatsApp

const sleep = ms => new Promise(r => setTimeout(r, ms));

const getRandomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const isClientReady = () => {
  return !!(client.info?.wid && client.pupPage && !client.pupPage.isClosed());
};

const waitForClientReady = async (timeout = CLIENT_READY_TIMEOUT) => {
  if (isClientReady()) return;

  console.log('[Worker] WhatsApp no está listo. Esperando reconexión...');

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('ready', onReady);
      reject(new Error('Timeout al esperar que el cliente de WhatsApp esté listo')); 
    }, timeout);

    const onReady = () => {
      clearTimeout(timer);
      resolve();
    };

    client.once('ready', onReady);
  });
};

const worker = new Worker(
  'whatsapp-messages',
  async job => {
    const { to, message, mediaUrl, mediaData, mimetype, filename, isDocument } = job.data;

    if (!to || (!message && !mediaUrl && !mediaData)) {
      throw new Error('Datos del trabajo incompletos: "to" o "message" están ausentes.');
    }

    console.log(`[Worker] Procesando mensaje para: ${to}`);

    if (!isClientReady()) {
      await waitForClientReady();
    }

    if (!isClientReady()) {
      throw new Error('El cliente de WhatsApp no está listo para enviar mensajes.');
    }

    const cleanNumber = String(to).replace(/\D/g, '');
    if (!cleanNumber) {
      throw new Error(`El número proporcionado "${to}" no contiene dígitos válidos.`);
    }

    const chatId = `${cleanNumber}@c.us`;
    let content = message;
    let options = {};

    if (mediaUrl) {
      content = await MessageMedia.fromUrl(mediaUrl);
      if (message) options.caption = message;
    } else if (mediaData && mimetype) {
      const cleanData = mediaData.includes(';base64,')
        ? mediaData.split(';base64,').pop()
        : mediaData;

      content = new MessageMedia(mimetype, cleanData, filename);
      if (message) options.caption = message;
    }

    if (isDocument) options.sendMediaAsDocument = true;
    if (!content) throw new Error('No se pudo determinar el contenido a enviar');

    // Simulamos comportamiento humano antes de enviar
    try {
      const chat = await client.getChatById(chatId);
      await chat.sendStateTyping();
      
      const typingTime = getRandomDelay(0, 1000); // Simula escribir entre 0 y 1 segundos
      console.log(`[Worker] Simulando escritura por ${typingTime / 1000}s para ${chatId}...`);
      await sleep(typingTime);
    } catch (err) {
      console.warn(`[Worker] No se pudo simular estado "escribiendo". Esperando...`);
      await sleep(getRandomDelay(0, 1000));
    }

    await client.sendMessage(chatId, content, options);
    console.log(`[Worker] Mensaje/Media enviado con éxito a ${chatId}`);

    // Retraso aleatorio largo antes de procesar el siguiente mensaje 
    const delayNext = getRandomDelay(500, 2000);
    console.log(`[Worker] Esperando ${delayNext / 1000}s antes del siguiente mensaje...`);
    await sleep(delayNext);
  },
  {
    connection,
    concurrency: 1
  }
);

worker.on('active', job => {
  console.log(`[Worker] Trabajo activo: ${job.id}`);
});

worker.on('completed', job => {
  console.log(`[Worker] Trabajo ${job.id} completado.`);
});

worker.on('failed', (job, err) => {
  console.error(`[Worker] Trabajo ${job?.id} falló: ${err.message}`);
});

worker.on('drained', () => {
  console.log('[Worker] Cola vacía. Esperando nuevos trabajos.');
});

worker.on('error', err => {
  console.error('[Worker] Error global:', err.message || err);
});
