const sharp = require('sharp');
const { createWorker } = require('tesseract.js');

function detectarMoneda(texto) {
  const t = texto.toLowerCase();
  if (t.includes('usd') || t.includes('$us') || t.includes('us$')) return 'USD';
  if (t.includes('bob') || t.includes('bs') || t.includes('bs.') || t.includes('bs ')) return 'BOB';
  return null;
}

function normalizarNumeroDecimal(str) {
  if (!str) return null;
  // Quitar espacios y caracteres raros
  let v = String(str).replace(/[^\d.,]/g, '');
  // Si hay más de una coma y un punto, priorizar el último separador decimal
  const lastComma = v.lastIndexOf(',');
  const lastDot = v.lastIndexOf('.');
  let decimalSep = '.';
  if (lastComma > lastDot) decimalSep = ',';
  v = v.replace(new RegExp(`\\${decimalSep}`), '#').replace(/[.,]/g, '').replace('#', '.');
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function extraerMonto(texto) {
  const lines = texto.split(/\n+/);
  const textoLower = texto.toLowerCase();
  // Normalizar espacios múltiples a uno solo para facilitar matching
  const textoNormalizado = texto.replace(/\s+/g, ' ');

  // Prioridad 1: Buscar "Bs 80" o "Bs80" o "Bs. 80" (formato Yape - número entero sin decimales)
  const yapePatterns = [
    /bs\.?\s*(\d{1,6})(?:\s|$|[^0-9.,])/i,  // "Bs 80" o "Bs. 80" seguido de espacio o fin de línea
    /bs\s*(\d{1,6})(?:\s|$|[^0-9.,])/i,     // "Bs80" sin espacio
    /(\d{1,6})\s*bs(?:\s|$|[^0-9.,])/i      // "80 Bs" (orden inverso)
  ];
  
  for (const pattern of yapePatterns) {
    const match = textoNormalizado.match(pattern);
    if (match) {
      const numStr = match[1];
      const n = parseInt(numStr, 10);
      if (!isNaN(n) && n > 0 && n < 1000000) {
        return n;
      }
    }
  }

  // Prioridad 2: Buscar "Bs 2.00" o "Bs2.00" o "Bs. 2.00" (formato altoke con decimales)
  const altokePatterns = [
    /bs\.?\s*([0-9]+[.,]\d{2})/i,
    /bs\.?\s*([0-9]+)\s*[.,]\s*(\d{2})/i,
    /([0-9]+[.,]\d{2})\s*bs/i,
    /bs\s*([0-9]+)\s*\.\s*(\d{2})/i
  ];
  
  for (const pattern of altokePatterns) {
    const match = textoNormalizado.match(pattern);
    if (match) {
      let numStr = match[1];
      if (match[2]) numStr = `${match[1]}.${match[2]}`;
      const n = normalizarNumeroDecimal(numStr);
      if (n !== null && n > 0 && n < 1000000) return n;
    }
  }

  // Prioridad 3: Buscar línea que contenga "Bs" seguido de número (con o sin decimales)
  for (const line of lines) {
    const lineNormalizada = line.replace(/\s+/g, ' ');
    // Buscar "Bs" seguido de número entero o con decimales
    const m = lineNormalizada.match(/bs\.?\s*(\d{1,6}(?:[.,]\d{2})?)(?:\s|$|[^0-9.,])/i);
    if (m) {
      const numStr = m[1];
      // Si tiene decimales, usar normalizarNumeroDecimal; si no, parseInt
      if (numStr.includes('.') || numStr.includes(',')) {
        const n = normalizarNumeroDecimal(numStr);
        if (n !== null && n > 0 && n < 1000000) return n;
      } else {
        const n = parseInt(numStr, 10);
        if (!isNaN(n) && n > 0 && n < 1000000) return n;
      }
    }
    // También buscar con otros labels
    const m2 = lineNormalizada.match(/(?:bob|monto|importe|pago\s+realizado|pago)\s*[:\-]?\s*([0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+[.,]\d{2}|\d{1,6})/i);
    if (m2) {
      const numStr = m2[1];
      if (numStr.includes('.') || numStr.includes(',')) {
        const n = normalizarNumeroDecimal(numStr);
        if (n !== null && n > 0) return n;
      } else {
        const n = parseInt(numStr, 10);
        if (!isNaN(n) && n > 0 && n < 1000000) return n;
      }
    }
  }

  // Prioridad 4: Buscar números con formato decimal (2.00, 2,00, etc.) cerca de "Bs" o "pago"
  const nearBs = textoNormalizado.match(/bs[^0-9]{0,10}([0-9]+[.,]\d{2})/i);
  if (nearBs) {
    const n = normalizarNumeroDecimal(nearBs[1]);
    if (n !== null && n > 0 && n < 1000000) return n;
  }

  // Prioridad 5: Buscar patrón "Bs" seguido de número entero en la misma línea o próxima
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+/g, ' ');
    if (/bs/i.test(line)) {
      // Buscar número entero o con decimales en la misma línea
      const m = line.match(/bs\.?\s*(\d{1,6})/i);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!isNaN(n) && n > 0 && n < 1000000) return n;
      }
      // También buscar con decimales
      const mDec = line.match(/bs\.?\s*([0-9]+[.,]\d{2})/i);
      if (mDec) {
        const n = normalizarNumeroDecimal(mDec[1]);
        if (n !== null && n > 0 && n < 1000000) return n;
      }
      // O en la siguiente línea si existe
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1].replace(/\s+/g, ' ');
        const m2 = nextLine.match(/(\d{1,6})/);
        if (m2) {
          const n = parseInt(m2[1], 10);
          if (!isNaN(n) && n > 0 && n < 1000000) return n;
        }
      }
    }
  }

  // Prioridad 6: Fallback - buscar cualquier número con decimales razonable (último recurso)
  const m2 = textoNormalizado.match(/([0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+[.,]\d{2})/);
  if (m2) {
    const n = normalizarNumeroDecimal(m2[1]);
    if (n !== null && n > 0 && n < 1000000) return n;
  }

  // Prioridad 7: Último fallback - buscar número entero grande cerca de "Bs" o "yapeaste"
  const yapeastePattern = textoNormalizado.match(/(?:yapeaste|yapeaste!|bs)\s*(\d{1,6})/i);
  if (yapeastePattern) {
    const n = parseInt(yapeastePattern[1], 10);
    if (!isNaN(n) && n > 0 && n < 1000000) return n;
  }

  return null;
}

