'use strict';

require('dotenv').config();

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const pdfParse = require('pdf-parse');
const { CONFIG } = require('./config');

// ══════════════════════════════════════════════════════════════
//  UTILIDADES
// ══════════════════════════════════════════════════════════════

const timestamp = () =>
  new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const log = {
  info:  (...a) => console.log(`[${timestamp()}] ℹ️  `, ...a),
  ok:    (...a) => console.log(`[${timestamp()}] ✅ `, ...a),
  warn:  (...a) => console.warn(`[${timestamp()}] ⚠️  `, ...a),
  error: (...a) => console.error(`[${timestamp()}] ❌ `, ...a),
  ai:    (...a) => console.log(`[${timestamp()}] 🧠 `, ...a),
};

if (!CONFIG.GROQ_API_KEY) {
  log.error('¡Falta la GROQ_API_KEY! Asegurate de ponerla en tu archivo .env');
  process.exit(1);
}

// ══════════════════════════════════════════════════════════════
//  SEGURIDAD: WHITELIST DE NÚMEROS AUTORIZADOS
// ══════════════════════════════════════════════════════════════

/**
 * Solo los números en esta lista pueden usar el bot.
 * Formato: código de país + número sin espacios + @c.us
 * Ejemplo Argentina: '5493816123456@c.us'
 * Dejá el array vacío [] para deshabilitar la restricción (NO recomendado).
 */
const NUMEROS_AUTORIZADOS = new Set(CONFIG.WHITELIST || []);

const estaAutorizado = (chatId) => {
  if (NUMEROS_AUTORIZADOS.size === 0) return true; // Sin restricción si la lista está vacía
  return NUMEROS_AUTORIZADOS.has(chatId);
};

// ══════════════════════════════════════════════════════════════
//  GESTIÓN DE SESIONES
// ══════════════════════════════════════════════════════════════

/** @type {Map<string, { history: Array, lastActivity: number, pendingMedia: object|null }>} */
const sesiones = new Map();

const obtenerSesion = (chatId) => {
  if (!sesiones.has(chatId)) {
    sesiones.set(chatId, {
      history: [{ role: 'system', content: CONFIG.SYSTEM_PROMPT }],
      lastActivity: Date.now(),
      pendingMedia: null, // Guarda el último archivo/imagen para reenvío
    });
  }
  const s = sesiones.get(chatId);
  s.lastActivity = Date.now();
  return s;
};

setInterval(() => {
  const ahora = Date.now();
  let n = 0;
  for (const [id, s] of sesiones) {
    if (ahora - s.lastActivity > CONFIG.SESSION_TIMEOUT_MS) {
      sesiones.delete(id);
      n++;
    }
  }
  if (n > 0) log.info(`Contextos expirados eliminados: ${n}`);
}, CONFIG.CLEANUP_INTERVAL_MS);

// ══════════════════════════════════════════════════════════════
//  DETECCIÓN INTELIGENTE: ¿NECESITA BÚSQUEDA WEB?
// ══════════════════════════════════════════════════════════════

/**
 * Detecta si la consulta realmente necesita información de internet.
 * Evita llamadas innecesarias a Tavily para preguntas de contexto local.
 */
const PATRONES_SIN_BUSQUEDA = [
  /^(resume|resumí|resumime|anali[zs]a|explicame|qué dice|qué ves|transcrib)/i,
  /^(qué dijiste|antes dijiste|recordás|cuál fue|repet[ií])/i,
  /^(modific[aá]|corregí|mejorá|reescrib[ií]|traducí|traduc[eé])/i,
  /^\//, // Cualquier comando con /
];

const necesitaBusquedaWeb = (texto) => {
  if (!texto || texto.length < 10) return false;
  if (PATRONES_SIN_BUSQUEDA.some(p => p.test(texto))) return false;

  // Palabras clave que SÍ sugieren búsqueda
  const KEYWORDS_BUSQUEDA = [
    'hoy', 'ahora', 'últimas', 'noticias', 'precio', 'cotización',
    'dólar', 'tiempo', 'clima', 'temperatura', 'quién es', 'qué es',
    'cuándo fue', 'estreno', 'resultado', 'partido', 'elecciones',
    'lanzamiento', 'nueva versión', 'actualización',
  ];
  return KEYWORDS_BUSQUEDA.some(kw => texto.toLowerCase().includes(kw));
};

