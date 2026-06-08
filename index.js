'use strict';

require('dotenv').config();

// Importamos MessageMedia para el manejo de archivos, imágenes y generación de multimedia
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const pdfParse = require('pdf-parse'); // Procesador de PDFs estable
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
//  GESTIÓN DE SESIONES
// ══════════════════════════════════════════════════════════════

/** @type {Map<string, { history: Array, lastActivity: number }>} */
const sesiones = new Map();

const obtenerSesion = (chatId) => {
  if (!sesiones.has(chatId)) {
    sesiones.set(chatId, {
      history: [{ role: 'system', content: CONFIG.SYSTEM_PROMPT }],
      lastActivity: Date.now(),
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
//  BÚSQUEDA WEB (TAVILY AI)
// ══════════════════════════════════════════════════════════════

async function buscarEnWeb(query) {
  if (!process.env.TAVILY_API_KEY) return "";

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        api_key: process.env.TAVILY_API_KEY,
        query: query,
        max_results: 3,
        search_depth: "basic",
        include_answer: true
      })
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    
    if (data.answer) return `Resumen directo de la web: ${data.answer}`;
    if (!data.results || data.results.length === 0) return "";

    return data.results.map(r => `Fuente: ${r.url} | Info: ${r.content}`).join('\n');
  } catch (error) {
    log.error('Error en búsqueda con Tavily:', error.message);
    return "";
  }
}

// ══════════════════════════════════════════════════════════════
//  FUNCIONES MULTIMEDIA: VISIÓN, GENERACIÓN Y DOCUMENTOS
// ══════════════════════════════════════════════════════════════

// 1. Análisis de Imágenes (Visión con Groq Llama 3.2 11B)
async function analizarImagenGroq(sesion, media, textoUsuario) {
  const base64Data = `data:${media.mimetype};base64,${media.data}`;
  const promptText = textoUsuario || "Analizá esta imagen detalladamente e indicame qué ves, si hay texto transcribilo.";
  
  // SOLUCIÓN AL HTTP 400: Llama 3.2 Vision en Groq NO acepta 'role: system'.
  // Inyectamos las directrices directamente dentro del bloque del usuario.
  const mensajesVision = [
    {
      role: 'user',
      content: [
        { type: 'text', text: `${CONFIG.SYSTEM_PROMPT}\n\nInstrucción del usuario: ${promptText}` },
        { type: 'image_url', image_url: { url: base64Data } }
      ]
    }
  ];

  try {
    const response = await fetch(CONFIG.GROQ_URL, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}`
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
    
    // Almacenamos la interacción en el historial de texto plano para mantener el contexto del chat
    sesion.history.push({ role: 'user', content: `[Imagen enviada] Prompt: ${promptText}` });
    sesion.history.push({ role: 'assistant', content: respuestaAI });
    
    return respuestaAI;
  } catch (error) {
    log.error('Error en Groq Visión:', error.message);
    return '😅 Tuve un problema al intentar analizar esa imagen.';
  }
}

// 2. Generación de Imágenes (Pollinations AI Engine)
async function generarImagen(prompt) {
  try {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${Math.floor(Math.random() * 100000)}`;
    return await MessageMedia.fromUrl(url);
  } catch (error) {
    log.error('Error generando imagen:', error.message);
    return null;
  }
}

// 3. Procesamiento de Documentos (Lectura de Archivos PDF y Texto Plano)
async function procesarDocumentoTexto(media) {
  try {
    const buffer = Buffer.from(media.data, 'base64');

    // SOLUCIÓN AL pdfParse: Controlamos de forma robusta la estructura de la librería según la versión
    if (media.mimetype === 'application/pdf') {
      let pdfData;
      
      if (typeof pdfParse === 'function') {
        pdfData = await pdfParse(buffer);
      } else if (pdfParse && typeof pdfParse.default === 'function') {
        pdfData = await pdfParse.default(buffer);
      } else {
        return { error: "Librería pdf-parse mal configurada. Ejecutá: npm install pdf-parse@1.1.1" };
      }

      if (!pdfData.text || pdfData.text.trim() === '') {
         return { error: "El PDF parece estar vacío o es una imagen escaneada sin texto seleccionable." };
      }
      return { contenido: pdfData.text };
    }

    // Validación y lectura de formatos de texto/código comunes
    const mimetypesValidos = ['text/plain', 'application/json', 'text/csv', 'text/markdown', 'application/javascript'];
    if (!mimetypesValidos.includes(media.mimetype) && !media.mimetype.startsWith('text/')) {
      return { error: "Por el momento solo puedo procesar PDFs o archivos de texto (.txt, .json, .csv, .md, .js)." };
    }
    
    const contenido = buffer.toString('utf-8');
    return { contenido };
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

  if (sesion.history.length > CONFIG.MAX_HISTORY_LENGTH + 1) {
    sesion.history = [sesion.history[0], ...sesion.history.slice(-CONFIG.MAX_HISTORY_LENGTH)];
  }

  const mensajesParaGroq = [...sesion.history];

  if (infoReal) {
    mensajesParaGroq.splice(-1, 0, { 
      role: 'system', 
      content: `Contexto extraído de internet en tiempo real para responder a la consulta con precisión:\n${infoReal}` 
    });
  }

  try {
    const response = await fetch(CONFIG.GROQ_URL, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}`
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
    return '😅 Tuve un problema de conexión al procesar tu consulta. Intentá de nuevo en un momento.';
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
//  CLIENTE WHATSAPP Y PUPPETEER CONFIG
// ══════════════════════════════════════════════════════════════

const puppeteerConfig = {
  headless: true,
  args: [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--disable-gpu', '--no-first-run', '--no-zygote', '--single-process'
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
  log.ok('¡Agente IA Multi-Soporte conectado y listo!');
});

// ══════════════════════════════════════════════════════════════
//  HANDLER CENTRAL DE MENSAJES (DISPATCHER)
// ══════════════════════════════════════════════════════════════

client.on('message', async (msg) => {
  if (msg.from.includes('@g.us') || msg.isStatus) return;
  
  if (!['chat', 'ptt', 'audio', 'image', 'document'].includes(msg.type)) return;

  const chatId = msg.from;
  const sesion = obtenerSesion(chatId);
  let chatContext = null;
  const textoEntrada = msg.body?.trim() || '';

  try {
    chatContext = await msg.getChat();
    await chatContext.sendStateTyping();

    // INTERCEPCIÓN: Comando de Generación de Imágenes (/img )
    if (msg.type === 'chat' && textoEntrada.toLowerCase().startsWith('/img ')) {
      const promptImagen = textoEntrada.substring(5).trim();
      if (!promptImagen) return await msg.reply('Escribí un prompt válido. Ejemplo: /img un gato coder cibernético');
      
      log.ai(`Generando imagen para el prompt: "${promptImagen}"`);
      const imagenMedia = await generarImagen(promptImagen);
      
      if (imagenMedia) {
        return await client.sendMessage(chatId, imagenMedia, { caption: 'Aquí tenés tu imagen generada 🎨' });
      } else {
        return await msg.reply('Hubo un inconveniente al generar la imagen.');
      }
    }

    // FLUJO MULTIMEDIA: El usuario envía archivos, audios o imágenes
    if (msg.hasMedia) {
      log.info(`Descargando archivo adjunto de ${chatId}...`);
      const media = await msg.downloadMedia();
      if (!media) throw new Error('Imposible descargar el archivo.');

      // Caso A: Notas de voz o Audio
      if (msg.type === 'ptt' || msg.type === 'audio') {
        log.ai('Transcribiendo audio...');
        const trans_texto = await transcribirAudio(media);
        log.info(`Audio: "${trans_texto}"`);
        const infoReal = await buscarEnWeb(trans_texto);
        const respuesta = await consultarGroq(sesion, trans_texto, infoReal);
        return await msg.reply(respuesta);
      }

      // Caso B: Imágenes (Visión artificial con Llama 3.2)
      if (msg.type === 'image') {
        log.ai('Ejecutando pipeline de Visión...');
        const respuestaVision = await analizarImagenGroq(sesion, media, textoEntrada);
        return await msg.reply(respuestaVision);
      }

      // Caso C: Documentos de texto / PDFs / Código
      if (msg.type === 'document') {
        log.ai('Leyendo archivo adjunto...');
        const resultadoDoc = await procesarDocumentoTexto(media);
        
        if (resultadoDoc.error) {
          return await msg.reply(resultadoDoc.error);
        }

        // Estructuramos el contenido como una inyección de contexto directa
        const promptConDocumento = `He subido un archivo llamado "${msg.filename || 'documento'}".\nContenido del archivo:\n---\n${resultadoDoc.contenido}\n---\n${textoEntrada || 'Analizá o procesá el archivo adjunto.'}`;
        const respuestaDoc = await consultarGroq(sesion, promptConDocumento, "");
        return await msg.reply(respuestaDoc);
      }
    }

    // FLUJO TRADICIONAL: Solo Texto plano
    if (!textoEntrada) return;
    const infoReal = await buscarEnWeb(textoEntrada);
    const respuestaTexto = await consultarGroq(sesion, textoEntrada, infoReal);
    await msg.reply(respuestaTexto);

  } catch (err) {
    log.error(`Fallo crítico procesando chat ${chatId}:`, err.message);
    try { await msg.reply('😅 Sucedió un error interno. Por favor intentá de nuevo.'); } catch (_) {}
  } finally {
    try { if (chatContext) await chatContext.clearState(); } catch (_) {}
  }
});

// ══════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════

client.initialize();