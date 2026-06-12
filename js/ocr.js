/* =========================================================================
   ocr.js — Motor de lectura (OCR) de la app "Control de Pasajes".

   Lee capturas de pantalla del app Yape / Plin (Perú) — la pantalla
   "Movimientos" — y extrae cada movimiento como dato estructurado.

   Expone window.OCR con:

     OCR.extract(file, opts) -> Promise<Array<Partial>>
       file : File/Blob de imagen (PNG/JPG, captura de celular).
       opts : { refDate:"YYYY-MM-DD", source:"nombre.png",
                onProgress:function(fraccion0a1, mensaje){} }
       resuelve a un arreglo de:
         { name, date:"YYYY-MM-DD", time:"HH:MM" (24h, "" si no se sabe),
           amount:Number (positivo), type:"income"|"expense",
           source:opts.source, note:"" }
       NUNCA hace throw. Ante cualquier fallo: console.warn + resuelve [].

     OCR.parseFromOcr(ocrData, canvas, opts) -> Array<Partial>
       Función PURA para tests: recibe el resultado de Tesseract (data) +
       el canvas y devuelve el arreglo de Partial.

     OCR.classifyColor(canvas, bbox) -> "income" | "expense"
       Muestrea el color del texto del monto dentro del bbox.

   Arquitectura:
     1) Pre-proceso: el File se dibuja en un <canvas> propio (escalado a
        ~1100-1400px de ancho si viene chico). Tesseract LEE de ese canvas
        y el muestreo de color SALE del mismo canvas → los bbox quedan en
        el MISMO sistema de coordenadas.
     2) Tesseract.js v4 (UMD, CDN lazy) entrega data.words y data.lines con
        sus bbox {x0,y0,x1,y1}.
     3) Reconstrucción por bounding boxes: emparejamos cada "línea de monto"
        (a la derecha) con su NOMBRE (izquierda, alineado al monto) y su
        FECHA/HORA (izquierda, justo debajo del nombre).
     4) El TIPO (ingreso/gasto) se decide por COLOR del texto del monto
        (rojo = gasto), con respaldo en el signo "-".

   JS vanilla, sin módulos ES, sin dependencias externas salvo Tesseract.js.
   Todo dentro de un IIFE que asigna window.OCR.
   ========================================================================= */