// ══════════════════════════════════════════════════════════════
//  BÚSQUEDA WEB (TAVILY AI)
// ══════════════════════════════════════════════════════════════

async function buscarEnWeb(query) {
  if (!process.env.TAVILY_API_KEY) return "";
  if (!necesitaBusquedaWeb(query)) {
    log.info('Búsqueda omitida (no necesaria para esta consulta).');
    return "";
  }

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query,
        max_results: 3,
        search_depth: "basic",
        include_answer: true,
      }),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    if (data.answer) return `Resumen directo de la web: ${data.answer}`;
    if (!data.results?.length) return "";
    return data.results.map(r => `Fuente: ${r.url} | Info: ${r.content}`).join('\n');
  } catch (error) {
    log.error('Error en búsqueda con Tavily:', error.message);
    return "";
  }
}

// ══════════════════════════════════════════════════════════════
//  FUNCIONES MULTIMEDIA
// ══════════════════════════════════════════════════════════════

// 1. Análisis de Imágenes (Visión con Groq Llama 3.2 11B)
async function analizarImagenGroq(sesion, media, textoUsuario) {
  const base64Data = `data:${media.mimetype};base64,${media.data}`;
  const promptText = textoUsuario || "Analizá esta imagen detalladamente e indicame qué ves. Si hay texto, transcribilo.";

  const mensajesVision = [
    {
      role: 'user',
      content: [
        { type: 'text', text: `${CONFIG.SYSTEM_PROMPT}\n\nInstrucción del usuario: ${promptText}` },
        { type: 'image_url', image_url: { url: base64Data } },
      ],
    },
  ];

  try {
    const response = await fetch(CONFIG.GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.2-11b-vision-preview',
        messages: mensajesVision,
        max_tokens: 1024,
      }),
    });

    if (!response.ok) {
      const errData = await response.text();
      throw new Error(`HTTP ${response.status} - ${errData}`);
    }

    const data = await response.json();
    const respuestaAI = data.choices?.[0]?.message?.content || 'No pude procesar la imagen.';

    // Guardamos en historial como texto plano para mantener contexto
    sesion.history.push({ role: 'user', content: `[Imagen enviada] Prompt: ${promptText}` });
    sesion.history.push({ role: 'assistant', content: respuestaAI });

    return respuestaAI;
  } catch (error) {
    log.error('Error en Groq Visión:', error.message);
    return '😅 Tuve un problema al intentar analizar esa imagen.';
  }
}

