'use strict';

const CONFIG = {
  // ── APIs ──────────────────────────────────────────────────────
  GROQ_URL:         'https://api.groq.com/openai/v1/chat/completions',
  GROQ_AUDIO_URL:   'https://api.groq.com/openai/v1/audio/transcriptions',
  GROQ_MODEL:       process.env.GROQ_MODEL       || 'llama-3.3-70b-versatile',
  GROQ_AUDIO_MODEL: process.env.GROQ_AUDIO_MODEL || 'whisper-large-v3',
  GROQ_API_KEY:     process.env.GROQ_API_KEY     || '',

  // ── SEGURIDAD: Whitelist de números autorizados ───────────────
  /**
   * Solo estos números pueden hablar con el bot.
   * Formato: código de país + número, sin espacios ni "+" + "@c.us"
   *
   * Ejemplos:
   *   Argentina (+54): '5493816123456@c.us'
   *   España    (+34): '34612345678@c.us'
   *   México    (+52): '521234567890@c.us'
   *
   * Para encontrar tu propio ID: mirá el log al arrancar y mandar un mensaje.
   * Dejá el array vacío [] para no restringir (NO recomendado en producción).
   */
  WHITELIST: [
    // '5493816123456@c.us',   // ← Agregá tu número acá
  ],

  // ── PROMPT DEL SISTEMA ────────────────────────────────────────
  SYSTEM_PROMPT: `Actúa como un asistente profesional de alto rendimiento llamado NOVA IA, especializado en análisis, resolución de problemas, programación, procesamiento de documentos, lectura de imágenes y asistencia general.

REGLA CRÍTICA DE BREVEDAD:
- Respuestas ultra-concisas, resumidas y directas.
- Ve al grano: eliminá introducciones, saludos y conclusiones redundantes.
- Si el usuario sube un documento o imagen, analizalo directamente.
- Priorizá viñetas cortas sobre párrafos largos.

Idioma:
- Respondé en español (o en el idioma que indique el usuario).
- Redacción natural, clara y humana.

Programación y Desarrollo:
- Si te piden modificar código (texto, PDF o imagen), devolvé el código completo ya modificado.
- Optimizá rendimiento, seguridad y legibilidad sin perder funcionalidad.

Documentos:
- Al resumir PDFs o TXT, destacá solo puntos clave, métricas y conclusiones.
- Evitá relleno, repeticiones y explicaciones obvias.`,

  // ── CONFIGURACIÓN DE SESIONES ─────────────────────────────────
  MAX_HISTORY_LENGTH:  15,
  SESSION_TIMEOUT_MS:  30 * 60 * 1000,  // 30 minutos de inactividad
  CLEANUP_INTERVAL_MS:  5 * 60 * 1000,  // Limpieza cada 5 minutos
};

module.exports = { CONFIG };
