# Mnema

App de estudio que trabaja con **tu propio temario**: subes PDF, Word, texto o fotos y Mnema lo convierte en resúmenes, mapas mentales, pódcast, tablas comparativas, tarjetas con repetición espaciada, juegos, tests corregidos, un tutor y un plan hasta el examen. También permite estudiar en grupo con un código y una clasificación.

## Cómo está hecha

- `public/index.html`: la app completa (HTML, CSS y JS en un archivo). Se genera desde `src/mnema.html` con `npm run build:page`.
- `public/mnema-shim.js`: conecta la app con el servidor (cuentas, guardado, IA, imágenes, descargas).
- `server.js`: servidor Express con:
  - cuentas de usuario (nombre + contraseña, sesión en cookie firmada),
  - guardado de asignaturas, materiales e imágenes en Postgres,
  - grupos de estudio y clasificación,
  - IA con Groq como modelo principal para el texto y Cloudflare Workers AI para leer fotos y como respaldo si Groq falla o se satura, con respuesta en streaming.

## Variables de entorno

| Variable | Para qué sirve |
| --- | --- |
| `DATABASE_URL` | Conexión a Postgres (Neon). Las tablas se crean solas al arrancar. |
| `SESSION_SECRET` | Firma de las sesiones. |
| `GROQ_API_KEY` | Clave de Groq. Modelo principal de texto. |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | Cloudflare Workers AI: lectura de fotos y PDF escaneados, y respaldo. El token necesita permiso «Workers AI». |
| `GROQ_MODEL`, `GROQ_MODEL_QUICK`, `CLOUDFLARE_MODEL` | Opcionales, para cambiar de modelo. |

Con una sola de las dos IAs configurada la app ya funciona; sin ninguna, todo menos la generación de contenido.

## En local

```bash
cp .env.example .env   # y rellena los valores
npm install
node --env-file=.env server.js
```

## Despliegue en Render

El archivo `render.yaml` describe el servicio. Build: `npm install`, start: `npm start`, comprobación de salud en `/healthz`.

En producción: https://mnema-study.onrender.com
