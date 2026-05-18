function loadLocalSecrets() {
  try {
    return require('./secrets.local');
  } catch {
    return {};
  }
}

function pick(name, local, fallback = '') {
  const fromEnv = process.env[name];
  if (fromEnv != null && String(fromEnv).trim() !== '') {
    return String(fromEnv).trim();
  }
  if (local != null && String(local).trim() !== '') {
    return String(local).trim();
  }
  return fallback;
}

const local = loadLocalSecrets();

module.exports = {
  local,
  pick,
  geminiApiKey: () => pick('GEMINI_API_KEY', local.GEMINI_API_KEY),
  jwtSecret: () => pick('JWT_SECRET', local.JWT_SECRET, 'cambiar_en_produccion'),
  smtpUser: () => pick('SMTP_USER', local.SMTP_USER),
  smtpPass: () => pick('SMTP_PASS', local.SMTP_PASS),
  dbHost: () => pick('DB_HOST', local.DB_HOST, 'localhost'),
  dbUser: () => pick('DB_USER', local.DB_USER, 'root'),
  dbPassword: () => pick('DB_PASSWORD', local.DB_PASSWORD, ''),
  dbName: () => pick('DB_NAME', local.DB_NAME, 'railway'),
  dbPort: () => parseInt(pick('DB_PORT', local.DB_PORT, '3306'), 10) || 3306,
  publicFrontendUrl: () => pick('PUBLIC_FRONTEND_URL', local.PUBLIC_FRONTEND_URL, '')
};
