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
     1) Pre-proceso: el File se dibuja en un <canvas> propio. Tesseract LEE
        de ese canvas y el muestreo de color SALE del mismo canvas → los bbox
        quedan en el MISMO sistema de coordenadas.
     2) Tesseract.js v2.1.5 (UMD, CDN lazy) con la API clásica
        (load → loadLanguage → initialize). Devuelve data.words con bbox.
        (La v4 con createWorker(lang,oem) NO auto-inicializaba el motor en
         este entorno → "Cannot read properties of null (reading
         'SetImageFile')". La v2 sí inicializa de forma fiable.)
     3) Reconstrucción A NIVEL DE PALABRA: agrupamos las palabras en "filas
        visuales" por su posición vertical. Cada fila que contiene un monto
        a la derecha es un movimiento; el NOMBRE son las palabras a su
        izquierda; la FECHA/HORA es la fila gris de abajo. Esto funciona tanto
        si el nombre y el monto quedan en la MISMA línea como en líneas
        separadas (Tesseract los agrupa distinto según el espacio).
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

  // Tesseract.js v2.1.5 (UMD). API clásica fiable (init explícito).
  var TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@2.1.5/dist/tesseract.min.js';
  var TESSERACT_LANG = 'spa';

  // Ancho objetivo del canvas de trabajo: solo SUBIMOS imágenes chicas
  // (las capturas de celular ya vienen ~1080px y se dejan como están).
  var TARGET_MIN_WIDTH = 1000;
  var TARGET_MAX_WIDTH = 1400;

  // Tolerancia vertical (fracción del alto de palabra) para agrupar palabras
  // en una misma fila visual.
  var ROW_TOL = 0.6;

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
  function cleanNumber(raw) {
    if (raw == null) return NaN;
    var s = String(raw).trim().replace(/[^\d.,]/g, '');
    if (!s) return NaN;

    var hasDot = s.indexOf('.') >= 0;
    var hasComma = s.indexOf(',') >= 0;

    if (hasDot && hasComma) {
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
        s = s.replace(/\./g, '').replace(',', '.');   // 1.234,50 → coma decimal
      } else {
        s = s.replace(/,/g, '');                       // 1,234.50 → punto decimal
      }
    } else if (hasComma) {
      if (/,\d{1,2}$/.test(s)) s = s.replace(',', '.');
      else s = s.replace(/,/g, '');
    }
    var x = parseFloat(s);
    return isNaN(x) ? NaN : Math.abs(x);
  }

  /* ---------------------------------------------------------------------
     matchAmount — detecta un monto tipo "S/ 4.00" tolerando errores de OCR.
     "S/" puede leerse como: S/, SI, S1, S|, $/, 5/, etc. La "/" suele leerse
     como I, 1, l o |.  Devuelve { value:Number, neg:Boolean } o null.
     --------------------------------------------------------------------- */
  function matchAmount(text) {
    if (!text) return null;
    // (signo)? + [S5$] + (separador tipo "/") + número con 2 decimales preferente.
    var re = /(-|–|—)?\s*[S5$]\s*[\/I1l|]\s*([\d][\d.,]*)/i;
    var m = re.exec(text);
    if (m) {
      var val = cleanNumber(m[2]);
      if (!isNaN(val)) return { value: val, neg: !!m[1] };
    }
    // Plan B: la "/" se perdió por completo ("S 4.00", "SI 4.00", "5 4.00").
    var re2 = /(-|–|—)?\s*[S5$][I1l|\/]?\s+([\d][\d.,]*\.\d{2}|[\d][\d.,]*)/i;
    var m2 = re2.exec(text);
    if (m2) {
      var val2 = cleanNumber(m2[2]);
      if (!isNaN(val2)) return { value: val2, neg: !!m2[1] };
    }
    return null;
  }

  /* ---------------------------------------------------------------------
     Detector de "línea de fecha": contiene una hora (HH:MM) Y/O
     "Hoy"/"Ayer"/un mes abreviado.
     --------------------------------------------------------------------- */
  function looksLikeDateLine(text) {
    if (!text) return false;
    var t = text.toLowerCase();
    if (/\b\d{1,2}:\d{2}\b/.test(t)) return true;
    if (/\b(hoy|ayer)\b/.test(t)) return true;
    if (new RegExp('\\b(' + MESES.join('|') + ')\\.?\\b').test(t)) return true;
    return false;
  }

  /* ---------------------------------------------------------------------
     Resolución de fecha + hora.
     --------------------------------------------------------------------- */
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

  function parseTime(text) {
    if (!text) return '';
    var m = /(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?/i.exec(text);
    var h, min, ap = null;
    if (m) {
      h = parseInt(m[1], 10); min = m[2]; ap = m[3].toLowerCase();
    } else {
      var m2 = /(\d{1,2}):(\d{2})/.exec(text);
      if (!m2) return '';
      h = parseInt(m2[1], 10); min = m2[2];
    }
    if (isNaN(h) || h > 23) return '';
    if (ap) {
      if (ap === 'p' && h < 12) h += 12;
      if (ap === 'a' && h === 12) h = 0;
    }
    return String(h).padStart(2, '0') + ':' + min;
  }

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
      if (mi >= 0) return { date: mAbs[3] + '-' + mm + '-' + dd, time: time };
    }
    // 2) "Hoy" → refDate.
    if (/\bhoy\b/.test(lower)) return { date: refDate || '', time: time };
    // 3) "Ayer" → refDate - 1 día.
    if (/\bayer\b/.test(lower)) return { date: refDate ? shiftISO(refDate, -1) : '', time: time };
    // 4) Sin pista de fecha → refDate como fallback.
    return { date: refDate || '', time: time };
  }

  /* ---------------------------------------------------------------------
     classifyColor — "income"/"expense" por color del texto del monto.
     INGRESO = oscuro/negro. GASTO = ROJO.
     --------------------------------------------------------------------- */
  function classifyColor(canvas, bbox) {
    if (!canvas || !bbox) return 'income';
    try {
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      var pad = 2;
      var x = Math.max(0, Math.floor(bbox.x0) - pad);
      var y = Math.max(0, Math.floor(bbox.y0) - pad);
      var x1 = Math.min(canvas.width, Math.ceil(bbox.x1) + pad);
      var y1 = Math.min(canvas.height, Math.ceil(bbox.y1) + pad);
      var w = x1 - x, h = y1 - y;
      if (w <= 0 || h <= 0) return 'income';

      var img = ctx.getImageData(x, y, w, h).data;
      var sumR = 0, sumG = 0, sumB = 0, count = 0;
      for (var i = 0; i < img.length; i += 4) {
        var r = img[i], g = img[i + 1], b = img[i + 2], a = img[i + 3];
        if (a < 32) continue;
        if ((r + g + b) / 3 >= 210) continue;   // casi-blanco = fondo
        sumR += r; sumG += g; sumB += b; count++;
      }
      if (count === 0) return 'income';
      var avgR = sumR / count, avgG = sumG / count, avgB = sumB / count;
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
    if (/^movimientos?$/.test(t)) return true;
    if (/^(hoy|ayer)$/.test(t)) return true;
    if (/^[\d\s.,:/-]+$/.test(t)) return true;   // puro número/símbolo
    return false;
  }

  /* ---------------------------------------------------------------------
     Reúne TODAS las palabras (con bbox) del resultado de Tesseract.
     Soporta data.words directo o derivarlas de data.lines[].words.
     --------------------------------------------------------------------- */
  function collectWords(ocrData) {
    var raw = [];
    if (ocrData && Array.isArray(ocrData.words) && ocrData.words.length) {
      raw = ocrData.words;
    } else if (ocrData && Array.isArray(ocrData.lines)) {
      ocrData.lines.forEach(function (l) { (l.words || []).forEach(function (w) { raw.push(w); }); });
    } else if (ocrData && Array.isArray(ocrData.blocks)) {
      ocrData.blocks.forEach(function (bl) {
        (bl.paragraphs || []).forEach(function (p) {
          (p.lines || []).forEach(function (l) { (l.words || []).forEach(function (w) { raw.push(w); }); });
        });
      });
    }
    var out = [];
    raw.forEach(function (w) {
      if (!w || !w.bbox) return;
      var txt = String(w.text == null ? '' : w.text).trim();
      if (!txt) return;
      var b = w.bbox;
      out.push({
        text: txt,
        x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1,
        cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, h: (b.y1 - b.y0)
      });
    });
    return out;
  }

  /* ---------------------------------------------------------------------
     Agrupa palabras en FILAS visuales por cercanía vertical.
     --------------------------------------------------------------------- */
  function clusterRows(words) {
    var ws = words.slice().sort(function (a, b) { return a.cy - b.cy; });
    var rows = [];
    ws.forEach(function (w) {
      var row = null;
      for (var i = rows.length - 1; i >= 0 && i >= rows.length - 3; i--) {
        var r = rows[i];
        if (Math.abs(r.cy - w.cy) <= Math.max(r.h, w.h) * ROW_TOL) { row = r; break; }
      }
      if (row) {
        row.words.push(w); row.sumcy += w.cy;
        row.cy = row.sumcy / row.words.length;
        row.h = Math.max(row.h, w.h);
      } else {
        rows.push({ cy: w.cy, sumcy: w.cy, h: w.h, words: [w] });
      }
    });
    rows.sort(function (a, b) { return a.cy - b.cy; });
    rows.forEach(function (r) {
      r.words.sort(function (a, b) { return a.x0 - b.x0; });
      r.text = r.words.map(function (w) { return w.text; }).join(' ').replace(/\s+/g, ' ').trim();
    });
    return rows;
  }

  // Une los bbox de un grupo de palabras.
  function unionBbox(arr) {
    return {
      x0: Math.min.apply(null, arr.map(function (w) { return w.x0; })),
      y0: Math.min.apply(null, arr.map(function (w) { return w.y0; })),
      x1: Math.max.apply(null, arr.map(function (w) { return w.x1; })),
      y1: Math.max.apply(null, arr.map(function (w) { return w.y1; }))
    };
  }

  /* ---------------------------------------------------------------------
     parseFromOcr — FUNCIÓN PURA (testeable). Word-based.
     --------------------------------------------------------------------- */
  function parseFromOcr(ocrData, canvas, opts) {
    opts = opts || {};
    var source = opts.source || '';

    var words = collectWords(ocrData);
    if (!words.length) { console.warn('OCR.parseFromOcr: sin palabras legibles.'); return []; }

    var rows = clusterRows(words);

    // 1) Clasificar cada fila: ¿tiene monto? ¿es fecha? separar nombre/monto.
    rows.forEach(function (r) {
      r.amount = matchAmount(r.text);          // {value,neg} | null
      r.isDate = looksLikeDateLine(r.text);
      if (r.amount) {
        // localizar la palabra numérica más a la derecha (el monto).
        var startIdx = -1;
        for (var i = r.words.length - 1; i >= 0; i--) {
          if (/\d/.test(r.words[i].text)) { startIdx = i; break; }
        }
        // absorber hacia la izquierda los símbolos pegados ("S/", "-", ".", ",").
        while (startIdx - 1 >= 0 && /^[-–—S5$\/I1l|.,]+$/i.test(r.words[startIdx - 1].text)) startIdx--;
        if (startIdx >= 0) {
          var amtWords = r.words.slice(startIdx);
          r.amountBbox = unionBbox(amtWords);
          r.nameText = r.words.slice(0, startIdx).map(function (w) { return w.text; }).join(' ').replace(/\s+/g, ' ').trim();
        }
      }
    });

    // 2) Cada fila con monto = un movimiento. Su fecha = la fila de abajo.
    var out = [];
    for (var ri = 0; ri < rows.length; ri++) {
      var r = rows[ri];
      if (!r.amount || !r.amount.value || r.amount.value <= 0) continue;

      var nameTxt = r.nameText || '';
      if (isJunkName(nameTxt)) nameTxt = '';

      // fecha: la primera fila siguiente (hasta 2 abajo) que parezca fecha
      // y NO tenga monto.
      var dateText = '';
      for (var k = ri + 1; k < rows.length && k <= ri + 2; k++) {
        if (rows[k].isDate && !rows[k].amount) { dateText = rows[k].text; break; }
      }
      // a veces la fecha quedó en la MISMA fila (raro): úsala.
      if (!dateText && r.isDate) dateText = r.text;

      var df = resolveDate(dateText, opts);
      if (!nameTxt) nameTxt = '(sin nombre)';

      var type = classifyColor(canvas, r.amountBbox);
      if (type === 'income' && r.amount.neg) type = 'expense';   // "-" = gasto (respaldo)

      out.push({
        name: nameTxt,
        date: df.date || '',
        time: df.time || '',
        amount: Math.abs(Number(r.amount.value)) || 0,
        type: type === 'expense' ? 'expense' : 'income',
        source: source,
        note: ''
      });
    }

    // 3) Limpieza.
    out = out.filter(function (r) {
      if (!r.amount || r.amount <= 0) return false;
      if (/^movimientos?$/i.test(r.name.trim())) return false;
      return true;
    });

    // 4) Dedup obvio dentro de la misma imagen.
    var seen = {};
    out = out.filter(function (r) {
      var key = [r.name.toLowerCase().trim(), r.date, r.time, Number(r.amount).toFixed(2), r.type].join('|');
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });

    // 5) Orden por (date, time).
    out.sort(function (a, b) {
      return ((a.date || '') + ' ' + (a.time || '')).localeCompare((b.date || '') + ' ' + (b.time || ''));
    });

    return out;
  }

  /* ---------------------------------------------------------------------
     Carga perezosa del script UMD de Tesseract desde el CDN.
     --------------------------------------------------------------------- */
  function loadTesseractScript() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (tesseractLoadPromise) return tesseractLoadPromise;

    tesseractLoadPromise = injectScriptOnce(TESSERACT_CDN)
      .catch(function () {
        console.warn('OCR: primer intento de cargar Tesseract falló, reintentando…');
        return injectScriptOnce(TESSERACT_CDN + (TESSERACT_CDN.indexOf('?') >= 0 ? '&' : '?') + 'retry=1');
      })
      .then(function () {
        if (!window.Tesseract) throw new Error('Tesseract no quedó disponible tras cargar el script.');
        return window.Tesseract;
      })
      .catch(function (err) {
        tesseractLoadPromise = null;   // permite reintentar luego
        throw err;
      });

    return tesseractLoadPromise;
  }

  function injectScriptOnce(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () {
        if (s.parentNode) s.parentNode.removeChild(s);
        reject(new Error('No se pudo cargar el script: ' + src));
      };
      (document.head || document.documentElement).appendChild(s);
    });
  }

  /* ---------------------------------------------------------------------
     Worker de Tesseract v2 (API clásica con init explícito).
     createWorker({logger}) → load → loadLanguage('spa') → initialize('spa').
     --------------------------------------------------------------------- */
  function getWorker(Tesseract, opts) {
    if (sharedWorker) return Promise.resolve(sharedWorker);
    if (sharedWorkerPromise) return sharedWorkerPromise;

    sharedWorkerPromise = Promise.resolve()
      .then(function () {
        // createWorker en v2 devuelve el worker (no una promesa), pero lo
        // envolvemos por compatibilidad.
        return Tesseract.createWorker({
          logger: function (m) {
            if (!m) return;
            if (m.status === 'recognizing text') {
              report(opts, 0.45 + 0.5 * (m.progress || 0), 'Leyendo texto…');
            } else if (/load|initial|api|core/i.test(m.status || '')) {
              report(opts, 0.12 + 0.28 * (m.progress || 0), 'Preparando motor…');
            }
          }
        });
      })
      .then(function (worker) {
        var chain = Promise.resolve();
        if (worker && typeof worker.load === 'function') {
          chain = chain.then(function () { return worker.load(); });
        }
        return chain
          .then(function () { return worker.loadLanguage(TESSERACT_LANG); })
          .then(function () { return worker.initialize(TESSERACT_LANG); })
          .then(function () { sharedWorker = worker; return worker; });
      })
      .catch(function (err) {
        sharedWorkerPromise = null;   // permite reintento
        throw err;
      });

    return sharedWorkerPromise;
  }

  /* ---------------------------------------------------------------------
     Pre-proceso de imagen → canvas de trabajo.
     --------------------------------------------------------------------- */
  function fileToCanvas(file) {
    return decodeImage(file).then(function (img) {
      if (!img) return null;
      var natW = img.width || img.naturalWidth || 0;
      var natH = img.height || img.naturalHeight || 0;
      if (!natW || !natH) return null;

      var scale = 1;
      if (natW < TARGET_MIN_WIDTH) {
        scale = TARGET_MIN_WIDTH / natW;
        if (natW * scale > TARGET_MAX_WIDTH) scale = TARGET_MAX_WIDTH / natW;
      }

      var cw = Math.round(natW * scale);
      var ch = Math.round(natH * scale);

      var canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, ch);
      try {
        ctx.drawImage(img, 0, 0, cw, ch);
      } catch (e) {
        console.warn('OCR: drawImage falló:', e);
        return null;
      }
      if (img.close && typeof img.close === 'function') { try { img.close(); } catch (e) {} }
      return canvas;
    }).catch(function (e) {
      console.warn('OCR: no se pudo preparar el canvas:', e);
      return null;
    });
  }

  function decodeImage(file) {
    if (!file) return Promise.resolve(null);
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file).catch(function () { return decodeViaImageElement(file); });
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
        setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 0);
        resolve(img);
      };
      img.onerror = function () { try { URL.revokeObjectURL(url); } catch (e) {} resolve(null); };
      img.src = url;
    });
  }

  /* ---------------------------------------------------------------------
     extract — punto de entrada público. NUNCA hace throw.
     --------------------------------------------------------------------- */
  function extract(file, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      function bail(msg, err) {
        if (msg) console.warn('OCR.extract: ' + msg, err || '');
        resolve([]);
      }
      if (!file) { bail('no se recibió archivo.'); return; }

      report(opts, 0.02, 'Preparando imagen…');

      fileToCanvas(file).then(function (canvas) {
        if (!canvas) { bail('no se pudo decodificar la imagen.'); return; }
        report(opts, 0.05, 'Cargando motor de lectura…');

        loadTesseractScript().then(function (Tesseract) {
          report(opts, 0.1, 'Motor listo, leyendo…');

          getWorker(Tesseract, opts).then(function (worker) {
            worker.recognize(canvas).then(function (res) {
              var data = res && res.data ? res.data : null;
              report(opts, 0.95, 'Interpretando movimientos…');
              var partials;
              try { partials = parseFromOcr(data, canvas, opts); }
              catch (e) { console.warn('OCR.extract: parseo falló:', e); partials = []; }
              report(opts, 1, 'Listo');
              resolve(partials || []);
            }).catch(function (e) {
              disposeWorker();
              bail('recognize falló.', e);
            });
          }).catch(function (e) {
            disposeWorker();
            bail('no se pudo iniciar el motor de Tesseract.', e);
          });

        }).catch(function (e) {
          bail('no se pudo cargar Tesseract desde el CDN.', e);
        });

      }).catch(function (e) {
        bail('error inesperado preparando la imagen.', e);
      });
    });
  }

  function disposeWorker() {
    var w = sharedWorker;
    sharedWorker = null;
    sharedWorkerPromise = null;
    if (w && typeof w.terminate === 'function') { try { w.terminate(); } catch (e) {} }
  }

  /* ---------------------------------------------------------------------
     Exposición pública.
     --------------------------------------------------------------------- */
  window.OCR = {
    extract: extract,
    parseFromOcr: parseFromOcr,
    classifyColor: classifyColor,
    matchAmount: matchAmount,
    resolveDate: resolveDate
  };
})();
