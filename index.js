import express from 'express';
import { client, SESSION_PATH } from './whatsapp.js';
import qrcode from 'qrcode';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

import { messageQueue } from './queue.js';
import './worker.js'; // 🔥 Importamos el worker para que corra en este mismo proceso
import { verify, sign } from './middlewares/jwt.js';

const app = express();
const port = process.env.PORT || 3000;


// URL donde quieres recibir los mensajes entrantes (Tu Webhook)
// Puedes usar https://webhook.site para probar si no tienes servidor aún.
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://tu-servidor-externo.com/webhook/whatsapp';

// Middleware para parsear JSON
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// Endpoint público para obtener el Bearer Token
// En producción, deberías validar un usuario y contraseña aquí.
app.post('/login', (req, res) => {
    const { secret_word } = req.body;

    // 1. Validar la identidad ANTES de generar el token
    if (!secret_word || secret_word !== process.env.SECRET_WORD) {
        return res.status(401).json({ error: 'Palabra secreta incorrecta o no proporcionada.' });
    }

    try {
        // 2. Generar el token con un payload que NO contenga secretos
        const token = sign({ app: 'whatsapp_api' });
        res.json({ token });
    } catch (error) {
        console.error('Error en login:', error.message);
        res.status(500).json({ error: 'No se pudo generar el token por un error de configuración del servidor.' });
    }
});

// Middleware global: A partir de aquí, todos los endpoints requieren Bearer Token
app.use(verify);

// Variables de estado
let qrCodeData = null;
let clientReady = false;


// Evento: Generación del QR
client.on('qr', (qr) => {
    try {
        qrCodeData = qr; // Asignamos primero para asegurar que la API tenga el dato
        clientReady = false;

        console.log(`[${new Date().toLocaleTimeString()}] Nuevo QR generado. Esperando escaneo...`);
        // qrcode.generate(qr, { small: true }); 
    } catch (err) {
        console.error('Error en el manejador de QR:', err.message);
    }
});

// Evento: Cliente listo
client.on('ready', () => {
    console.log('¡Cliente de WhatsApp listo!');
    qrCodeData = null; // Limpiamos el QR porque ya no es necesario
    clientReady = true;
});

// Evento: Autenticación fallida
client.on('auth_failure', msg => {
    console.error('Fallo de autenticación', msg);
    clientReady = false;
});

// Evento: Desconexión
client.on('disconnected', reason => {
    console.warn('WhatsApp desconectado:', reason);
    clientReady = false;
});