function extraerFecha(texto) {
  // Normalizar espacios múltiples
  const textoNormalizado = texto.replace(/\s+/g, ' ');
  
  // Prioridad 1: Formato Yape "06 ene 2026" o "06 ene. 2026" (mes abreviado)
  const mesesAbreviados = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const mesesAbreviadosCompletos = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  
  // Patrón Yape: "06 ene 2026" o "06 ene. 2026"
  const yapePattern = textoNormalizado.match(/(\d{1,2})\s+(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)\.?\s+(\d{4})/i);
  if (yapePattern) {
    const dia = parseInt(yapePattern[1]);
    const mesAbr = yapePattern[2].toLowerCase();
    const año = yapePattern[3];
    const mesNum = mesesAbreviados.indexOf(mesAbr) + 1;
    if (mesNum > 0 && dia >= 1 && dia <= 31) {
      return `${año}-${String(mesNum).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
    }
  }
  
  // Prioridad 2: Formato DD/MM/YYYY (típico en comprobantes bancarios como altoke: "14/01/2026")
  const r2 = textoNormalizado.match(/(\d{1,2})\s*[-\/.]\s*(\d{1,2})\s*[-\/.]\s*(\d{2,4})/);
  if (r2) {
    const y = r2[3].length === 2 ? `20${r2[3]}` : r2[3];
    const mes = parseInt(r2[2]);
    const dia = parseInt(r2[1]);
    if (mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31) {
      return `${String(y).padStart(4, '0')}-${String(r2[2]).padStart(2, '0')}-${String(r2[1]).padStart(2, '0')}`;
    }
  }
  
  // Prioridad 3: Buscar "Realizado en" seguido de fecha DD/MM/YYYY
  const realizadoEn = textoNormalizado.match(/realizado\s+en\s+(\d{1,2})\s*[-\/.]\s*(\d{1,2})\s*[-\/.]\s*(\d{2,4})/i);
  if (realizadoEn) {
    const y = realizadoEn[3].length === 2 ? `20${realizadoEn[3]}` : realizadoEn[3];
    const mes = parseInt(realizadoEn[2]);
    const dia = parseInt(realizadoEn[1]);
    if (mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31) {
      return `${String(y).padStart(4, '0')}-${String(realizadoEn[2]).padStart(2, '0')}-${String(realizadoEn[1]).padStart(2, '0')}`;
    }
  }
  
  // Prioridad 4: Formato YYYY-MM-DD o YYYY/MM/DD
  const r1 = textoNormalizado.match(/(\d{4})\s*[-\/.]\s*(\d{1,2})\s*[-\/.]\s*(\d{1,2})/);
  if (r1) {
    const mes = parseInt(r1[2]);
    const dia = parseInt(r1[3]);
    if (mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31) {
      return `${r1[1].padStart(4, '0')}-${String(r1[2]).padStart(2, '0')}-${String(r1[3]).padStart(2, '0')}`;
    }
  }
  
  // Prioridad 5: Fecha en texto completo (ej: "14 de enero de 2026")
  const m3 = textoNormalizado.toLowerCase().match(new RegExp(`(\\d{1,2})\\s+(?:de\\s+)?(${mesesAbreviadosCompletos.join('|')})\\s+(\\d{4})`));
  if (m3) {
    const mesNum = mesesAbreviadosCompletos.indexOf(m3[2]) + 1;
    if (mesNum > 0) {
      return `${m3[3]}-${String(mesNum).padStart(2, '0')}-${String(m3[1]).padStart(2, '0')}`;
    }
  }
  
  return null;
}

function extraerBanco(texto) {
  const bancos = [
    // Apps de pago móvil (prioridad alta)
    { pattern: /\byape\b/i, nombre: 'Yape' },
    { pattern: /\btigo\s+money\b/i, nombre: 'Tigo Money' },
    { pattern: /\bmovil\s+pay\b/i, nombre: 'Móvil Pay' },
    // Bancos tradicionales
    { pattern: /banco\s+uni[oó]n/i, nombre: 'Banco Unión' },
    { pattern: /banco\s+nacional\s+de\s+bolivia|bnb/i, nombre: 'Banco Nacional de Bolivia' },
    { pattern: /banco\s+mercantil\s+santa\s+cruz/i, nombre: 'Banco Mercantil Santa Cruz' },
    { pattern: /\bbcp\b/i, nombre: 'BCP' },
    { pattern: /bancosol/i, nombre: 'Bancosol' },
    { pattern: /eco\s+futuro/i, nombre: 'Eco Futuro' },
    { pattern: /prodem/i, nombre: 'Prodem' },
    { pattern: /\bbisa\b/i, nombre: 'BISA' },
    { pattern: /\bfie\b/i, nombre: 'FIE' },
    { pattern: /futuro\s+de\s+bolivia/i, nombre: 'Futuro de Bolivia' },
    { pattern: /banco\s+ganadero/i, nombre: 'Banco Ganadero' },
    { pattern: /banco\s+solidario\s+s\.?\s*a\.?/i, nombre: 'Banco Solidario S.A.' },
    { pattern: /banco\s+solidario/i, nombre: 'Banco Solidario' }
  ];
  
  // Normalizar espacios múltiples para facilitar matching
  const textoNormalizado = texto.replace(/\s+/g, ' ');
  
  // Buscar cada banco/app con su patrón
  for (const banco of bancos) {
    if (banco.pattern.test(textoNormalizado)) {
      return banco.nombre;
    }
  }
  
  return null;
}

function extraerReferencia(texto) {
  const labels = ['referencia', 'n°', 'numero', 'nro', 'comprobante', 'transacción', 'transaccion', 'transaccion', 'id'];
  const lines = texto.split(/\n+/);
  const textoNormalizado = texto.replace(/\s+/g, ' ');
  
  // Prioridad 1: Formato Yape "Nro. de transacción: 489944591" o "Nro de transacción: 489944591"
  const yapeTransPattern = textoNormalizado.match(/nro\.?\s*(?:de\s+)?transacci[oó]n\s*:?\s*(\d{6,})/i);
  if (yapeTransPattern) {
    return yapeTransPattern[1];
  }
  
  // Prioridad 2: Buscar patrón específico de altoke: "14012026/295/140/596/2084" o variaciones
  const altokePatterns = [
    /(\d{8}\/\d+\/\d+\/\d+\/\d+)/,
    /(\d{8}\s*\/\s*\d+\s*\/\s*\d+\s*\/\s*\d+\s*\/\s*\d+)/,
    /transacci[oó]n\s*(\d{8}\/\d+\/\d+\/\d+\/\d+)/i
  ];
  
  for (const pattern of altokePatterns) {
    const match = textoNormalizado.match(pattern);
    if (match) {
      return match[1].replace(/\s+/g, ''); // Limpiar espacios
    }
  }
  
  // Prioridad 3: Buscar por labels seguidos de número
  for (const line of lines) {
    const lineNormalizada = line.replace(/\s+/g, ' ');
    const l = lineNormalizada.toLowerCase();
    if (labels.some(k => l.includes(k))) {
      // Buscar números con formato de referencia (al menos 8 caracteres alfanuméricos con /)
      const m = lineNormalizada.match(/([A-Za-z0-9\/\-]{8,})/);
      if (m) {
        const ref = m[1].trim();
        // Verificar que tenga al menos un / para ser una referencia válida
        if (ref.includes('/') && ref.length >= 10) {
          return ref;
        }
      }
      // También buscar números simples después de "transacción" o "nro"
      if (l.includes('transaccion') || l.includes('nro')) {
        const numMatch = lineNormalizada.match(/(\d{6,})/);
        if (numMatch) {
          return numMatch[1];
        }
      }
    }
  }
  
  // Prioridad 4: Buscar cualquier patrón que parezca número de transacción (formato con /)
  const transaccionPattern = textoNormalizado.match(/(\d{6,}\/\d+\/\d+\/\d+\/\d+)/);
  if (transaccionPattern) {
    return transaccionPattern[1];
  }
  
  // Fallback: buscar cualquier secuencia larga alfanumérica con /
  const m2 = textoNormalizado.match(/([A-Za-z0-9\/\-]{12,})/);
  return m2 ? m2[1] : null;
}

function extraerEmisor(texto) {
  const labels = ['cliente', 'titular', 'emisor', 'remitente', 'de'];
  const lines = texto.split(/\n+/);
  
  const limpiarNombre = (s) => {
    if (!s) return null;
    const limpio = String(s)
      .replace(/\d+/g, ' ')
      .replace(/[*_~`´^"'|<>]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // Evitar falsos positivos muy cortos
    return limpio.length >= 5 ? limpio : null;
  };

  // Buscar línea que contenga "De" (con o sin ":") y nombre en la misma o siguiente línea (altoke)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const l = line.toLowerCase();
    const esLabelDe = /^\s*de\s*:?\s*$/i.test(line) || /^\s*de\s+/.test(l) || l.includes('de:');
    if (!esLabelDe) continue;

    // 1) Nombre en la misma línea: "De DANIA MEDRANO HERBAS" o "De: DANIA..."
    const mMisma = line.match(/^\s*de\s*:?\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s]{3,})\s*$/i);
    const misma = limpiarNombre(mMisma?.[1]);
    if (misma) return misma;

    // 2) Nombre en la siguiente línea: línea actual solo "De" y luego nombre
    const nextLine = i + 1 < lines.length ? lines[i + 1] : '';
    const mSiguiente = nextLine.match(/^\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s]{3,})\s*$/);
    const sig = limpiarNombre(mSiguiente?.[1]);
    if (sig) return sig;
  }
  
  // Fallback: buscar por labels tradicionales
  for (const line of lines) {
    const l = line.toLowerCase();
    if (labels.some(k => l.includes(k))) {
      const m = line.match(/([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑ\s]{5,})/);
      if (m) {
        const nombre = limpiarNombre(m[1]);
        if (nombre) return nombre;
      }
    }
  }
  return null;
}

