/*
 * Service Worker — Control de Pasajes
 * Objetivo: que la app funcione offline (app-shell) y que las librerías
 * pesadas de CDN (Chart.js, Tesseract.js + sus workers/wasm/traineddata)
 * se sirvan rápido y sigan funcionando aunque no haya internet.
 *
 * Estrategias:
 *   - App-shell (mismo origen)  -> cache-first con fallback a red.
 *   - CDNs (jsdelivr, tessdata) -> stale-while-revalidate (best-effort).
 *
 * Todo está envuelto en try/catch para que el SW nunca rompa la app.
 */

'use strict';

const CACHE = 'control-pasajes-v5';

// Recursos mínimos que forman el "esqueleto" de la app (mismo origen).
const APP_SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/store.js',
  './js/cloud.js',
  './js/ocr.js',
  './js/excel.js',
  './js/ui.js',
  './icon.svg',
  './manifest.webmanifest'
];

// Orígenes/host fragments que consideramos "CDN" y queremos cachear
// best-effort con stale-while-revalidate. Tesseract baja archivos desde
// jsdelivr y, a veces, traineddata desde tessdata/raw.githubusercontent.
const CDN_HOSTS = [
  'cdn.jsdelivr.net',
  'fastly.jsdelivr.net',
  'jsdelivr.net',
  'unpkg.com',
  'tessdata.projectnaptha.com',
  'raw.githubusercontent.com',
  'cdn.tessdata'
];

// -----------------------------------------------------------------------------
// INSTALL: precachear el app-shell uno por uno (si uno falla, no rompe todo).
// -----------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  // Activar de inmediato la nueva versión del SW.
  self.skipWaiting();

  event.waitUntil((async () => {
    let cache;
    try {
      cache = await caches.open(CACHE);
    } catch (err) {
      // Si ni siquiera podemos abrir la caché, dejamos que install continúe.
      console.warn('[SW] No se pudo abrir la caché en install:', err);
      return;
    }

    // Cacheamos cada recurso por separado, ignorando los que fallen.
    // (Evita que un solo 404 tumbe toda la instalación, a diferencia de addAll.)
    await Promise.all(APP_SHELL.map(async (url) => {
      try {
        const resp = await fetch(url, { cache: 'no-cache' });
        if (resp && resp.ok) {
          await cache.put(url, resp.clone());
        } else {
          console.warn('[SW] Recurso de shell no OK (se ignora):', url);
        }
      } catch (err) {
        console.warn('[SW] No se pudo precachear (se ignora):', url, err);
      }
    }));
  })());
});

// -----------------------------------------------------------------------------
// ACTIVATE: borrar cachés viejas y tomar control de las pestañas abiertas.
// -----------------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const nombres = await caches.keys();
      await Promise.all(
        nombres.map((nombre) => {
          if (nombre !== CACHE) {
            return caches.delete(nombre); // limpiar versiones anteriores
          }
          return Promise.resolve();
        })
      );
    } catch (err) {
      console.warn('[SW] Error limpiando cachés viejas:', err);
    }

    // Tomar control inmediato de los clientes ya abiertos.
    try {
      await self.clients.claim();
    } catch (err) {
      console.warn('[SW] clients.claim() falló:', err);
    }
  })());
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// ¿La URL pertenece a una CDN que queremos cachear best-effort?
function esCDN(url) {
  try {
    return CDN_HOSTS.some((host) => url.hostname.includes(host));
  } catch (_) {
    return false;
  }
}

// Guarda en caché de forma segura (best-effort). No lanza nunca.
async function guardarEnCache(request, response) {
  try {
    // Respuestas opacas (cross-origin sin CORS) tienen status 0:
    // las aceptamos best-effort para las CDNs. Las de mismo origen
    // sólo se guardan si status === 200.
    if (!response) return;
    const esOpaca = response.type === 'opaque';
    if (response.status === 200 || esOpaca) {
      const cache = await caches.open(CACHE);
      await cache.put(request, response.clone());
    }
  } catch (err) {
    // Algunos navegadores rechazan cachear ciertos esquemas; lo ignoramos.
    console.warn('[SW] No se pudo guardar en caché (se ignora):', err);
  }
}

// Stale-while-revalidate: responde de caché si hay, y refresca en segundo
// plano; si no hay caché, va a red y cachea.
async function staleWhileRevalidate(request) {
  let cached;
  try {
    cached = await caches.match(request);
  } catch (_) {
    cached = undefined;
  }

  // Revalidación en segundo plano (no bloquea la respuesta).
  const fetchPromise = (async () => {
    try {
      const fresh = await fetch(request);
      await guardarEnCache(request, fresh);
      return fresh;
    } catch (err) {
      // Sin red: nos quedamos con lo que haya en caché.
      return undefined;
    }
  })();

  // Si hay copia en caché, la devolvemos ya (y revalidamos detrás).
  if (cached) return cached;

  // Si no hay copia, esperamos a la red.
  const fresh = await fetchPromise;
  if (fresh) return fresh;

  // Último recurso: respuesta vacía controlada para no romper el JS de la app.
  return new Response('', { status: 504, statusText: 'Sin conexión' });
}

// Cache-first: usa caché si existe; si no, red (y cachea). Con fallback a
// index.html para navegaciones cuando no hay internet.
async function cacheFirst(request) {
  try {
    const cached = await caches.match(request);
    if (cached) return cached;
  } catch (_) {
    // seguimos hacia la red
  }

  try {
    const fresh = await fetch(request);
    await guardarEnCache(request, fresh);
    return fresh;
  } catch (err) {
    // Sin red. Si es una navegación, devolvemos el index cacheado.
    if (request.mode === 'navigate') {
      const fallback = await caches.match('./index.html');
      if (fallback) return fallback;
    }
    // Como último recurso, intentamos cualquier copia que exista.
    const last = await caches.match(request);
    if (last) return last;
    return new Response('Sin conexión', { status: 504, statusText: 'Sin conexión' });
  }
}

// -----------------------------------------------------------------------------
// FETCH: enrutar cada petición a la estrategia adecuada.
// -----------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Sólo nos interesan las peticiones GET.
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (_) {
    return; // URL rara: dejamos pasar a la red por defecto.
  }

  // Sólo manejamos http/https (ignoramos chrome-extension:, data:, etc.).
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  const mismoOrigen = url.origin === self.location.origin;

  if (mismoOrigen) {
    // App-shell -> cache-first con fallback.
    event.respondWith(cacheFirst(request));
  } else if (esCDN(url)) {
    // Librerías de CDN (Chart.js, Tesseract workers/wasm/traineddata)
    // -> stale-while-revalidate best-effort.
    event.respondWith(staleWhileRevalidate(request));
  }
  // Cualquier otra cosa cross-origin: no la interceptamos (red normal).
});