// 2. Generación de Imágenes (Pollinations AI)
async function generarImagen(prompt) {
  try {
    const seed = Math.floor(Math.random() * 100000);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${seed}`;
    log.ai(`Solicitando imagen a Pollinations: ${url}`);
    const media = await MessageMedia.fromUrl(url, { unsafeMime: true });
    return media;
  } catch (error) {
    log.error('Error generando imagen con Pollinations:', error.message);
    return null;
  }
}

// 3. Procesamiento de Documentos (PDF y texto plano)
async function procesarDocumentoTexto(media) {
  try {
    const buffer = Buffer.from(media.data, 'base64');

    if (media.mimetype === 'application/pdf') {
      let pdfData;
      if (typeof pdfParse === 'function') {
        pdfData = await pdfParse(buffer);
      } else if (pdfParse && typeof pdfParse.default === 'function') {
        pdfData = await pdfParse.default(buffer);
      } else {
        return { error: "Librería pdf-parse mal configurada. Ejecutá: npm install pdf-parse@1.1.1" };
      }

      if (!pdfData.text?.trim()) {
        return { error: "El PDF parece estar vacío o es una imagen escaneada sin texto seleccionable." };
      }
      return { contenido: pdfData.text };
    }

    const mimetypesValidos = ['text/plain', 'application/json', 'text/csv', 'text/markdown', 'application/javascript'];
    if (!mimetypesValidos.includes(media.mimetype) && !media.mimetype.startsWith('text/')) {
      return { error: "Solo puedo procesar PDFs o archivos de texto (.txt, .json, .csv, .md, .js)." };
    }

    return { contenido: buffer.toString('utf-8') };
  } catch (error) {
    log.error('Error procesando archivo:', error.message);
    return { error: "No logré extraer el contenido de este archivo." };
  }
}

// ══════════════════════════════════════════════════════════════
//  INTEGRACIÓN CON GROQ (TEXTO Y AUDIO)
// ══════════════════════════════════════════════════════════════

async function consultarGroq(sesion, textoUsuario, infoReal) {
  sesion.history.push({ role: 'user', content: textoUsuario });

  // Recortamos el historial manteniendo siempre el system prompt (índice 0)
  if (sesion.history.length > CONFIG.MAX_HISTORY_LENGTH + 1) {
    sesion.history = [sesion.history[0], ...sesion.history.slice(-CONFIG.MAX_HISTORY_LENGTH)];
  }

  const mensajesParaGroq = [...sesion.history];

  if (infoReal) {
    // Insertamos el contexto web ANTES del último mensaje del usuario
    mensajesParaGroq.splice(-1, 0, {
      role: 'system',
      content: `Contexto extraído de internet en tiempo real:\n${infoReal}`,
    });
  }

  try {
    const response = await fetch(CONFIG.GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: CONFIG.GROQ_MODEL,
        messages: mensajesParaGroq,
      }),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    const respuestaAI = data.choices?.[0]?.message?.content;

    if (!respuestaAI) throw new Error('Respuesta vacía de Groq');

    sesion.history.push({ role: 'assistant', content: respuestaAI });
    return respuestaAI;
  } catch (error) {
    log.error('Error conectando con Groq:', error.message);
    sesion.history.pop();
    return '😅 Tuve un problema de conexión al procesar tu consulta. Intentá de nuevo.';
  }
}

async function transcribirAudio(media) {
  try {
    const buffer = Buffer.from(media.data, 'base64');
    const blob = new Blob([buffer], { type: media.mimetype });

    const formData = new FormData();
    formData.append('file', blob, 'audio.ogg');
    formData.append('model', CONFIG.GROQ_AUDIO_MODEL);

    const response = await fetch(CONFIG.GROQ_AUDIO_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}` },
      body: formData,
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return data.text;
  } catch (error) {
    log.error('Error transcribiendo audio:', error.message);
    throw error;
  }
}

// ══════════════════════════════════════════════════════════════
//  PROCESADOR DE COMANDOS ESPECIALES
// ══════════════════════════════════════════════════════════════

/**
 * Devuelve true si el mensaje fue manejado como comando especial.
 * Comandos disponibles:
 *   /img <prompt>             → Genera una imagen con Pollinations AI
 *   /reenviar <número> <msg>  → Reenvía un mensaje de texto a otro número
 *   /enviararchivo <número>   → Reenvía el último archivo recibido a otro número
 *   /ayuda                    → Lista de comandos disponibles
 */