function extraerReceptor(texto) {
  const labels = ['beneficiario', 'destinatario', 'receptor', 'para', 'realizado por'];
  const lines = texto.split(/\n+/);
  
  const limpiarNombre = (s) => {
    if (!s) return null;
    const limpio = String(s)
      .replace(/\d+/g, ' ')
      .replace(/[*_~`´^"'|<>]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return limpio.length >= 5 ? limpio : null;
  };

  // Prioridad 1: Formato Yape "Realizado por: WILSON CARVAJAL HINOJOSA"
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const l = line.toLowerCase();
    if (l.includes('realizado por:')) {
      const match = line.match(/realizado\s+por\s*:?\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s]{5,})/i);
      if (match && match[1]) {
        const nombre = limpiarNombre(match[1]);
        if (nombre) return nombre;
      }
      // Si está en la siguiente línea
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        const mNext = nextLine.match(/^([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s]{5,})/);
        if (mNext) {
          const nombre = limpiarNombre(mNext[1]);
          if (nombre) return nombre;
        }
      }
    }
  }

  // Prioridad 2: Buscar línea que contenga "Para" (con o sin ":") y nombre en la misma o siguiente línea (altoke)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const l = line.toLowerCase();
    const esLabelPara = /^\s*para\s*:?\s*$/i.test(line) || /^\s*para\s+/.test(l) || l.includes('para:');
    if (!esLabelPara) continue;

    // 1) Nombre en la misma línea: "Para CANAVIRI..." o "Para: CANAVIRI..."
    const mMisma = line.match(/^\s*para\s*:?\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s]{3,})\s*$/i);
    const misma = limpiarNombre(mMisma?.[1]);
    if (misma) return misma;

    // 2) Nombre en la siguiente línea: línea actual solo "Para" y luego nombre
    const nextLine = i + 1 < lines.length ? lines[i + 1] : '';
    const mSiguiente = nextLine.match(/^\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s]{3,})\s*$/);
    const sig = limpiarNombre(mSiguiente?.[1]);
    if (sig) return sig;
  }
  
  // Fallback: buscar por labels tradicionales
  for (const line of lines) {
    const l = line.toLowerCase();
    if (labels.some(k => l.includes(k))) {
      const m = line.match(/([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑ\s]{5,})/);
      if (m) {
        const nombre = limpiarNombre(m[1]);
        if (nombre) return nombre;
      }
    }
  }
  return null;
}

function extraerCuentaPorEtiqueta(texto, etiquetaRegex) {
  const lines = String(texto || '').split(/\n+/);
  const textoNormalizado = texto.replace(/\s+/g, ' ').toLowerCase();
  
  const limpiarValor = (s) => {
    if (!s) return null;
    const v = String(s)
      .replace(/[*_~`´^"'|<>]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (v.length < 4) return null;
    // Evitar devolver solo la etiqueta
    if (/^cuenta\s+(origen|destino)$/i.test(v)) return null;
    return v;
  };

  // Buscar la línea que contiene la etiqueta
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLower = line.toLowerCase();
    
    // Verificar si la línea contiene la etiqueta
    if (!etiquetaRegex.test(lineLower)) continue;

    // Caso 1: "Cuenta origen: NOMBRE COMPLETO" (todo en la misma línea después de ":")
    const mSame = line.match(new RegExp(`${etiquetaRegex.source}\\s*:?\\s*(.+)$`, 'i'));
    if (mSame && mSame[1]) {
      const same = limpiarValor(mSame[1]);
      if (same) {
        // Intentar capturar también la siguiente línea si contiene banco/número
        if (i + 1 < lines.length) {
          const nextLine = lines[i + 1];
          // Si la siguiente línea contiene banco o número de cuenta, concatenarla
          if (/banco|bancosol|bcp|bisa|fie|ganadero|solidario|un[ií]on|prodem|eco\s+futuro|futuro\s+de\s+bolivia|\d{4,}/i.test(nextLine)) {
            const nextPart = limpiarValor(nextLine);
            if (nextPart) {
              return `${same} ${nextPart}`;
            }
          }
        }
        return same;
      }
    }

    // Caso 2: "Cuenta origen:" en una línea, valor en la siguiente
    if (/^cuenta\s+(?:de\s+)?(?:origen|destino)\s*:?\s*$/i.test(line)) {
      const partes = [];
      // Capturar las siguientes 2-3 líneas que contengan información
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const nextLine = lines[j];
        // Si la línea está vacía o es otra etiqueta, parar
        if (!nextLine.trim() || /cuenta\s+(?:de\s+)?(?:origen|destino)/i.test(nextLine)) break;
        
        const val = limpiarValor(nextLine);
        if (val) partes.push(val);
      }
      if (partes.length > 0) {
        return partes.join(' ');
      }
    }

    // Caso 3: "Cuenta origen Nombre" (sin dos puntos, en la misma línea)
    const mInline = line.match(new RegExp(`${etiquetaRegex.source}\\s+(.+)$`, 'i'));
    if (mInline && mInline[1]) {
      const inline = limpiarValor(mInline[1]);
      if (inline) {
        // También intentar capturar la siguiente línea si tiene banco/número
        if (i + 1 < lines.length) {
          const nextLine = lines[i + 1];
          if (/banco|bancosol|bcp|bisa|fie|ganadero|solidario|un[ií]on|\d{4,}/i.test(nextLine)) {
            const nextPart = limpiarValor(nextLine);
            if (nextPart) {
              return `${inline} ${nextPart}`;
            }
          }
        }
        return inline;
      }
    }
  }
  
  return null;
}

