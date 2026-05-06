# CHARVIS v2.0

Asistente de inteligencia artificial con voz, texto, modo de razonamiento y analisis de archivos.

## Caracteristicas

- Voz y audio con transcripcion por Whisper y salida por ElevenLabs o Web Speech.
- Chat de texto con nueva conversacion desde la interfaz.
- Analisis de imagenes con modelo de vision de Groq.
- Lectura de documentos PDF, DOCX, TXT, Markdown, JSON, CSV y archivos de codigo.
- Modo razonamiento para consultas complejas usando modelos GPT-OSS en Groq.

## Instalacion

1. Ejecutar `npm install`.
2. Copiar `.env.example` a `.env`.
3. Configurar `GROQ_API_KEY`.
4. Ejecutar `npm run dev`.

## Variables utiles

- `GROQ_CHAT_MODEL`: modelo conversacional principal.
- `GROQ_REASONING_MODEL`: modelo usado cuando activas razonamiento.
- `GROQ_VISION_MODEL`: modelo usado para analizar fotos e imagenes.
- `ELEVENLABS_API_KEY`: voz premium opcional.
- `PORT`: puerto del servidor local.

## Seguridad de archivos

Charvis valida tamano y tipo antes de procesar adjuntos. El limite actual es de 12 MB por archivo y el texto extraido se recorta para proteger el contexto del modelo.