(function () {
  'use strict';

  /* ---------------------------------------------------------------------
     Configuración / constantes
     --------------------------------------------------------------------- */

  // CDN del UMD de Tesseract.js v4.1.4 (expone data.words y data.lines fiables).
  var TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@4.1.4/dist/tesseract.min.js';
  var TESSERACT_LANG = 'spa';

  // Ancho objetivo para el canvas de trabajo (mejora notablemente el OCR).
  var TARGET_MIN_WIDTH = 1100;
  var TARGET_MAX_WIDTH = 1400;

  // Frontera izquierda/derecha como fracción del ancho del canvas.
  // A la derecha (> 0.58 * W) viven los montos; a la izquierda, nombre+fecha.
  var RIGHT_ZONE = 0.58;

  // Meses abreviados en español (índice 0 = enero).
  var MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  // Cache del script de Tesseract ya cargado (promesa única).
  var tesseractLoadPromise = null;
  // Worker reutilizable entre llamadas (se crea perezosamente).
  var sharedWorker = null;
  var sharedWorkerPromise = null;

  /* ---------------------------------------------------------------------
     Utilidades pequeñas
     --------------------------------------------------------------------- */

  // Reporta progreso de forma segura (la callback es opcional).
  function report(opts, frac, msg) {
    if (opts && typeof opts.onProgress === 'function') {
      try { opts.onProgress(frac, msg); } catch (e) { /* nunca rompemos por la UI */ }
    }
  }

  // Limpia un número de monto leído por OCR a Number (positivo).
  // Maneja separador de miles y decimales: "300.00"→300, "1,234.50"→1234.5,
  // "12,50" (coma decimal)→12.5.
  function cleanNumber(raw) {
    if (raw == null) return NaN;
    var s = String(raw).trim();
    // Quita todo lo que no sea dígito, punto o coma.
    s = s.replace(/[^\d.,]/g, '');
    if (!s) return NaN;

    var hasDot = s.indexOf('.') >= 0;
    var hasComma = s.indexOf(',') >= 0;

    if (hasDot && hasComma) {
      // El último separador que aparece es el decimal; el otro son miles.
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
        // formato 1.234,50 → coma decimal
        s = s.replace(/\./g, '').replace(',', '.');
      } else {
        // formato 1,234.50 → punto decimal
        s = s.replace(/,/g, '');
      }
    } else if (hasComma) {
      // Solo coma: si parece decimal (",dd" al final) la tratamos como punto;
      // si parece miles (",ddd") la quitamos.
      if (/,\d{1,2}$/.test(s)) s = s.replace(',', '.');
      else s = s.replace(/,/g, '');
    }
    // Si solo hay puntos los dejamos (parseFloat usa el primero).
    var x = parseFloat(s);
    return isNaN(x) ? NaN : Math.abs(x);
  }

  /* ---------------------------------------------------------------------
     matchAmount — detecta un monto tipo "S/ 4.00" tolerando errores de OCR.

     Reconoce variantes donde "S/" se leyó como: S/, SI, S1, $/, $ /, 5/, etc.
     Devuelve { value:Number, neg:Boolean } o null.
       - neg = true si venía precedido de un signo menos (-, –, —).
     --------------------------------------------------------------------- */
  function matchAmount(text) {
    if (!text) return null;
    // Grupos:
    //   1: separador inicial (^ o espacio)         (ignorado)
    //   2: signo menos opcional  (-, –, —)
    //   3: "S/" tolerante: [S5$] + separador [\/I1l|] (la "/" mal leída)
    //   4: el número con dígitos, puntos y comas
    //
    // Aceptamos que entre la letra y la barra haya espacio, y que el número
    // venga pegado o separado.
    var re = /(^|\s)(-|–|—)?\s*[S5$]\s*[\/I1l|]\s*([\d][\d.,]*)/i;
    var m = re.exec(text);
    if (m) {
      var val = cleanNumber(m[3]);
      if (isNaN(val)) return null;
      return { value: val, neg: !!m[2] };
    }

    // Plan B: a veces el OCR se come la "/" por completo y deja "S 4.00" /
    // "SI 4.00" / "5 4.00". Exigimos la letra S (o 5/$) seguida de número
    // razonable, para no confundir con texto suelto.
    var re2 = /(^|\s)(-|–|—)?\s*[S5$][I1l|\/]?\s+([\d][\d.,]*)/i;
    var m2 = re2.exec(text);
    if (m2) {
      var val2 = cleanNumber(m2[3]);
      if (isNaN(val2)) return null;
      return { value: val2, neg: !!m2[2] };
    }
    return null;
  }

  /* ---------------------------------------------------------------------
     Detector de "línea de fecha".
     Una línea es de fecha si contiene una hora (HH:MM) Y/O contiene
     "Hoy"/"Ayer"/un mes abreviado (con o sin punto).
     --------------------------------------------------------------------- */
  function looksLikeDateLine(text) {
    if (!text) return false;
    var t = text.toLowerCase();
    if (/\b\d{1,2}:\d{2}\b/.test(t)) return true;              // tiene hora
    if (/\b(hoy|ayer)\b/.test(t)) return true;                 // palabra relativa
    // mes abreviado como palabra: ene, feb, ... dic (con o sin punto).
    if (new RegExp('\\b(' + MESES.join('|') + ')\\.?\\b').test(t)) return true;
    return false;
  }

  /* ---------------------------------------------------------------------
     Resolución de fecha + hora a partir del texto de la línea de fecha.
     Devuelve { date:"YYYY-MM-DD"|"", time:"HH:MM"|"" }.
     --------------------------------------------------------------------- */

  // Suma (o resta) días a una fecha ISO sin sufrir saltos de zona horaria.
  // Construimos al mediodía local para evitar cruces de día por TZ.
  function shiftISO(iso, deltaDays) {
    if (!iso) return '';
    var d = new Date(iso + 'T12:00:00');
    if (isNaN(d.getTime())) return '';
    d.setDate(d.getDate() + deltaDays);
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  // Convierte hora 12h/24h + am/pm (en español, varias grafías) a "HH:MM".
  function parseTime(text) {
    if (!text) return '';
    // Captura HH:MM y opcionalmente am/pm con o sin puntos/espacios:
    // "12:42 pm", "7:42pm", "9:46 p. m.", "08:54".
    var m = /(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?/i.exec(text);
    var h, min, ap = null;
    if (m) {
      h = parseInt(m[1], 10);
      min = m[2];
      ap = m[3].toLowerCase();
    } else {
      var m2 = /(\d{1,2}):(\d{2})/.exec(text);
      if (!m2) return '';
      h = parseInt(m2[1], 10);
      min = m2[2];
    }
    if (isNaN(h) || h > 23) return '';
    if (ap) {
      // 12h → 24h
      if (ap === 'p' && h < 12) h += 12;
      if (ap === 'a' && h === 12) h = 0;
    }
    return String(h).padStart(2, '0') + ':' + min;
  }

  // Resuelve la fecha de la línea. opts.refDate es el fallback ("Hoy").
  function resolveDate(text, opts) {
    var refDate = (opts && opts.refDate) || '';
    if (!text) return { date: refDate || '', time: '' };

    var time = parseTime(text);
    var lower = text.toLowerCase();

    // 1) Fecha explícita "09 jun. 2026".
    var reAbs = new RegExp('(\\d{1,2})\\s+(' + MESES.join('|') + ')\\.?\\s+(\\d{4})', 'i');
    var mAbs = reAbs.exec(lower);
    if (mAbs) {
      var dd = String(parseInt(mAbs[1], 10)).padStart(2, '0');
      var mi = MESES.indexOf(mAbs[2].toLowerCase());
      var mm = String(mi + 1).padStart(2, '0');
      var yyyy = mAbs[3];
      if (mi >= 0) return { date: yyyy + '-' + mm + '-' + dd, time: time };
    }

    // 2) "Hoy" → refDate.
    if (/\bhoy\b/.test(lower)) return { date: refDate || '', time: time };

    // 3) "Ayer" → refDate - 1 día.
    if (/\bayer\b/.test(lower)) {
      var ayer = refDate ? shiftISO(refDate, -1) : '';
      return { date: ayer, time: time };
    }

    // 4) Sin pista de fecha pero con hora → usamos refDate como fallback.
    if (time) return { date: refDate || '', time: time };

    // 5) Nada útil.
    return { date: refDate || '', time: time };
  }

  /* ---------------------------------------------------------------------
     classifyColor — decide "income"/"expense" muestreando el color del
     TEXTO del monto dentro de su bbox.

     INGRESO = monto negro/oscuro. GASTO = monto ROJO.
     Estrategia: tomamos getImageData de la región, nos quedamos solo con
     los píxeles "de tinta" (oscuros o coloreados, no casi-blancos), y
     promediamos su RGB. Si el promedio es claramente rojo → expense.

     Devuelve "income" | "expense". Si la región no tiene píxeles de texto,
     devuelve "income" (el llamador aplica el respaldo del signo).
     --------------------------------------------------------------------- */
  function classifyColor(canvas, bbox) {
    if (!canvas || !bbox) return 'income';
    try {
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      // Recortamos la región a los límites del canvas y le damos un pequeño
      // margen para no perder bordes de glifos.
      var pad = 2;
      var x = Math.max(0, Math.floor(bbox.x0) - pad);
      var y = Math.max(0, Math.floor(bbox.y0) - pad);
      var x1 = Math.min(canvas.width, Math.ceil(bbox.x1) + pad);
      var y1 = Math.min(canvas.height, Math.ceil(bbox.y1) + pad);
      var w = x1 - x;
      var h = y1 - y;
      if (w <= 0 || h <= 0) return 'income';

      var img = ctx.getImageData(x, y, w, h).data;

      var sumR = 0, sumG = 0, sumB = 0, count = 0;
      for (var i = 0; i < img.length; i += 4) {
        var r = img[i], g = img[i + 1], b = img[i + 2], a = img[i + 3];
        if (a < 32) continue;                  // transparente
        var bright = (r + g + b) / 3;
        if (bright >= 210) continue;           // casi-blanco = fondo
        // Píxel de "tinta": oscuro o con color saturado.
        sumR += r; sumG += g; sumB += b; count++;
      }

      if (count === 0) return 'income';        // región vacía → respaldo afuera

      var avgR = sumR / count, avgG = sumG / count, avgB = sumB / count;

      // ¿El promedio es rojo? Rojo domina con margen claro sobre verde y azul.
      var isRed = avgR > 130 && (avgR - avgG) > 45 && (avgR - avgB) > 45;
      return isRed ? 'expense' : 'income';
    } catch (e) {
      console.warn('OCR.classifyColor falló:', e);
      return 'income';
    }
  }

  /* ---------------------------------------------------------------------
     Filtro de basura: ¿este texto es claramente NO un nombre?
     --------------------------------------------------------------------- */
  function isJunkName(name) {
    if (!name) return true;
    var t = name.trim().toLowerCase();
    if (!t) return true;
    if (/^movimientos?$/.test(t)) return true;       // cabecera de la pantalla
    if (/^(hoy|ayer)$/.test(t)) return true;          // residuo de la línea de fecha
    // Una línea que es puro número/símbolo no es un nombre.
    if (/^[\d\s.,:/-]+$/.test(t)) return true;
    return false;
  }

  /* ---------------------------------------------------------------------
     normaliza el texto de una "línea" de Tesseract (puede venir con \n).
     --------------------------------------------------------------------- */
  function lineText(line) {
    return (line && line.text != null ? String(line.text) : '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Calcula centro y alto de un bbox.
  function geom(bbox) {
    var x0 = bbox.x0, y0 = bbox.y0, x1 = bbox.x1, y1 = bbox.y1;
    return {
      cx: (x0 + x1) / 2,
      cy: (y0 + y1) / 2,
      h: y1 - y0,
      x0: x0, y0: y0, x1: x1, y1: y1
    };
  }

  /* ---------------------------------------------------------------------
     parseFromOcr — FUNCIÓN PURA (testeable).
     Recibe el `data` de Tesseract (con .lines, cada una con .bbox y .text)
     + el canvas (para muestrear color) + opts (refDate/source).
     Devuelve el arreglo de Partial.
     --------------------------------------------------------------------- */
  function parseFromOcr(ocrData, canvas, opts) {
    opts = opts || {};
    var source = opts.source || '';
    var W = (canvas && canvas.width) || 1;

    if (!ocrData || !Array.isArray(ocrData.lines)) {
      console.warn('OCR.parseFromOcr: data.lines ausente.');
      return [];
    }

    // 1) Construimos un modelo de líneas con geometría + texto + flags.
    var lines = [];
    ocrData.lines.forEach(function (ln) {
      if (!ln || !ln.bbox) return;
      var txt = lineText(ln);
      if (!txt) return;
      var g = geom(ln.bbox);
      // Descartamos líneas con alto absurdo (ruido).
      if (g.h <= 0) return;
      lines.push({
        text: txt,
        bbox: ln.bbox,
        cx: g.cx, cy: g.cy, h: g.h,
        isDate: looksLikeDateLine(txt),
        isRight: g.cx > W * RIGHT_ZONE
      });
    });

    // 2) Líneas de monto = en la zona derecha y que hacen match con monto.
    //    Cada una ancla UN movimiento. Guardamos su bbox para el color.
    var amountLines = [];
    lines.forEach(function (ln) {
      if (!ln.isRight) return;
      var am = matchAmount(ln.text);
      if (!am) return;
      if (!am.value || am.value <= 0) return;   // ignora montos = 0
      amountLines.push({
        bbox: ln.bbox,
        cx: ln.cx, cy: ln.cy, h: ln.h,
        value: am.value,
        neg: am.neg
      });
    });

    // Líneas de la IZQUIERDA: nombres (no-fecha) y fechas (sí-fecha).
    var leftNameLines = [];
    var leftDateLines = [];
    lines.forEach(function (ln) {
      if (ln.isRight) return;
      if (ln.isDate) leftDateLines.push(ln);
      else if (!isJunkName(ln.text)) leftNameLines.push(ln);
    });

    var out = [];

    // 3) Para cada línea de monto reconstruimos el movimiento.
    amountLines.forEach(function (A) {
      var maxDV = A.h * 2.2;   // tolerancia vertical para emparejar el nombre

      // 3a) NOMBRE: la línea de la izquierda (no-fecha) más alineada
      //     verticalmente con el monto (menor |cy - A.cy|).
      var name = null, bestNameDv = Infinity;
      leftNameLines.forEach(function (ln) {
        var dv = Math.abs(ln.cy - A.cy);
        if (dv < bestNameDv) { bestNameDv = dv; name = ln; }
      });
      // Descartamos candidato demasiado lejos verticalmente.
      if (name && bestNameDv > maxDV) name = null;

      // 3b) FECHA/HORA: preferimos la línea de fecha JUSTO debajo del nombre.
      var dateLn = null;
      if (name) {
        var bestBelow = Infinity;
        leftDateLines.forEach(function (ln) {
          var below = ln.cy - name.cy;          // positivo = está debajo
          if (below > 0 && below <= name.h * 2.5 && below < bestBelow) {
            bestBelow = below; dateLn = ln;
          }
        });
      }
      // Si no hay una "justo debajo", tomamos la fecha más cercana en cy
      // al ancla del monto (sirve cuando falta el nombre o está cortado).
      if (!dateLn) {
        var bestDv = Infinity;
        var anchorCy = name ? name.cy : A.cy;
        leftDateLines.forEach(function (ln) {
          var dv = Math.abs(ln.cy - anchorCy);
          if (dv < bestDv) { bestDv = dv; dateLn = ln; }
        });
        // Si la "más cercana" está absurdamente lejos, la ignoramos.
        if (dateLn && Math.abs(dateLn.cy - anchorCy) > A.h * 4) dateLn = null;
      }

      // 3c) Resolvemos nombre / fecha / hora.
      var nameTxt = name ? name.text.trim() : '';
      if (isJunkName(nameTxt)) nameTxt = '';
      if (!nameTxt) nameTxt = '(sin nombre)';

      var df = resolveDate(dateLn ? dateLn.text : '', opts);

      // 3d) TIPO por color, con respaldo del signo.
      var colorType = classifyColor(canvas, A.bbox);
      // Combinación:
      //   - rojo  => expense (señal más confiable)
      //   - si el color quedó indefinido (devolvió income por falta de tinta)
      //     y el monto traía "-", confiamos en el signo.
      // classifyColor devuelve "income" tanto cuando es negro como cuando no
      // halló tinta; usamos `neg` solo como respaldo de bajo costo.
      var type = colorType;
      if (colorType === 'income' && A.neg) {
        // El color dice income pero había "-": el "-" es señal secundaria.
        // Mantenemos income salvo que NO hubiéramos podido medir color.
        // Como classifyColor no nos dice si midió o no, aplicamos una regla
        // conservadora: si hubo signo menos, marcamos expense (los gastos en
        // Yape/Plin SIEMPRE traen "-").
        type = 'expense';
      }

      out.push({
        name: nameTxt,
        date: df.date || '',
        time: df.time || '',
        amount: Math.abs(Number(A.value)) || 0,
        type: type === 'expense' ? 'expense' : 'income',
        source: source,
        note: ''
      });
    });

    // 4) Limpieza: descartamos montos 0 o nombres-cabecera evidentes.
    out = out.filter(function (r) {
      if (!r.amount || r.amount <= 0) return false;
      if (/^movimientos?$/i.test(r.name.trim())) return false;
      return true;
    });

    // 5) Dedup obvio dentro de la misma imagen (nombre+fecha+hora+monto+tipo).
    var seen = {};
    out = out.filter(function (r) {
      var key = [
        r.name.toLowerCase().trim(),
        r.date, r.time,
        Number(r.amount).toFixed(2),
        r.type
      ].join('|');
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });

    // 6) Orden por (date, time) ascendente para una salida estable.
    out.sort(function (a, b) {
      var ka = (a.date || '') + ' ' + (a.time || '');
      var kb = (b.date || '') + ' ' + (b.time || '');
      return ka.localeCompare(kb);
    });

    return out;
  }

  /* ---------------------------------------------------------------------
     Carga perezosa del script UMD de Tesseract desde el CDN.
     Reintenta una vez si la primera falla. Resuelve con el objeto global
     Tesseract, o rechaza si no se pudo.
     --------------------------------------------------------------------- */
  function loadTesseractScript() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (tesseractLoadPromise) return tesseractLoadPromise;

    tesseractLoadPromise = injectScriptOnce(TESSERACT_CDN)
      .catch(function () {
        // Segundo intento (la primera carga del CDN puede fallar por red).
        console.warn('OCR: primer intento de cargar Tesseract falló, reintentando…');
        return injectScriptOnce(TESSERACT_CDN + (TESSERACT_CDN.indexOf('?') >= 0 ? '&' : '?') + 'retry=1');
      })
      .then(function () {
        if (!window.Tesseract) throw new Error('Tesseract no quedó disponible tras cargar el script.');
        return window.Tesseract;
      })
      .catch(function (err) {
        // Permite reintentar en una llamada futura.
        tesseractLoadPromise = null;
        throw err;
      });

    return tesseractLoadPromise;
  }

  // Inserta un <script> y resuelve al cargar / rechaza al error.
  function injectScriptOnce(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () {
        // Limpiamos el nodo fallido para no dejar basura en el DOM.
        if (s.parentNode) s.parentNode.removeChild(s);
        reject(new Error('No se pudo cargar el script: ' + src));
      };
      (document.head || document.documentElement).appendChild(s);
    });
  }

  /* ---------------------------------------------------------------------
     Obtiene (o crea) un worker de Tesseract v4 reutilizable.
     Cacheamos el worker en memoria entre llamadas. Si crear el worker falla,
     limpiamos la promesa para poder reintentar.
     --------------------------------------------------------------------- */
  function getWorker(Tesseract, opts) {
    if (sharedWorker) return Promise.resolve(sharedWorker);
    if (sharedWorkerPromise) return sharedWorkerPromise;

    sharedWorkerPromise = Tesseract.createWorker(TESSERACT_LANG, 1, {
      logger: function (m) {
        if (m && m.status === 'recognizing text') {
          // Reconocimiento mapea su progreso 0..1 a la franja 0.1 → 0.9.
          report(opts, 0.1 + 0.8 * (m.progress || 0), 'Leyendo texto…');
        }
      }
    }).then(function (w) {
      sharedWorker = w;
      return w;
    }).catch(function (err) {
      sharedWorkerPromise = null;   // permite reintento
      throw err;
    });

    return sharedWorkerPromise;
  }

  /* ---------------------------------------------------------------------
     Pre-proceso de imagen → canvas de trabajo.
     1) File → bitmap (createImageBitmap si existe, si no Image+objectURL).
     2) Dibuja a resolución natural; si el ancho < TARGET_MIN_WIDTH, escala
        hasta ~1100-1400px de ancho.
     Devuelve Promise<HTMLCanvasElement> o null si no se pudo decodificar.
     --------------------------------------------------------------------- */
  function fileToCanvas(file) {
    return decodeImage(file).then(function (img) {
      if (!img) return null;
      var natW = img.width || img.naturalWidth || 0;
      var natH = img.height || img.naturalHeight || 0;
      if (!natW || !natH) return null;

      // Factor de escala: subimos imágenes chicas, no agrandamos de más.
      var scale = 1;
      if (natW < TARGET_MIN_WIDTH) {
        scale = TARGET_MIN_WIDTH / natW;
        // No pasamos del máximo objetivo.
        if (natW * scale > TARGET_MAX_WIDTH) scale = TARGET_MAX_WIDTH / natW;
      }

      var cw = Math.round(natW * scale);
      var ch = Math.round(natH * scale);

      var canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      // Fondo blanco: si la imagen tiene transparencia, el OCR y el muestreo
      // de color funcionan mejor sobre blanco que sobre negro.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, ch);
      try {
        ctx.drawImage(img, 0, 0, cw, ch);
      } catch (e) {
        console.warn('OCR: drawImage falló:', e);
        return null;
      }

      // Liberamos el bitmap si corresponde.
      if (img.close && typeof img.close === 'function') {
        try { img.close(); } catch (e) {}
      }
      return canvas;
    }).catch(function (e) {
      console.warn('OCR: no se pudo preparar el canvas:', e);
      return null;
    });
  }

  // Decodifica el File/Blob a algo dibujable (ImageBitmap o HTMLImageElement).
  function decodeImage(file) {
    if (!file) return Promise.resolve(null);

    // Ruta moderna: createImageBitmap (rápida, sin tocar el DOM).
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file).catch(function () {
        // Caemos al método clásico si el navegador no soporta el tipo.
        return decodeViaImageElement(file);
      });
    }
    return decodeViaImageElement(file);
  }

  function decodeViaImageElement(file) {
    return new Promise(function (resolve) {
      var url;
      try { url = URL.createObjectURL(file); }
      catch (e) { resolve(null); return; }

      var img = new Image();
      img.onload = function () {
        // No revocamos el objectURL hasta haber dibujado; pero como el
        // consumidor dibuja de inmediato tras resolver, lo revocamos en el
        // siguiente tick para evitar fugas.
        setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 0);
        resolve(img);
      };
      img.onerror = function () {
        try { URL.revokeObjectURL(url); } catch (e) {}
        resolve(null);
      };
      img.src = url;
    });
  }

  /* ---------------------------------------------------------------------
     extract — punto de entrada público.
     NUNCA hace throw: ante cualquier fallo → console.warn + resuelve [].
     --------------------------------------------------------------------- */
  function extract(file, opts) {
    opts = opts || {};

    // Envolvemos TODO en una promesa que jamás rechaza.
    return new Promise(function (resolve) {
      // Salida segura: loguea y resuelve [].
      function bail(msg, err) {
        if (msg) console.warn('OCR.extract: ' + msg, err || '');
        resolve([]);
      }

      if (!file) { bail('no se recibió archivo.'); return; }

      report(opts, 0.02, 'Preparando imagen…');

      // 1) Pre-proceso: File → canvas de trabajo.
      fileToCanvas(file).then(function (canvas) {
        if (!canvas) { bail('no se pudo decodificar la imagen.'); return; }

        report(opts, 0.05, 'Cargando motor de lectura…');

        // 2) Carga (perezosa) de Tesseract.
        loadTesseractScript().then(function (Tesseract) {
          report(opts, 0.1, 'Motor listo, leyendo…');

          // 3) Worker reutilizable.
          getWorker(Tesseract, opts).then(function (worker) {

            // 4) Reconocimiento sobre NUESTRO canvas (mismas coordenadas).
            worker.recognize(canvas).then(function (res) {
              var data = res && res.data ? res.data : null;
              report(opts, 0.9, 'Interpretando movimientos…');

              // 5) Parseo puro → Partials.
              var partials;
              try {
                partials = parseFromOcr(data, canvas, opts);
              } catch (e) {
                console.warn('OCR.extract: parseo falló:', e);
                partials = [];
              }

              report(opts, 1, 'Listo');
              resolve(partials || []);
            }).catch(function (e) {
              // Falló el reconocimiento: el worker puede quedar inestable,
              // lo desechamos para que la próxima imagen cree uno limpio.
              disposeWorker();
              bail('recognize falló.', e);
            });

          }).catch(function (e) {
            bail('no se pudo crear el worker de Tesseract.', e);
          });

        }).catch(function (e) {
          bail('no se pudo cargar Tesseract desde el CDN.', e);
        });

      }).catch(function (e) {
        bail('error inesperado preparando la imagen.', e);
      });
    });
  }

  // Termina y olvida el worker compartido (para reintentos tras un fallo).
  function disposeWorker() {
    var w = sharedWorker;
    sharedWorker = null;
    sharedWorkerPromise = null;
    if (w && typeof w.terminate === 'function') {
      try { w.terminate(); } catch (e) {}
    }
  }

  /* ---------------------------------------------------------------------
     Exposición pública.
     --------------------------------------------------------------------- */
  window.OCR = {
    extract: extract,
    parseFromOcr: parseFromOcr,
    classifyColor: classifyColor,
    // Auxiliares expuestos por si la app/tests los quieren reutilizar.
    matchAmount: matchAmount,
    resolveDate: resolveDate
  };
})();