function extraerCuentaOrigen(texto) {
  const lines = String(texto || '').split(/\n+/);
  const textoNormalizado = texto.replace(/\s+/g, ' ');
  
  // Prioridad 1: Formato Yape "Cuenta: 67144150" (número de cuenta)
  const yapeCuenta = textoNormalizado.match(/cuenta\s*:?\s*(\d{6,})/i);
  if (yapeCuenta) {
    return yapeCuenta[1];
  }
  
  // Prioridad 2: Buscar en líneas específicas para Yape
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const l = line.toLowerCase();
    if (l.includes('cuenta:') && !l.includes('destino')) {
      const match = line.match(/cuenta\s*:?\s*(.+)/i);
      if (match && match[1]) {
        const valor = match[1].trim();
        // Si es un número, devolverlo; si es nombre, también
        if (valor.length >= 4) {
          return valor;
        }
      }
      // Si la siguiente línea tiene el valor
      if (i + 1 < lines.length) {
        const nextVal = lines[i + 1].trim();
        if (nextVal.length >= 4) {
          return nextVal;
        }
      }
    }
  }
  
  // Prioridad 3: Variantes comunes en comprobantes bancarios: "Cuenta origen", "Cuenta de origen"
  return (
    extraerCuentaPorEtiqueta(texto, /cuenta\s+(?:de\s+)?origen/i) ||
    extraerCuentaPorEtiqueta(texto, /origen\s+de\s+cuenta/i)
  );
}

