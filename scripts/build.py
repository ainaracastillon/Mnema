"""Genera public/index.html a partir de src/mnema.html (la versión de la app que corre en Claude)."""
import pathlib, sys, hashlib
root = pathlib.Path(__file__).resolve().parent.parent
shim_v = hashlib.sha1((root / 'public' / 'mnema-shim.js').read_bytes()).hexdigest()[:10]
src = (root / 'src' / 'mnema.html').read_text(encoding='utf-8')
cut = src.index('<header')
head_part, body_part = src[:cut], src[cut:]
replacements = [
  ("Claude no está disponible en esta vista. Abre Mnema desde claude.ai con tu cuenta.", "La IA necesita que entres con tu cuenta. Pulsa «Entrar» arriba."),
  ("Mnema necesita tu permiso para usar Claude. Vuelve a intentarlo y acepta el aviso.", "Entra con tu cuenta para usar la IA."),
  ("Para compartir, abre Mnema desde claude.ai con tu cuenta.", "Para compartir, entra con tu cuenta (botón «Entrar» arriba)."),
  ("Para compartir necesitas abrir Mnema desde claude.ai con tu cuenta de Claude.", "Para compartir necesitas entrar con tu cuenta."),
  ("Leer fotos necesita abrir Mnema desde claude.ai", "Leer fotos con IA necesita entrar con tu cuenta"),
  ("Inicia sesión en Claude para guardarlo en la nube.", "Entra con tu cuenta para guardarlo en la nube."),
  ("Comparte la app Mnema desde el menú <b>Compartir</b> de esta página, con permiso para usarla (no solo ver).", "Pásales el enlace de Mnema y que se creen una cuenta."),
  ("Claude está revisando tus respuestas", "La IA está revisando tus respuestas"),
  ("<script src=\"https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js\">", "<script src=\"/mnema-shim.js?v=" + shim_v + "\"></script>\n<script src=\"https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js\">"),
]
for a, b in replacements:
    n = (head_part + body_part).count(a)
    if n < 1:
        print('Aviso: ya no aparece el texto: ' + a[:60]); continue
    head_part = head_part.replace(a, b); body_part = body_part.replace(a, b)
head_part = head_part.replace('<meta name="claude:viewport-fit-sides" content="cover">\n', '')
reset = ('<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}'
         'body{margin:0}img{max-width:100%}[hidden]{display:none!important}'
         '.booting .shell{visibility:hidden}</style>'
         '<script>document.documentElement.classList.add("booting");setTimeout(function(){document.documentElement.classList.remove("booting")},4000)</script>')
page = ('<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width,initial-scale=1,minimum-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">\n'
        '<meta name="description" content="Mnema: sube tu temario y estudia con resúmenes, mapas mentales, pódcast, tarjetas, tests corregidos y tutor.">\n'
        '<meta name="theme-color" content="#1F2C86">\n<link rel="icon" href="/icon.svg" type="image/svg+xml">\n'
        '<link rel="manifest" href="/manifest.webmanifest">\n<link rel="apple-touch-icon" href="/apple-touch-icon.png">\n'
        '<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="mobile-web-app-capable" content="yes">\n'
        '<meta name="apple-mobile-web-app-title" content="Mnema">\n<meta name="apple-mobile-web-app-status-bar-style" content="default">\n' + reset + '\n' + head_part + '</head>\n<body>\n' + body_part + '\n</body>\n</html>\n')
(root / 'public' / 'index.html').write_text(page, encoding='utf-8')
print('public/index.html generado')