async function procesarComando(msg, sesion, chatId) {
  const texto = msg.body?.trim() || '';
  if (!texto.startsWith('/')) return false;

  const partes = texto.split(' ');
  const comando = partes[0].toLowerCase();

  // /ayuda
  if (comando === '/ayuda') {
    const menu = [
      '📋 *Comandos disponibles:*',
      '',
      '🎨 */img <prompt>* — Genera una imagen',
      '   Ej: `/img un atardecer en Tucumán estilo acuarela`',
      '',
      '📤 */reenviar <número> <mensaje>* — Manda un texto a otro número',
      '   Ej: `/reenviar 5493816123456 Hola, te mando esto`',
      '',
      '📎 */enviararchivo <número>* — Reenvía el último archivo/imagen que me mandaste',
      '   Ej: `/enviararchivo 5493816123456`',
      '',
      '❓ */ayuda* — Muestra este menú',
    ].join('\n');
    await msg.reply(menu);
    return true;
  }

  // /img <prompt>
  if (comando === '/img') {
    const promptImagen = partes.slice(1).join(' ').trim();
    if (!promptImagen) {
      await msg.reply('⚠️ Escribí un prompt. Ejemplo: `/img un gato cibernético con lentes`');
      return true;
    }

    log.ai(`Generando imagen: "${promptImagen}"`);
    await msg.reply('⏳ Generando imagen, un momento...');
    const imagenMedia = await generarImagen(promptImagen);

    if (imagenMedia) {
      // Guardamos la imagen generada como pendingMedia para posible reenvío
      sesion.pendingMedia = { media: imagenMedia, filename: 'imagen_generada.jpg' };
      sesion.history.push({ role: 'user', content: `[Solicitud de imagen] Prompt: "${promptImagen}"` });
      sesion.history.push({ role: 'assistant', content: `[Imagen generada con el prompt: "${promptImagen}"]` });
      await client.sendMessage(chatId, imagenMedia, { caption: `🎨 Imagen generada: *${promptImagen}*` });
    } else {
      await msg.reply('❌ No pude generar la imagen. Probá con otro prompt o intentá más tarde.');
    }
    return true;
  }

  // /reenviar <número> <mensaje>
  if (comando === '/reenviar') {
    const numero = partes[1];
    const mensajeAReenviar = partes.slice(2).join(' ').trim();

    if (!numero || !mensajeAReenviar) {
      await msg.reply('⚠️ Uso: `/reenviar <número> <mensaje>`\nEjemplo: `/reenviar 5493816123456 Hola!`');
      return true;
    }

    const destinatario = `${numero}@c.us`;
    try {
      await client.sendMessage(destinatario, mensajeAReenviar);
      await msg.reply(`✅ Mensaje enviado a *${numero}*`);
      log.ok(`Mensaje reenviado a ${destinatario}`);
    } catch (err) {
      log.error(`Error al reenviar mensaje a ${destinatario}:`, err.message);
      await msg.reply(`❌ No pude enviar el mensaje a ${numero}. Verificá que el número sea correcto (con código de país).`);
    }
    return true;
  }

  // /enviararchivo <número>
  if (comando === '/enviararchivo') {
    const numero = partes[1];

    if (!numero) {
      await msg.reply('⚠️ Uso: `/enviararchivo <número>`\nEjemplo: `/enviararchivo 5493816123456`');
      return true;
    }

    if (!sesion.pendingMedia) {
      await msg.reply('⚠️ No tengo ningún archivo guardado de esta sesión. Primero mandame una imagen, PDF o documento.');
      return true;
    }

    const destinatario = `${numero}@c.us`;
    try {
      await client.sendMessage(destinatario, sesion.pendingMedia.media, {
        caption: sesion.pendingMedia.caption || '',
      });
      await msg.reply(`✅ Archivo enviado a *${numero}*`);
      log.ok(`Archivo reenviado a ${destinatario}`);
    } catch (err) {
      log.error(`Error al enviar archivo a ${destinatario}:`, err.message);
      await msg.reply(`❌ No pude enviar el archivo a ${numero}. Verificá el número.`);
    }
    return true;
  }

  return false; // Comando no reconocido, continúa el flujo normal
}

// ══════════════════════════════════════════════════════════════
//  CLIENTE WHATSAPP
// ══════════════════════════════════════════════════════════════

const puppeteerConfig = {
  headless: true,
  args: [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--disable-gpu', '--no-first-run', '--no-zygote', '--single-process',
  ],
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
};

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: puppeteerConfig,
});

client.on('qr', (qr) => {
  qrcode.generate(qr, { small: true });
  log.info('Escaneá el QR con tu WhatsApp.');
});

client.on('ready', () => {
  log.ok('¡NOVA IA conectada y lista! 🚀');
  if (NUMEROS_AUTORIZADOS.size > 0) {
    log.info(`Whitelist activa: ${NUMEROS_AUTORIZADOS.size} número(s) autorizado(s).`);
  } else {
    log.warn('⚠️  Whitelist vacía: cualquier número puede usar el bot. Configurá WHITELIST en config.js');
  }
});

// ══════════════════════════════════════════════════════════════
//  HANDLER CENTRAL DE MENSAJES (DISPATCHER)
// ══════════════════════════════════════════════════════════════