function extraerCuentaDestino(texto) {
  const lines = String(texto || '').split(/\n+/);
  const textoNormalizado = texto.replace(/\s+/g, ' ');
  
  // Prioridad 1: Formato Yape "Destino: Yape" o "Destino: Nombre"
  const yapeDestino = textoNormalizado.match(/destino\s*:?\s*([a-záéíóúñ\s]{3,}|\d{6,})/i);
  if (yapeDestino) {
    const destino = yapeDestino[1].trim();
    // Si es "Yape" o un nombre, devolverlo; si es solo número, puede ser cuenta
    if (destino.length >= 3 && !/^\d+$/.test(destino) || destino.toLowerCase() === 'yape') {
      return destino;
    }
  }
  
  // Prioridad 2: Buscar en líneas específicas para Yape
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const l = line.toLowerCase();
    if (l.includes('destino:')) {
      const match = line.match(/destino\s*:?\s*(.+)/i);
      if (match && match[1]) {
        const valor = match[1].trim();
        if (valor.length >= 3) {
          return valor;
        }
      }
      // Si la siguiente línea tiene el valor
      if (i + 1 < lines.length) {
        const nextVal = lines[i + 1].trim();
        if (nextVal.length >= 3) {
          return nextVal;
        }
      }
    }
  }
  
  // Prioridad 3: Variantes comunes en comprobantes bancarios: "Cuenta destino", "Cuenta de destino"
  return (
    extraerCuentaPorEtiqueta(texto, /cuenta\s+(?:de\s+)?destino/i) ||
    extraerCuentaPorEtiqueta(texto, /destino\s+de\s+cuenta/i)
  );
}

