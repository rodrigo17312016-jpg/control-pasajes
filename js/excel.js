/* =========================================================================
   excel.js — Importa el "Reporte de Transacciones" de Yape (.xlsx).

   Mucho más confiable que el OCR: lee la hoja "Movimientos" con columnas
   [Tipo de Transacción | Origen | Destino | Monto | Mensaje | Fecha de operación].
     - "TE PAGÓ"  => ingreso  (name = Origen, quien te pagó)
     - "PAGASTE"  => gasto    (name = Destino, a quien le pagaste)

   Expone window.ExcelImport con el MISMO contrato que OCR.extract:
     ExcelImport.extract(file, opts) -> Promise<Array<Partial>>
       Partial = { name, date:"YYYY-MM-DD", time:"HH:MM", amount, type, source, note }
   Nunca hace throw: ante cualquier fallo console.warn + resuelve [].

   Usa SheetJS (xlsx) cargado de CDN de forma perezosa.
   ========================================================================= */
(function () {
  'use strict';

  var CDN = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  var loadP = null;

  function loadXLSX() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (loadP) return loadP;
    loadP = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = CDN; s.async = true;
      s.onload = function () { window.XLSX ? resolve(window.XLSX) : reject(new Error('XLSX no quedó disponible')); };
      s.onerror = function () { if (s.parentNode) s.parentNode.removeChild(s); reject(new Error('No se pudo cargar XLSX')); };
      (document.head || document.documentElement).appendChild(s);
    }).catch(function (e) { loadP = null; throw e; });
    return loadP;
  }

  function p2(n) { return String(n).padStart(2, '0'); }
  function norm(s) { return (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim(); }
  function lower(s) { return norm(s).toLowerCase(); }

  // "DD/MM/YYYY HH:MM:SS" (texto) o un objeto Date -> { date:"YYYY-MM-DD", time:"HH:MM" }
  function parseFecha(v) {
    if (v == null || v === '') return { date: '', time: '' };
    if (v instanceof Date && !isNaN(v.getTime())) {
      return { date: v.getFullYear() + '-' + p2(v.getMonth() + 1) + '-' + p2(v.getDate()), time: p2(v.getHours()) + ':' + p2(v.getMinutes()) };
    }
    var s = String(v).trim();
    var m = /(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T]+(\d{1,2}):(\d{2}))?/.exec(s);
    if (m) {
      var time = (m[4] != null) ? p2(m[4]) + ':' + m[5] : '';
      // DD/MM/YYYY  ->  YYYY-MM-DD   (m[1]=día, m[2]=mes, m[3]=año)
      return { date: m[3] + '-' + p2(m[2]) + '-' + p2(m[1]), time: time };
    }
    // ISO por si acaso
    var iso = /(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(s);
    if (iso) return { date: iso[1] + '-' + iso[2] + '-' + iso[3], time: iso[4] != null ? p2(iso[4]) + ':' + iso[5] : '' };
    return { date: '', time: '' };
  }

  function toNumber(v) {
    if (typeof v === 'number') return Math.round(Math.abs(v) * 100) / 100;
    var s = String(v == null ? '' : v).replace(/[^\d.,]/g, '');
    if (/,\d{1,2}$/.test(s) && s.indexOf('.') < 0) s = s.replace(',', '.');
    s = s.replace(/,/g, '');
    var x = parseFloat(s);
    return isNaN(x) ? 0 : Math.round(Math.abs(x) * 100) / 100;
  }

  function fileToArrayBuffer(file) {
    if (file.arrayBuffer) return file.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error || new Error('FileReader error')); };
      fr.readAsArrayBuffer(file);
    });
  }

  function extract(file, opts) {
    opts = opts || {};
    var source = opts.source || 'excel';
    if (opts.onProgress) opts.onProgress(0.1, 'Abriendo Excel…');

    return loadXLSX().then(function (XLSX) {
      if (opts.onProgress) opts.onProgress(0.4, 'Leyendo reporte…');
      return fileToArrayBuffer(file).then(function (buf) {
        var wb = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true });
        var ws = wb.Sheets['Movimientos'] || wb.Sheets[wb.SheetNames[0]];
        if (!ws) return [];
        var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });

        // 1) localizar la fila de encabezados y mapear columnas por su texto.
        var hr = -1, col = {};
        for (var i = 0; i < aoa.length && i < 20; i++) {
          var rowHas = (aoa[i] || []).some(function (c) { return lower(c).indexOf('tipo de transacc') >= 0; });
          if (rowHas) {
            hr = i;
            (aoa[i] || []).forEach(function (h, j) {
              var hl = lower(h);
              if (hl.indexOf('tipo') >= 0) col.tipo = j;
              else if (hl.indexOf('origen') >= 0) col.origen = j;
              else if (hl.indexOf('destino') >= 0) col.destino = j;
              else if (hl.indexOf('monto') >= 0) col.monto = j;
              else if (hl.indexOf('mensaje') >= 0) col.msg = j;
              else if (hl.indexOf('fecha') >= 0) col.fecha = j;
            });
            break;
          }
        }
        if (hr < 0 || col.tipo == null || col.monto == null) {
          console.warn('ExcelImport: no parece un reporte de Yape (sin encabezados esperados).');
          return [];
        }

        // 2) mapear filas -> Partials.
        var out = [];
        for (var r = hr + 1; r < aoa.length; r++) {
          var row = aoa[r]; if (!row) continue;
          var tipo = lower(row[col.tipo]);
          if (!tipo) continue;
          var type = (tipo.indexOf('te pag') === 0) ? 'income'
            : (tipo.indexOf('pagaste') >= 0 ? 'expense'
              : (tipo.indexOf('te ') === 0 ? 'income' : 'expense'));
          var name = norm(type === 'income' ? row[col.origen] : row[col.destino]);
          var amount = toNumber(row[col.monto]);
          if (!amount || amount <= 0) continue;
          var df = parseFecha(col.fecha != null ? row[col.fecha] : '');
          out.push({
            name: name || '(sin nombre)',
            date: df.date,
            time: df.time,
            amount: amount,
            type: type,
            source: source,
            note: col.msg != null ? norm(row[col.msg]) : ''
          });
        }
        if (opts.onProgress) opts.onProgress(1, 'Listo');
        return out;
      });
    }).catch(function (e) {
      console.warn('ExcelImport.extract falló:', e);
      return [];
    });
  }

  window.ExcelImport = { extract: extract };
})();
