/* =========================================================================
   store.js — Capa de datos + DEDUPLICACIÓN + agregación por día.
   Sin backend. Persiste en localStorage. Expone window.Store.

   Modelo de transacción:
     {
       id:     "t_xxxx",
       name:   "Ketti Ver*",
       date:   "2026-06-09",   // ISO yyyy-mm-dd
       time:   "08:54",        // 24h HH:MM  ("" si no se conoce)
       amount: 3,              // monto positivo en soles
       type:   "income"|"expense",
       source: "captura-1.png",
       note:   ""
     }

   Clave de dedup: nombre(normalizado)+fecha+hora+monto+tipo.
   Si dos filas comparten esa clave => es la MISMA operación (foto repetida
   o capturas que se solapan) y NO se vuelve a sumar.
   ========================================================================= */
(function () {
  'use strict';

  var STORAGE_KEY = 'control_pasajes_v1';
  var listeners = [];
  var cache = null;

  function uid() {
    return 't_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  }

  function load() {
    if (cache) return cache;
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      cache = raw ? JSON.parse(raw) : [];
    } catch (e) { cache = []; }
    if (!Array.isArray(cache)) cache = [];
    return cache;
  }

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cache)); } catch (e) {}
    emit();
  }

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](); } catch (e) {}
    }
  }

  /* ---- normalización para comparar ---- */
  function normName(n) {
    return (n == null ? '' : String(n))
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita tildes
      .replace(/[*]+/g, '')                              // quita asteriscos de nombre enmascarado
      .replace(/[^a-z0-9\s]/g, ' ')                      // deja letras/números
      .replace(/\s+/g, ' ')
      .trim();
  }

  function num(a) {
    if (typeof a === 'number') return Math.round(a * 100) / 100;
    var s = String(a == null ? '' : a).replace(/[^0-9.,-]/g, '').replace(/\.(?=.*\.)/g, '');
    // si usan coma decimal
    if (/,\d{1,2}$/.test(s) && !/\.\d/.test(s)) s = s.replace(',', '.');
    s = s.replace(/,/g, '');
    var x = parseFloat(s);
    return isNaN(x) ? 0 : Math.round(Math.abs(x) * 100) / 100;
  }

  function keyOf(t) {
    return [
      normName(t.name),
      t.date || '',
      t.time || '',
      num(t.amount).toFixed(2),
      t.type || 'income'
    ].join('|');
  }

  function clean(partial) {
    return {
      id: partial.id || uid(),
      name: (partial.name || '').toString().trim() || '(sin nombre)',
      date: partial.date || '',
      time: partial.time || '',
      amount: num(partial.amount),
      type: partial.type === 'expense' ? 'expense' : 'income',
      source: partial.source || '',
      note: partial.note || ''
    };
  }

  /* =====================================================================
     API pública
     ===================================================================== */
  var Store = {
    STORAGE_KEY: STORAGE_KEY,

    all: function () { return load().slice(); },

    keyOf: keyOf,
    normName: normName,
    num: num,

    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },

    hasData: function () { return load().length > 0; },

    /* Clasifica un lote ENTRANTE marcando cuáles serían duplicados
       (contra lo guardado + contra filas anteriores del mismo lote).
       Devuelve copias limpias con campo _dup. NO guarda nada. */
    classifyBatch: function (list) {
      var existing = {};
      load().forEach(function (t) { existing[keyOf(t)] = true; });
      var seen = {};
      return (list || []).map(function (p) {
        var t = clean(p);
        var k = keyOf(t);
        var dup = !!existing[k] || !!seen[k];
        seen[k] = true;
        t._dup = dup;
        return t;
      });
    },

    /* Agrega muchas, deduplicando contra lo existente y dentro del lote.
       Devuelve {addedCount, dupCount, added:[]}. */
    addMany: function (list) {
      var arr = load();
      var have = {};
      arr.forEach(function (t) { have[keyOf(t)] = true; });
      var added = [], dup = 0;
      (list || []).forEach(function (p) {
        var t = clean(p);
        delete t._dup;
        var k = keyOf(t);
        if (have[k]) { dup++; return; }
        have[k] = true;
        arr.push(t);
        added.push(t);
      });
      cache = arr;
      persist();
      return { addedCount: added.length, dupCount: dup, added: added };
    },

    add: function (partial) { return this.addMany([partial]); },

    update: function (id, patch) {
      var arr = load();
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].id === id) {
          arr[i] = clean(Object.assign({}, arr[i], patch, { id: id }));
          break;
        }
      }
      persist();
    },

    remove: function (id) {
      cache = load().filter(function (t) { return t.id !== id; });
      persist();
    },

    removeDay: function (date) {
      cache = load().filter(function (t) { return t.date !== date; });
      persist();
    },

    clearAll: function () { cache = []; persist(); },

    /* Agrupado por día, ordenado de más reciente a más antiguo. */
    byDay: function () {
      var map = {};
      load().forEach(function (t) {
        var d = t.date || 'sin-fecha';
        if (!map[d]) map[d] = { date: d, income: 0, expense: 0, net: 0, count: 0, incomeCount: 0, expenseCount: 0, txns: [] };
        var g = map[d];
        g.txns.push(t);
        g.count++;
        if (t.type === 'expense') { g.expense += t.amount; g.expenseCount++; }
        else { g.income += t.amount; g.incomeCount++; }
      });
      var out = Object.keys(map).map(function (d) {
        var g = map[d];
        g.net = Math.round((g.income - g.expense) * 100) / 100;
        g.income = Math.round(g.income * 100) / 100;
        g.expense = Math.round(g.expense * 100) / 100;
        g.txns.sort(function (a, b) { return (b.time || '').localeCompare(a.time || ''); });
        return g;
      });
      out.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
      return out;
    },

    totals: function () {
      var inc = 0, exp = 0, count = 0, days = {};
      load().forEach(function (t) {
        if (t.type === 'expense') exp += t.amount; else { inc += t.amount; count++; }
        if (t.date) days[t.date] = true;
      });
      return {
        income: Math.round(inc * 100) / 100,
        expense: Math.round(exp * 100) / 100,
        net: Math.round((inc - exp) * 100) / 100,
        count: count,
        days: Object.keys(days).length
      };
    },

    /* ---- Datos de ejemplo: las 4 capturas que envió el usuario ---- */
    seedSample: function () {
      this.addMany(window.SAMPLE_DATA || []);
    }
  };

  window.Store = Store;
})();