function estimarConfianza(texto, campos) {
  const len = (texto || '').length;
  const filled = Object.values(campos).filter(v => v !== null && v !== '').length;
  if (len > 500 && filled >= 4) return 'alta';
  if (len > 200 && filled >= 2) return 'media';
  return 'baja';
}

async function ocrBuffer(buffer) {
  // Preprocesamiento más agresivo para mejorar legibilidad
  // Intentar múltiples estrategias de preprocesamiento
  let prepro;
  try {
    prepro = await sharp(buffer)
      .rotate() // Auto-rotar si es necesario
      .resize(2500, null, { fit: 'inside', withoutEnlargement: false }) // Aumentar resolución
      .greyscale()
      .normalise()
      .sharpen({ sigma: 1.8, m1: 0.5, m2: 0.5, x1: 2, y2: 10, y3: 20 }) // Sharpen más agresivo
      .linear(1.3, -(128 * 0.3)) // Aumentar contraste más
      .toColourspace('b-w')
      .threshold(150) // Umbral más bajo para capturar texto más claro
      .toBuffer();
  } catch (e) {
    console.warn('⚠️ Error en preprocesamiento sharp, usando buffer original:', e.message);
    prepro = buffer;
  }
  
  // En tesseract.js v7, se especifica el idioma directamente en createWorker
  // createWorker(lang, oem, options)
  // lang: 'spa+eng' para español e inglés
  // oem: 1 para LSTM OCR Engine
  const worker = await createWorker('spa+eng', 1, {
    logger: (m) => {
      // Solo loggear progreso si es importante
      if (m.status === 'recognizing text') {
        console.log(`🔄 OCR progreso: ${Math.round(m.progress * 100)}%`);
      }
    }
  });
  
  try {
    // Configurar parámetros más permisivos para OCR
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzÁÉÍÓÚÑáéíóúñ:/.- Bs$',
      preserve_interword_spaces: '1',
      tessedit_pageseg_mode: '6' // Asumir bloque uniforme de texto
    });
    
    const { data } = await worker.recognize(prepro);
    
    // Limpiar texto OCR: eliminar caracteres raros pero mantener estructura importante
    let textoLimpio = (data.text || '');
    
    // Mantener caracteres importantes para comprobantes
    textoLimpio = textoLimpio.replace(/[^\w\sÁÉÍÓÚÑáéíóúñ:/\-.,Bs$]/g, ' ');
    
    // Normalizar espacios múltiples pero mantener saltos de línea importantes
    textoLimpio = textoLimpio.replace(/[ \t]+/g, ' ').trim();
    
    // Log del texto limpio para debugging
    console.log(`📝 Texto OCR limpio (${textoLimpio.length} chars, primeros 400): "${textoLimpio.substring(0, 400)}${textoLimpio.length > 400 ? '...' : ''}"`);
    
    return textoLimpio;
  } catch (error) {
    console.error('❌ Error durante reconocimiento OCR:', error.message);
    throw error;
  } finally {
    await worker.terminate();
  }
}

