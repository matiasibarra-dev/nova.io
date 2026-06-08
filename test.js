require('dotenv').config();

// Si usas Node < 18
if (!globalThis.fetch) {
  globalThis.fetch = require('node-fetch');
}

async function probarGroq() {
  console.log("🔍 Verificando variables de entorno...");
  console.log("🔑 API Key:", process.env.GROQ_API_KEY ? "Cargada ✅" : "No encontrada ❌");
  
  // Usamos el modelo que pusiste en el .env, o el nuevo por defecto
  const modelo = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
  console.log("🧠 Modelo:", modelo);
  console.log("⏳ Enviando mensaje de prueba a Groq...\n");

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: modelo,
        messages: [{ role: 'user', content: 'Hola, responde con la frase: "¡Conexión exitosa!" y nada más.' }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("❌ ERROR DE LA API DE GROQ:");
      console.error(JSON.stringify(data, null, 2));
      return;
    }

    console.log("✅ RESPUESTA DE GROQ:");
    console.log(data.choices[0].message.content);

  } catch (error) {
    console.error("❌ Error de red o código:", error.message);
  }
}

probarGroq();