const { GoogleGenerativeAI } = require('@google/generative-ai');
const { geminiApiKey } = require('./loadSecrets');
const { GEMINI_EMBEDDINGS_TIMEOUT_MS } = require('./appConfig');

const GEMINI_API_KEY = geminiApiKey();
const GEMINI_MAX_RETRIES = 3;

const MODELOS_GEMINI_ESTATICOS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite'
];

const PATRON_MODELO_EXCLUIDO =
  /embedding|embed|imagen|image|veo|tts|audio|live|computer|aqa|preview-tts|nano-banana|lyria|deep-research|robotics|gemma/i;

const ORDEN_PREFERENCIA = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite'
];

let geminiClient = null;
let modelosCache = null;

function getGeminiClient() {
  if (!GEMINI_API_KEY) {
    throw new Error('Falta GEMINI_API_KEY (secrets.local.js o variable en Railway).');
  }
  if (!geminiClient) {
    geminiClient = new GoogleGenerativeAI(GEMINI_API_KEY);
  }
  return geminiClient;
}

function normalizarListaModelosGemini(modelos = []) {
  const modelosObsoletos = new Set([
    'gemini-1.5-pro',
    'gemini-1.5-flash',
    'gemini-pro',
    'gemini-pro-vision'
  ]);
  const vistos = new Set();
  const resultado = [];

  for (const modelo of modelos) {
    const limpio = String(modelo || '').trim();
    if (
      !limpio ||
      modelosObsoletos.has(limpio) ||
      vistos.has(limpio) ||
      PATRON_MODELO_EXCLUIDO.test(limpio)
    ) {
      continue;
    }
    vistos.add(limpio);
    resultado.push(limpio);
  }

  return resultado;
}

function ordenarModelosPorPreferencia(modelos) {
  const resto = new Set(modelos);
  const ordenados = [];

  for (const preferido of ORDEN_PREFERENCIA) {
    if (resto.has(preferido)) {
      ordenados.push(preferido);
      resto.delete(preferido);
    }
  }

  for (const modelo of modelos) {
    if (resto.has(modelo)) ordenados.push(modelo);
  }

  return ordenados;
}

async function obtenerModelosGemini() {
  if (modelosCache) return modelosCache;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const desdeApi = (data.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => String(m.name || '').replace(/^models\//, ''))
        .filter(Boolean);

      const normalizados = ordenarModelosPorPreferencia(normalizarListaModelosGemini(desdeApi));
      if (normalizados.length > 0) {
        modelosCache = normalizados;
        console.log(`✅ Gemini: ${normalizados.length} modelos de texto cargados desde Google API`);
        return modelosCache;
      }
    }
  } catch (err) {
    console.warn('⚠️ No se pudo listar modelos Gemini desde API:', err.message);
  }

  modelosCache = ordenarModelosPorPreferencia(normalizarListaModelosGemini(MODELOS_GEMINI_ESTATICOS));
  console.log(`✅ Gemini: usando ${modelosCache.length} modelos de lista estática`);
  return modelosCache;
}

function esErrorRecuperableGemini(error) {
  const msg = String(error?.message || '').toLowerCase();
  return (
    msg.includes('quota') ||
    msg.includes('too many requests') ||
    msg.includes('429') ||
    msg.includes('rate') ||
    msg.includes('rate-limits') ||
    msg.includes('retry in') ||
    msg.includes('overload') ||
    msg.includes('temporarily unavailable') ||
    msg.includes('not found') ||
    msg.includes('404') ||
    (msg.includes('model') && (msg.includes('not found') || msg.includes('unavailable')))
  );
}

module.exports = {
  GEMINI_API_KEY,
  GEMINI_MAX_RETRIES,
  GEMINI_EMBEDDINGS_TIMEOUT_MS,
  getGeminiClient,
  obtenerModelosGemini,
  normalizarListaModelosGemini,
  esErrorRecuperableGemini
};