// 2. Implementación del Webhook (Mensajes Entrantes)
// Escucha mensajes y los envía a tu servidor externo
client.on('message', async msg => {
    // Detectamos si el mensaje es enviado a nosotros mismos
    const isSelf = msg.from === msg.to;

    // Modificamos el filtro: 
    // Ignoramos estados y mensajes que enviamos a OTROS, 
    // pero permitimos los mensajes que nos enviamos a nosotros mismos (isSelf).
    if ((msg.fromMe && !isSelf) || msg.from === 'status@broadcast') return;

    console.log(`Mensaje recibido de ${msg.from}: ${msg.body} ${isSelf ? '(Auto-mensaje)' : ''}`);

    try {
        let mediaData = null;
        if (msg.hasMedia) {
            try {
                const media = await msg.downloadMedia();
                if (media) {
                    mediaData = {
                        mimetype: media.mimetype,
                        data: media.data, // Contenido en Base64
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
            isSelf: isSelf,
            name: msg._data?.notifyName || 'Desconocido',
            body: msg.body,
            type: msg.type,
            hasMedia: msg.hasMedia,
            media: mediaData,
            timestamp: msg.timestamp,
            isGroup: msg.isGroupMsg
        };
        
        await axios.post(WEBHOOK_URL, payload, { timeout: 5000 });
        console.log(`[Webhook] Notificación enviada con éxito.`);
    } catch (error) {
        console.error('Error enviando al Webhook:', error.message);
    }
});



// --- ENDPOINTS DE LA API ---

/**
 * GET /session
 * Devuelve el QR como una imagen base64 para mostrar en un frontend
 * o el estado si ya está conectado.
 */
app.get('/session', async (req, res) => {
    if (clientReady) {
        return res.json({ status: 'CONNECTED', message: 'WhatsApp ya está listo' });
    }

    if (!qrCodeData) {
        return res.json({ status: 'WAITING', message: 'Esperando generación de QR...' });
    }

    try {
        // Convertimos el string QR a una imagen Data URL
        const qrImage = await qrcode.toDataURL(qrCodeData);
        res.json({ 
            status: 'QR_READY', 
            qr_code: qrImage // Esto se puede poner directo en un tag <img src="...">
        });
    } catch (err) {
        res.status(500).json({ error: 'Error generando imagen QR' });
    }
});

/**
 * POST /logout
 * Cierra la sesión de WhatsApp activa.
 * El servidor quedará esperando un nuevo escaneo de QR.
 */
app.post('/logout', async (req, res) => {
    try {
        if (clientReady) {
            // Cierra la sesión en WhatsApp Web (el celular se desconecta)
            await client.logout(); 
            clientReady = false;
            qrCodeData = null;
            
            // Nota: Al hacer logout, la librería suele emitir el evento 'disconnected'
            // y a veces requiere reinicializar para volver a mostrar el QR.
            // Por seguridad, reinicializamos el cliente.
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

/**
 * POST /reset
 * Destruye el cliente y BORRA los datos de sesión del disco.
 * Útil si la sesión se corrompió o quieres cambiar de número completamente.
 */
app.post('/reset', async (req, res) => {
    try {
        // 1. Destruir el cliente actual (cierra el navegador)
        await client.destroy();
        clientReady = false;
        qrCodeData = null;

        // 2. Borrar la carpeta de autenticación recursivamente
        // Usamos path.resolve para asegurar la ruta correcta
        const sessionPath = path.resolve(SESSION_PATH);
        
        if (fs.existsSync(sessionPath)) {
            // En Docker, no podemos borrar el directorio raíz del volumen (punto de montaje)
            // Borramos recursivamente todo lo que hay DENTRO de él.
            const files = fs.readdirSync(sessionPath);
            for (const file of files) {
                const fullPath = path.join(sessionPath, file);
                fs.rmSync(fullPath, { recursive: true, force: true });
            }
            console.log('Contenido de la sesión eliminado (manteniendo el punto de montaje).');
        }

        // 3. Volver a iniciar el cliente para generar un QR limpio
        client.initialize();

        res.json({ status: 'RESET_COMPLETE', message: 'Sistema reseteado. Escanea el nuevo QR.' });

    } catch (error) {
        console.error('Error en hard reset:', error);
        // Intentamos revivir el cliente por si acaso falló el borrado
        try { client.initialize(); } catch (e) {}
        
        res.status(500).json({ error: 'Error crítico al resetear la instancia' });
    }
});

/**
 * POST /is_on_whatsapp
 * Verifica si un número de teléfono está registrado en WhatsApp.
 * Body esperado: { "number": "51999999999" }
 */
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
        // Limpiamos el número de caracteres no numéricos
        const cleanNumber = String(number).replace(/\D/g, '');
        
        // getNumberId devuelve el ID de WhatsApp si existe, o null si no.
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

/**
 * POST /send
 * Envía un mensaje a un número específico.
 * Body esperado: { "number": "51999999999", "message": "Hola mundo" }
 */
app.post('/send', async (req, res) => {
  const { number, message, mediaUrl, mediaData, mimetype, filename, isDocument } = req.body;

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

  await messageQueue.add('send', {
    to: number,
    message,
    mediaUrl,
    mediaData,
    mimetype,
    filename,
    isDocument
  },
  { jobId: `${number}-${Date.now()}` });

  res.json({
    status: 'QUEUED',
    message: 'Mensaje agregado a la cola'
  });
});

// Iniciar servidor Express
app.listen(port, () => {
    console.log(`API escuchando en http://localhost:${port}`);
    
    // Inicializamos el cliente DESPUÉS de que el servidor y los eventos están listos
    console.log('Iniciando cliente de WhatsApp...');
    client.initialize();
});