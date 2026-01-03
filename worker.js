import { Worker } from 'bullmq';
import { connection } from './redis.js';
import { client, MessageMedia } from './whatsapp.js';

const RATE_DELAY = 500; // ms entre mensajes

const sleep = ms => new Promise(r => setTimeout(r, ms));

const worker = new Worker(
  'whatsapp-messages',
  async job => {
    const { to, message, mediaUrl, mediaData, mimetype, filename, isDocument } = job.data;

    if (!to || (!message && !mediaUrl && !mediaData)) {
      throw new Error('Datos del trabajo incompletos: "to" o "message" están ausentes.');
    }

    console.log(`[Worker] Procesando mensaje para: ${to}`);

    // Verificamos si el cliente está realmente listo para enviar
    // Usamos una verificación más robusta que solo client.info
    if (!client.pupPage || client.pupPage.isClosed()) {
      throw new Error('El navegador de WhatsApp no está inicializado o está cerrado');
    }

    // Aseguramos que 'to' sea un string y limpiamos caracteres no numéricos
    const cleanNumber = String(to).replace(/\D/g, '');
    
    if (!cleanNumber) {
      throw new Error(`El número proporcionado "${to}" no contiene dígitos válidos.`);
    }

    const chatId = `${cleanNumber}@c.us`;

    let content = message;
    let options = {};

    // Lógica para adjuntos
    if (mediaUrl) {
      content = await MessageMedia.fromUrl(mediaUrl);
      if (message) options.caption = message;
    } else if (mediaData && mimetype) {
      // Limpiamos el prefijo Data URI si el usuario lo incluyó por error (ej: data:image/png;base64,...)
      const cleanData = mediaData.includes(';base64,') 
        ? mediaData.split(';base64,').pop() 
        : mediaData;

      content = new MessageMedia(mimetype, cleanData, filename);
      if (message) options.caption = message;
    }

    // Si se marca como documento, forzamos el envío sin compresión
    if (isDocument) options.sendMediaAsDocument = true;

    if (!content) throw new Error('No se pudo determinar el contenido a enviar');

    await client.sendMessage(chatId, content, options);
    
    console.log(`[Worker] Mensaje/Media enviado con éxito a ${chatId}`);

    await sleep(RATE_DELAY);
  },
  {
    connection,
    concurrency: 1
  }
);

// Manejadores de eventos para depuración
worker.on('completed', (job) => {
  console.log(`[Worker] Trabajo ${job.id} completado.`);
});

worker.on('failed', (job, err) => {
  console.error(`[Worker] Trabajo ${job?.id} falló: ${err.message}`);
});
