# Control de Pasajes

App web para llevar la cuenta de tus **ingresos diarios de pasajes**. Subes 1 a 3 capturas de tus pagos recibidos por **Yape** o **Plin**, la app las lee automáticamente, suma solo los **ingresos** (los montos en negro) e ignora los **gastos** (los montos en rojo), y te muestra el total del día. Es 100% estática (no necesita servidor ni internet para funcionar) y se puede instalar en el celular como una app normal.

---

## Cómo abrirla

**Opción A — Doble clic (rápido)**
Haz doble clic en `index.html` y se abrirá en tu navegador. Funciona para usarla, pero el **Service Worker** (modo offline) y la **instalación como PWA** necesitan que la página se sirva por `http://`, así que con doble clic esas dos cosas pueden no activarse.

**Opción B — Servir la carpeta (recomendada)**
Abre una terminal **dentro de la carpeta** `control-pasajes` y ejecuta:

```bash
python -m http.server 8000
```

Luego abre en el navegador:

```
http://localhost:8000
```

Así sí funciona el modo offline y la instalación.

**En el celular**
Abre la app en el navegador (Chrome o similar) y usa el menú **"Agregar a pantalla de inicio"**. Quedará como una app independiente, con su ícono, y podrás abrirla incluso sin internet.

---

## Cómo usar

1. **Elige la fecha** del día que vas a registrar (campo "Hoy").
2. **Sube 1 a 3 capturas** de tus pagos recibidos (Yape / Plin).
3. La app **lee y suma los ingresos** (montos en negro) e **ignora los gastos** (montos en rojo).
4. **Revisa los resultados** y corrige si algo se leyó mal, luego **guarda**.
5. Si subes capturas que se solapan, los **montos duplicados NO se suman dos veces**.

---

## Privacidad

Todo se guarda **localmente en tu navegador** (`localStorage`). **Nada se sube a ningún servidor**: tus capturas y tus montos no salen de tu dispositivo.

---

## Sobre el OCR (lectura automática)

La lectura de las capturas se hace con OCR en el propio navegador. Si una captura está **borrosa, recortada o con poca luz**, puede leer mal algún monto. Por eso siempre hay un **paso de revisión** antes de guardar: revisa los montos detectados y corrígelos a mano si hace falta.

---

## Estructura de archivos

```
control-pasajes/
├── index.html            Página principal de la app
├── css/styles.css        Estilos
├── js/store.js           Guardado local (localStorage)
├── js/ocr.js             Lectura de capturas (OCR)
├── js/ui.js              Interfaz e interacción
├── icon.svg              Ícono de la app
├── manifest.webmanifest  Configuración PWA (instalación)
├── sw.js                 Service Worker (modo offline)
└── README.md             Este archivo
```