async function extraerDesdeImagenBuffer(buffer) {
  let texto = '';
  try {
    console.log('🔄 Iniciando procesamiento OCR...');
    texto = await ocrBuffer(buffer);
    console.log(`✅ Texto OCR extraído exitosamente (${texto.length} caracteres)`);
    if (texto.length > 0) {
      console.log(`📄 Primeros 300 caracteres: "${texto.substring(0, 300)}${texto.length > 300 ? '...' : ''}"`);
    } else {
      console.warn('⚠️ El OCR no extrajo ningún texto. La imagen puede estar muy borrosa o no contener texto legible.');
    }
  } catch (e) {
    console.error('❌ Error en OCR:', e.message);
    console.error('Stack:', e.stack);
    texto = '';
  }
  
  const moneda = detectarMoneda(texto);
  const monto = extraerMonto(texto);
  const fecha = extraerFecha(texto);
  const banco = extraerBanco(texto);
  const ref = extraerReferencia(texto);
  const emisor = extraerEmisor(texto);
  const receptor = extraerReceptor(texto);
  const cuentaOrigen = extraerCuentaOrigen(texto);
  const cuentaDestino = extraerCuentaDestino(texto);
  
  console.log(`🔍 Datos extraídos: monto=${monto || 'null'}, moneda=${moneda || 'null'}, fecha=${fecha || 'null'}, banco=${banco || 'null'}, ref=${ref || 'null'}, emisor=${emisor || 'null'}, receptor=${receptor || 'null'}, cuentaOrigen=${cuentaOrigen || 'null'}, cuentaDestino=${cuentaDestino || 'null'}`);
  
  const confianza = estimarConfianza(texto, { moneda, monto, fecha, banco, ref, emisor, receptor, cuentaOrigen, cuentaDestino });
  const obs = [];
  if (!texto || texto.length < 50) obs.push('texto OCR limitado');
  if (!monto) obs.push('monto no claro');
  if (!fecha) obs.push('fecha no clara');
  if (!banco) obs.push('banco no detectado');
  if (!ref) obs.push('referencia no detectada');
  if (!cuentaOrigen) obs.push('cuenta origen no detectada');
  if (!cuentaDestino) obs.push('cuenta destino no detectada');
  
  return {
    tipo_documento: 'comprobante_pago',
    monto_detectado: monto ?? null,
    moneda: moneda ?? null,
    fecha_detectada: fecha ?? null,
    banco_detectado: banco ?? null,
    numero_comprobante_detectado: ref ?? null,
    // Mantener compatibilidad, pero priorizar cuenta origen/destino cuando existan
    emisor_detectado: (cuentaOrigen || emisor) ?? null,
    receptor_detectado: (cuentaDestino || receptor) ?? null,
    cuenta_origen_detectado: cuentaOrigen ?? null,
    cuenta_destino_detectado: cuentaDestino ?? null,
    confianza_extraccion: confianza,
    observaciones: obs.join('; ') || 'Datos extraídos correctamente'
  };
}

