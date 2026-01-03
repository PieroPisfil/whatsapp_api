import pkg from 'whatsapp-web.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const { Client, LocalAuth, MessageMedia } = pkg;

// ---- helpers ESM ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- sesión ----
export const SESSION_PATH = path.join(__dirname, '.wwebjs_auth');

// (opcional) asegúrate que exista
if (!fs.existsSync(SESSION_PATH)) {
  fs.mkdirSync(SESSION_PATH, { recursive: true });
}

// Limpiar el bloqueo de sesión de Chromium si existe (común en Docker)
const cleanupLock = () => {
  const sessionDir = path.join(SESSION_PATH, 'session');
  const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

  lockFiles.forEach(file => {
    const fullPath = path.join(sessionDir, file);
    try {
      fs.unlinkSync(fullPath);
      console.log(`Limpiado archivo de bloqueo: ${file}`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`Error eliminando ${file}:`, err.message);
      }
    }
  });
};

cleanupLock();

// ---- configuración de puppeteer ----
const puppeteerOptions = {
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--no-zygote'
  ]
};

if (process.env.PUPPETEER_EXECUTABLE_PATH) {
  puppeteerOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
}

// ---- cliente ----
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: SESSION_PATH
  }),
  puppeteer: puppeteerOptions
});

export { client, MessageMedia };
