module.exports = {
  apps: [
    {
      name: 'whatsapp-api',
      script: 'index.js',
      instances: 1,        // ⚠️ IMPORTANTE: Solo 1 instancia
      exec_mode: 'fork',   // ⚠️ IMPORTANTE: No usar cluster
      watch: false
    }
  ]
};
