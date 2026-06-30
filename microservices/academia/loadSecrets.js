require('dotenv').config();

function pick(name, fallback = '') {
  const fromEnv = process.env[name];
  if (fromEnv != null && String(fromEnv).trim() !== '') {
    return String(fromEnv).trim();
  }
  return fallback;
}

module.exports = {
  pick,
  geminiApiKey: () => pick('GEMINI_API_KEY'),
  jwtSecret: () => pick('JWT_SECRET', 'cambiar_en_produccion'),
  smtpUser: () => pick('SMTP_USER'),
  smtpPass: () => pick('SMTP_PASS'),
  dbHost: () => pick('DB_HOST', 'localhost'),
  dbUser: () => pick('DB_USER', 'root'),
  dbPassword: () => pick('DB_PASSWORD', ''),
  dbName: () => pick('DB_NAME', 'railway'),
  dbPort: () => parseInt(pick('DB_PORT', '3306'), 10) || 3306,
  publicFrontendUrl: () => pick('PUBLIC_FRONTEND_URL', '')
};