client.on('message', async (msg) => {
  // Ignorar grupos y estados
  if (msg.from.includes('@g.us') || msg.isStatus) return;

  // Ignorar tipos de mensaje no soportados
  if (!['chat', 'ptt', 'audio', 'image', 'document'].includes(msg.type)) return;

  const chatId = msg.from;

  // ── SEGURIDAD: Verificar whitelist ──────────────────────────
  if (!estaAutorizado(chatId)) {
    log.warn(`Acceso denegado a número no autorizado: ${chatId}`);
    return; // Silencioso: no respondemos para no revelar que el bot existe
  }

  const sesion = obtenerSesion(chatId);
  const textoEntrada = msg.body?.trim() || '';
  let chatContext = null;

  try {
    chatContext = await msg.getChat();
    await chatContext.sendStateTyping();

    // ── COMANDOS ESPECIALES ──────────────────────────────────
    if (msg.type === 'chat' && textoEntrada.startsWith('/')) {
      const manejado = await procesarComando(msg, sesion, chatId);
      if (manejado) return;
      // Si el comando no fue reconocido, cae al flujo de texto normal
    }

    // ── MULTIMEDIA ───────────────────────────────────────────
    if (msg.hasMedia) {
      log.info(`Descargando adjunto de ${chatId} (tipo: ${msg.type})...`);
      const media = await msg.downloadMedia();
      if (!media) throw new Error('No se pudo descargar el archivo.');

      // A: Audio / Nota de voz
      if (msg.type === 'ptt' || msg.type === 'audio') {
        log.ai('Transcribiendo audio...');
        const textoTranscripto = await transcribirAudio(media);
        log.info(`Audio transcripto: "${textoTranscripto}"`);
        const infoReal = await buscarEnWeb(textoTranscripto);
        const respuesta = await consultarGroq(sesion, textoTranscripto, infoReal);
        return await msg.reply(`🎤 _Transcripción:_ "${textoTranscripto}"\n\n${respuesta}`);
      }

      // B: Imagen (Visión artificial)
      if (msg.type === 'image') {
        log.ai('Analizando imagen con Groq Visión...');
        // Guardamos la imagen como pendingMedia para posible reenvío
        sesion.pendingMedia = { media, caption: textoEntrada || 'Imagen recibida' };
        const respuestaVision = await analizarImagenGroq(sesion, media, textoEntrada);
        return await msg.reply(respuestaVision);
      }

      // C: Documento / PDF / Código
      if (msg.type === 'document') {
        log.ai(`Leyendo documento: ${msg.filename || 'sin nombre'}`);
        // Guardamos el documento como pendingMedia para posible reenvío
        sesion.pendingMedia = { media, caption: msg.filename || 'Documento' };
        const resultadoDoc = await procesarDocumentoTexto(media);

        if (resultadoDoc.error) {
          return await msg.reply(`⚠️ ${resultadoDoc.error}`);
        }

        // Limitamos el contenido para no exceder tokens (~12.000 caracteres)
        const contenidoRecortado = resultadoDoc.contenido.slice(0, 12000);
        const promptConDocumento = `Archivo: "${msg.filename || 'documento'}"\nContenido:\n---\n${contenidoRecortado}\n---\n${textoEntrada || 'Analizá y resumí este archivo.'}`;
        const respuestaDoc = await consultarGroq(sesion, promptConDocumento, "");
        return await msg.reply(respuestaDoc);
      }
    }

    // ── TEXTO PLANO ──────────────────────────────────────────
    if (!textoEntrada) return;
    log.ai(`Procesando texto de ${chatId}: "${textoEntrada.substring(0, 60)}..."`);
    const infoReal = await buscarEnWeb(textoEntrada);
    const respuestaTexto = await consultarGroq(sesion, textoEntrada, infoReal);
    await msg.reply(respuestaTexto);

  } catch (err) {
    log.error(`Fallo crítico procesando ${chatId}:`, err.message);
    try { await msg.reply('😅 Sucedió un error interno. Intentá de nuevo.'); } catch (_) {}
  } finally {
    try { if (chatContext) await chatContext.clearState(); } catch (_) {}
  }
});

// ══════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════

client.initialize();
