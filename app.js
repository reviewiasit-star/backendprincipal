#!/usr/bin/env node

// Archivo de entrada para cPanel
const app = require('./index.js');

// cPanel maneja el puerto automáticamente
const PORT = process.env.PORT || 3001;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Servidor ejecutándose en puerto ${PORT}`);
  });
}

module.exports = app;