/* =========================================================================
   SAMPLE_DATA — transacciones extraídas a mano de las 4 capturas enviadas.
   Foto 1 = 09 jun. 2026 (fecha explícita).
   Fotos 2-4 = "Hoy"/"Ayer" (la app las muestra con fechas editables).
     Hoy  -> 2026-06-11   Ayer -> 2026-06-10   (ajustables en la app)
   Incluye filas repetidas A PROPÓSITO (Jamille Ger*, Livia Gar*) para que
   se vea el dedup en acción: al cargar, se cuentan una sola vez.
   ========================================================================= */
window.SAMPLE_DATA = [
  /* ---- Foto 1: 09 jun. 2026 ---- */
  { name: '(nombre no visible)', date: '2026-06-09', time: '12:42', amount: 4, type: 'income', source: 'captura1' },
  { name: 'Plin - Pasajero 1', date: '2026-06-09', time: '12:42', amount: 2, type: 'income', source: 'captura1', note: 'Recibiste un PLIN' },
  { name: 'Plin - Pasajero 2', date: '2026-06-09', time: '09:23', amount: 1, type: 'income', source: 'captura1' },
  { name: 'Ketti Ver*', date: '2026-06-09', time: '08:54', amount: 3, type: 'income', source: 'captura1' },
  { name: 'Ketti Ver*', date: '2026-06-09', time: '08:53', amount: 8, type: 'income', source: 'captura1' },
  { name: 'Yon Cor*', date: '2026-06-09', time: '08:29', amount: 6, type: 'income', source: 'captura1' },
  { name: 'Alexander Gon*', date: '2026-06-09', time: '07:44', amount: 4, type: 'income', source: 'captura1' },
  { name: 'Sara Sam*', date: '2026-06-09', time: '07:39', amount: 2, type: 'income', source: 'captura1' },
  { name: '*** *** 705', date: '2026-06-09', time: '07:32', amount: 3, type: 'expense', source: 'captura1' },
  { name: 'Mirian Non*', date: '2026-06-09', time: '07:17', amount: 9, type: 'income', source: 'captura1' },
  { name: 'Elida Gar*', date: '2026-06-09', time: '06:49', amount: 300, type: 'expense', source: 'captura1' },
  { name: 'Axel Baz*', date: '2026-06-09', time: '', amount: 3, type: 'income', source: 'captura1' },

  /* ---- Foto 2: "Hoy" (8:34) ---- */
  { name: 'Rene Gar*', date: '2026-06-11', time: '19:42', amount: 12, type: 'income', source: 'captura2' },
  { name: 'Izi*Laferiadelasgolosinas', date: '2026-06-11', time: '18:34', amount: 2, type: 'expense', source: 'captura2' },
  { name: 'Luis Sil*', date: '2026-06-11', time: '18:28', amount: 4, type: 'expense', source: 'captura2' },
  { name: 'Diana Bri*', date: '2026-06-11', time: '18:15', amount: 4, type: 'income', source: 'captura2' },
  { name: 'Lizbet Arc*', date: '2026-06-11', time: '18:14', amount: 4, type: 'income', source: 'captura2' },
  { name: 'Lionar Cie*', date: '2026-06-11', time: '18:08', amount: 3, type: 'income', source: 'captura2' },
  { name: 'Nancy Cip*', date: '2026-06-11', time: '18:08', amount: 3, type: 'income', source: 'captura2' },
  { name: 'Luis Tol*', date: '2026-06-11', time: '17:46', amount: 2, type: 'income', source: 'captura2' },
  { name: 'Ibe Enr*', date: '2026-06-11', time: '17:44', amount: 2, type: 'income', source: 'captura2' },
  { name: 'Jorge Per*', date: '2026-06-11', time: '17:19', amount: 2, type: 'expense', source: 'captura2' },
  { name: 'Jamille Ger*', date: '2026-06-11', time: '17:09', amount: 2, type: 'income', source: 'captura2' },

  /* ---- Foto 3: "Hoy" (8:34) — Jamille Ger* se repite (dedup) ---- */
  { name: 'Jamille Ger*', date: '2026-06-11', time: '17:09', amount: 2, type: 'income', source: 'captura3' },
  { name: 'Jessica Ari*', date: '2026-06-11', time: '17:05', amount: 3, type: 'income', source: 'captura3' },
  { name: 'Aniceto Gir*', date: '2026-06-11', time: '16:52', amount: 2, type: 'income', source: 'captura3' },
  { name: 'Iahn Mel*', date: '2026-06-11', time: '15:54', amount: 4, type: 'income', source: 'captura3' },
  { name: 'Luz Pal*', date: '2026-06-11', time: '14:07', amount: 8, type: 'income', source: 'captura3' },
  { name: 'Juan Sua*', date: '2026-06-11', time: '14:04', amount: 4, type: 'income', source: 'captura3' },
  { name: 'Yunila Nun*', date: '2026-06-11', time: '14:04', amount: 4, type: 'income', source: 'captura3' },
  { name: 'BCP - Pasajero 3', date: '2026-06-11', time: '12:35', amount: 8, type: 'income', source: 'captura3' },
  { name: 'Patricia Dia*', date: '2026-06-11', time: '10:16', amount: 3, type: 'income', source: 'captura3' },
  { name: 'Wilder Mun*', date: '2026-06-11', time: '10:16', amount: 8, type: 'income', source: 'captura3' },
  { name: 'Livia Gar*', date: '2026-06-11', time: '09:50', amount: 4, type: 'income', source: 'captura3' },

  /* ---- Foto 4: "Hoy"/"Ayer" (8:49) — Livia Gar* se repite (dedup) ---- */
  { name: 'Livia Gar*', date: '2026-06-11', time: '09:50', amount: 4, type: 'income', source: 'captura4' },
  { name: 'Olga Aye*', date: '2026-06-11', time: '08:16', amount: 4, type: 'income', source: 'captura4' },
  { name: 'Martha Cha*', date: '2026-06-11', time: '08:14', amount: 8, type: 'income', source: 'captura4' },
  { name: 'Lizeth Esp*', date: '2026-06-11', time: '07:59', amount: 3, type: 'income', source: 'captura4' },
  { name: '*** *** 453', date: '2026-06-11', time: '07:55', amount: 3, type: 'expense', source: 'captura4' },
  { name: 'Julissa Aye*', date: '2026-06-11', time: '07:48', amount: 1, type: 'income', source: 'captura4' },
  { name: 'Elvia Sus*', date: '2026-06-11', time: '07:26', amount: 2, type: 'income', source: 'captura4' },
  { name: 'Plin - Pasajero 4', date: '2026-06-11', time: '06:58', amount: 4, type: 'income', source: 'captura4' },
  { name: 'Luis Col*', date: '2026-06-10', time: '21:46', amount: 4, type: 'income', source: 'captura4' },
  { name: 'Sully Are*', date: '2026-06-10', time: '21:37', amount: 6, type: 'income', source: 'captura4' },
  { name: 'Maria Sil*', date: '2026-06-10', time: '21:19', amount: 3, type: 'income', source: 'captura4' }
];
