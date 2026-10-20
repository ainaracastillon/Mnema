# Mnema

App de estudio que trabaja con **tu propio temario**: subes PDF, Word, texto o fotos y Mnema lo convierte en resúmenes, mapas mentales, pódcast, tablas comparativas, tarjetas con repetición espaciada, juegos, tests corregidos, un tutor y un plan hasta el examen. También permite estudiar en grupo con un código y una clasificación.

## Cómo está hecha

- `public/index.html`: la app completa (HTML, CSS y JS en un archivo). Se genera desde `src/mnema.html` con `npm run build:page`.
- `public/mnema-shim.js`: conecta la app con el servidor (cuentas, guardado, IA, imágenes, descargas).
- `server.js`: servidor Express con:
  - cuentas de usuario (nombre + contraseña, sesión en cookie firmada),
  - guardado de asignaturas, materiales e imágenes en Postgres,
  - grupos de estudio y clasificación,
  - proxy a la API de Claude con respuesta en streaming.

## Variables de entorno

| Variable | Para qué sirve |
| --- | --- |
| `DATABASE_URL` | Conexión a Postgres (Neon). Las tablas se crean solas al arrancar. |
| `SESSION_SECRET` | Firma de las sesiones. |
| `ANTHROPIC_API_KEY` | Activa las funciones de IA. Sin ella la app funciona, pero sin generar contenido. |
| `ANTHROPIC_MODEL`, `ANTHROPIC_MODEL_QUICK` | Opcionales. |

## En local

```bash
cp .env.example .env   # y rellena los valores
npm install
node --env-file=.env server.js
```

## Despliegue en Render

El archivo `render.yaml` describe el servicio. Build: `npm install`, start: `npm start`, comprobación de salud en `/healthz`.