async function extraerDesdePDFBuffer(buffer) {
  const pdfParse = require('pdf-parse');
  const data = await pdfParse(buffer);
  const texto = (data.text || '').replace(/\s+/g, ' ').trim();
  const moneda = detectarMoneda(texto);
  const monto = extraerMonto(texto);
  const fecha = extraerFecha(texto);
  const banco = extraerBanco(texto);
  const ref = extraerReferencia(texto);
  const emisor = extraerEmisor(texto);
  const receptor = extraerReceptor(texto);
  const cuentaOrigen = extraerCuentaOrigen(texto);
  const cuentaDestino = extraerCuentaDestino(texto);
  const confianza = estimarConfianza(texto, { moneda, monto, fecha, banco, ref, emisor, receptor, cuentaOrigen, cuentaDestino });
  const obs = [];
  if (!texto || texto.length < 50) obs.push('texto PDF limitado');
  if (!monto) obs.push('monto no claro');
  if (!fecha) obs.push('fecha no clara');
  return {
    tipo_documento: 'comprobante_pago',
    monto_detectado: monto ?? null,
    moneda: moneda ?? null,
    fecha_detectada: fecha ?? null,
    banco_detectado: banco ?? null,
    numero_comprobante_detectado: ref ?? null,
    emisor_detectado: (cuentaOrigen || emisor) ?? null,
    receptor_detectado: (cuentaDestino || receptor) ?? null,
    cuenta_origen_detectado: cuentaOrigen ?? null,
    cuenta_destino_detectado: cuentaDestino ?? null,
    confianza_extraccion: confianza,
    observaciones: obs.join('; ')
  };
}

module.exports = { extraerDesdeImagenBuffer, extraerDesdePDFBuffer };
