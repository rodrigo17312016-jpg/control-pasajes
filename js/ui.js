/* =========================================================================
   ui.js — Interfaz: subida de fotos, revisión, dashboard, gráficos.
   Depende de window.Store (datos+dedup) y window.OCR (lectura de imágenes).
   Expone window.UI.init().
   ========================================================================= */
(function () {
  'use strict';

  var MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  var DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

  var state = {
    files: [],          // File[] seleccionados
    reviewRows: [],     // filas en el modal de revisión
    expanded: {},       // qué días están abiertos
    search: '',
    metric: 'income',
    chart: null,
    autoT: null,        // timer de auto-análisis al pegar
    pasteCount: 0,      // contador para nombrar imágenes pegadas
    busy: false         // hay un análisis en curso
  };

  /* ----------------------- helpers ----------------------- */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function money(n) { return 'S/ ' + (Math.round((n || 0) * 100) / 100).toFixed(2); }
  function esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function isoParts(iso) {
    var p = (iso || '').split('-');
    return { y: +p[0], m: +p[1], d: +p[2] };
  }
  function prettyDate(iso) {
    if (!iso || iso === 'sin-fecha') return 'Sin fecha';
    var p = isoParts(iso);
    var dt = new Date(p.y, p.m - 1, p.d);
    return DIAS[dt.getDay()] + ' ' + String(p.d).padStart(2, '0') + '/' + String(p.m).padStart(2, '0') + '/' + p.y;
  }
  function pretty12(t) {
    if (!t) return '';
    var pp = t.split(':'); var h = +pp[0], m = pp[1];
    var ap = h >= 12 ? 'pm' : 'am'; var h12 = h % 12; if (h12 === 0) h12 = 12;
    return h12 + ':' + m + ' ' + ap;
  }

  function toast(msg, isError) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = 'toast'; t.hidden = true; }, 3200);
  }

  /* ----------------------- selección de archivos ----------------------- */
  function fileSig(f) { return (f.name || 'img') + '|' + (f.size || 0) + '|' + (f.lastModified || 0); }

  // Agrega imágenes a la cola (sin reemplazar). Devuelve cuántas se agregaron.
  // opts.auto => dispara el análisis automático (usado al pegar).
  function addFiles(fileList, opts) {
    opts = opts || {};
    var have = {};
    state.files.forEach(function (f) { have[fileSig(f)] = true; });
    var added = 0;
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      if (!f || !/^image\//.test(f.type || '')) continue;
      var sig = fileSig(f);
      if (have[sig]) continue;
      have[sig] = true;
      state.files.push(f);
      added++;
    }
    renderChips();
    $('btnAnalyze').disabled = state.files.length === 0;
    if (added && opts.auto) scheduleAutoAnalyze();
    return added;
  }

  // Convierte un blob del portapapeles en un File con nombre único.
  function asPastedFile(blob) {
    var name = 'pegado-' + (++state.pasteCount) + '.png';
    try { return new File([blob], name, { type: blob.type || 'image/png' }); }
    catch (e) { try { blob.name = name; } catch (e2) {} return blob; }
  }

  function scheduleAutoAnalyze() {
    clearTimeout(state.autoT);
    state.autoT = setTimeout(function run() {
      if (state.busy) { state.autoT = setTimeout(run, 500); return; }
      if (state.files.length) analyze();
    }, 600);
  }

  // Ctrl + V en cualquier parte: si el portapapeles trae imagen(es), pégalas y analiza.
  function onPaste(e) {
    var dt = e.clipboardData; if (!dt) return;
    var imgs = [], i;
    if (dt.items) {
      for (i = 0; i < dt.items.length; i++) {
        var it = dt.items[i];
        if (it.kind === 'file' && /^image\//.test(it.type)) {
          var f = it.getAsFile(); if (f) imgs.push(asPastedFile(f));
        }
      }
    }
    if (!imgs.length && dt.files) {
      for (i = 0; i < dt.files.length; i++) {
        if (/^image\//.test(dt.files[i].type)) imgs.push(asPastedFile(dt.files[i]));
      }
    }
    if (!imgs.length) return; // texto u otra cosa: deja que el navegador pegue normal
    e.preventDefault();
    var n = addFiles(imgs, { auto: true });
    if (n) toast('📋 ' + n + ' imagen' + (n > 1 ? 'es' : '') + ' pegada' + (n > 1 ? 's' : '') + ' — analizando…');
  }

  // Botón "Pegar imagen": lee el portapapeles con la Clipboard API (requiere HTTPS).
  function pasteFromClipboard() {
    if (!navigator.clipboard || !navigator.clipboard.read) {
      toast('Tu navegador no permite pegar con botón. Usa Ctrl + V.', true); return;
    }
    navigator.clipboard.read().then(function (items) {
      var pending = [], imgs = [];
      items.forEach(function (it) {
        var type = (it.types || []).filter(function (t) { return /^image\//.test(t); })[0];
        if (type) pending.push(it.getType(type).then(function (blob) { imgs.push(asPastedFile(blob)); }));
      });
      Promise.all(pending).then(function () {
        if (!imgs.length) { toast('No hay ninguna imagen copiada.', true); return; }
        var n = addFiles(imgs, { auto: true });
        if (n) toast('📋 Imagen pegada — analizando…');
      });
    }).catch(function (err) {
      console.warn('clipboard.read', err);
      toast('No pude leer el portapapeles. Prueba con Ctrl + V.', true);
    });
  }
  function renderChips() {
    var box = $('fileChips');
    box.innerHTML = '';
    if (!state.files.length) { box.hidden = true; return; }
    box.hidden = false;
    state.files.forEach(function (f, i) {
      var chip = el('span', 'chip', '🖼️ ' + esc(f.name.length > 22 ? f.name.slice(0, 20) + '…' : f.name));
      var x = el('button', 'chip-x', '✕');
      x.onclick = function () { state.files.splice(i, 1); renderChips(); $('btnAnalyze').disabled = state.files.length === 0; };
      chip.appendChild(x);
      box.appendChild(chip);
    });
  }

  /* ----------------------- análisis OCR ----------------------- */
  function analyze() {
    if (state.busy) return;
    if (!window.OCR || typeof OCR.extract !== 'function') {
      toast('El motor de lectura no cargó. Recarga la página.', true);
      return;
    }
    if (!state.files.length) return;
    state.busy = true;
    var refDate = $('refDate').value || todayISO();
    var prog = $('ocrProgress'); prog.hidden = false;
    $('btnAnalyze').disabled = true;
    var bar = $('ocrProgressBar'), txt = $('ocrProgressText');

    var files = state.files.slice();
    var all = [];
    var idx = 0;

    function setProg(frac, msg) {
      bar.style.width = Math.max(3, Math.round(frac * 100)) + '%';
      txt.textContent = msg;
    }

    function next() {
      if (idx >= files.length) { done(); return; }
      var f = files[idx];
      setProg((idx) / files.length, 'Leyendo ' + (idx + 1) + ' de ' + files.length + '…');
      OCR.extract(f, {
        refDate: refDate,
        source: f.name,
        onProgress: function (p, m) {
          setProg((idx + (p || 0)) / files.length, (m || 'Leyendo') + ' (' + (idx + 1) + '/' + files.length + ')');
        }
      }).then(function (rows) {
        all = all.concat(rows || []);
        idx++;
        next();
      }).catch(function (e) {
        console.error('OCR error', e);
        idx++;
        next();
      });
    }

    function done() {
      state.busy = false;
      setProg(1, 'Listo');
      setTimeout(function () { prog.hidden = true; bar.style.width = '0%'; }, 400);
      $('btnAnalyze').disabled = false;
      if (!all.length) {
        toast('No pude leer movimientos. Prueba con una captura más nítida.', true);
        return;
      }
      openReview(all);
    }

    next();
  }

  /* ----------------------- modal de revisión ----------------------- */
  function openReview(partials) {
    state.reviewRows = Store.classifyBatch(partials);
    var newCount = state.reviewRows.filter(function (r) { return !r._dup; }).length;
    var dupCount = state.reviewRows.length - newCount;
    $('reviewSummary').innerHTML = 'Leí <b>' + state.reviewRows.length + '</b> movimientos · <b>' +
      newCount + '</b> nuevos' + (dupCount ? ' · <b>' + dupCount + '</b> duplicados (ya registrados)' : '') + '.';

    var tb = $('reviewTableBody');
    tb.innerHTML = '';
    state.reviewRows.forEach(function (r, i) {
      var tr = el('tr', r._dup ? 'dup-row' : '');
      tr.innerHTML =
        '<td><input type="checkbox" class="r-check" data-i="' + i + '" ' + (r._dup ? '' : 'checked') + '></td>' +
        '<td><input class="r-name" data-i="' + i + '" value="' + esc(r.name) + '">' +
          (r._dup ? ' <span class="badge-dup">duplicado</span>' : '') + '</td>' +
        '<td><input type="date" class="r-date" data-i="' + i + '" value="' + esc(r.date) + '"></td>' +
        '<td><input type="time" class="r-time" data-i="' + i + '" value="' + esc(r.time) + '"></td>' +
        '<td><input type="number" step="0.5" min="0" class="r-amount" data-i="' + i + '" value="' + r.amount + '"></td>' +
        '<td><select class="r-type" data-i="' + i + '">' +
          '<option value="income"' + (r.type === 'income' ? ' selected' : '') + '>Ingreso</option>' +
          '<option value="expense"' + (r.type === 'expense' ? ' selected' : '') + '>Gasto</option>' +
        '</select></td>';
      tb.appendChild(tr);
    });
    showModal('reviewModal');
  }

  function saveReview() {
    var rows = state.reviewRows;
    var picked = [];
    var checks = document.querySelectorAll('#reviewTableBody .r-check');
    checks.forEach(function (chk) {
      if (!chk.checked) return;
      var i = +chk.getAttribute('data-i');
      var q = function (sel) { return document.querySelector('#reviewTableBody .' + sel + '[data-i="' + i + '"]'); };
      picked.push({
        name: q('r-name').value,
        date: q('r-date').value,
        time: q('r-time').value,
        amount: q('r-amount').value,
        type: q('r-type').value,
        source: rows[i].source,
        note: rows[i].note
      });
    });
    if (!picked.length) { toast('No marcaste ninguna fila.', true); return; }
    var res = Store.addMany(picked);
    pushToCloud(res.added);              // sube los nuevos al registro central
    hideModal('reviewModal');
    state.files = []; renderChips(); $('btnAnalyze').disabled = true; $('fileInput').value = '';
    toast('✅ ' + res.addedCount + ' guardados' + (res.dupCount ? ' · ' + res.dupCount + ' duplicados omitidos' : ''));
    // expandir el día más reciente recién agregado
    if (res.added.length) state.expanded[res.added[0].date] = true;
    render();
  }

  /* ----------------------- modales ----------------------- */
  function showModal(id) { $(id).hidden = false; document.body.classList.add('modal-open'); }
  function hideModal(id) { $(id).hidden = true; document.body.classList.remove('modal-open'); }

  /* ----------------------- dashboard ----------------------- */
  function render() {
    var days = Store.byDay();
    var totals = Store.totals();
    var hasData = Store.hasData();

    $('emptyState').hidden = hasData;
    $('daysList').hidden = !hasData;

    // KPIs
    $('kpiIncome').textContent = money(totals.income);
    $('kpiDays').textContent = totals.days;
    $('kpiCount').textContent = totals.count;
    $('kpiExpense').textContent = totals.expense > 0 ? 'Gastos: ' + money(totals.expense) : '';

    var best = days.slice().sort(function (a, b) { return b.income - a.income; })[0];
    $('kpiBestDay').textContent = best ? prettyDate(best.date).split(' ')[1] : '—';
    $('kpiBestDayVal').textContent = best ? money(best.income) : '';

    renderChart(days);
    renderDays(days);
  }

  function renderChart(days) {
    if (!window.Chart) return;
    var asc = days.slice().filter(function (d) { return d.date !== 'sin-fecha'; })
      .sort(function (a, b) { return a.date.localeCompare(b.date); }).slice(-30);
    var labels = asc.map(function (d) { var p = isoParts(d.date); return String(p.d).padStart(2, '0') + '/' + String(p.m).padStart(2, '0'); });
    var data = asc.map(function (d) { return state.metric === 'net' ? d.net : d.income; });
    var ctx = $('incomeChart').getContext('2d');
    if (state.chart) state.chart.destroy();
    var grad = ctx.createLinearGradient(0, 0, 0, 240);
    grad.addColorStop(0, 'rgba(124,58,237,0.95)');
    grad.addColorStop(1, 'rgba(124,58,237,0.45)');
    state.chart = new Chart(ctx, {
      type: 'bar',
      data: { labels: labels, datasets: [{ label: state.metric === 'net' ? 'Neto' : 'Ingresos', data: data, backgroundColor: grad, borderRadius: 8, maxBarThickness: 46 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (c) { return money(c.parsed.y); } } }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#7c7c8a', font: { size: 11 } } },
          y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { color: '#7c7c8a', callback: function (v) { return 'S/' + v; } } }
        }
      }
    });
  }

  function renderDays(days) {
    var box = $('daysList');
    box.innerHTML = '';
    var q = state.search.trim().toLowerCase();

    days.forEach(function (g) {
      var txns = g.txns;
      if (q) txns = txns.filter(function (t) { return t.name.toLowerCase().indexOf(q) >= 0; });
      if (q && !txns.length) return;

      var open = !!state.expanded[g.date];
      var card = el('div', 'day-card' + (open ? ' open' : ''));

      var head = el('div', 'day-head');
      head.innerHTML =
        '<div class="day-left">' +
          '<span class="day-chevron">▸</span>' +
          '<div><div class="day-date">' + esc(prettyDate(g.date)) + '</div>' +
          '<div class="day-sub">' + g.incomeCount + ' cobro' + (g.incomeCount === 1 ? '' : 's') +
            (g.expense > 0 ? ' · <span class="day-expense">−' + money(g.expense) + '</span>' : '') + '</div></div>' +
        '</div>' +
        '<div class="day-income">' + money(g.income) + '</div>';
      head.onclick = function () { state.expanded[g.date] = !state.expanded[g.date]; render(); };
      card.appendChild(head);

      var body = el('div', 'day-body');
      txns.forEach(function (t) {
        var row = el('div', 'txn-row');
        row.innerHTML =
          '<span class="txn-time">' + esc(pretty12(t.time) || '—') + '</span>' +
          '<span class="txn-name">' + esc(t.name) + '</span>' +
          '<span class="txn-right">' +
            '<span class="txn-amount ' + t.type + '">' + (t.type === 'expense' ? '−' : '') + money(t.amount) + '</span>' +
            '<button class="txn-del" title="Eliminar" data-id="' + t.id + '">🗑</button>' +
          '</span>';
        row.querySelector('.txn-del').onclick = function (ev) {
          ev.stopPropagation();
          Store.remove(t.id);
          if (window.Cloud && Cloud.enabled) { Cloud.remove(t.id).then(setCloudStatus); }
          toast('Movimiento eliminado');
          render();
        };
        body.appendChild(row);
      });
      card.appendChild(body);
      box.appendChild(card);
    });

    if (q && !box.children.length) {
      box.appendChild(el('div', 'no-results', 'Sin resultados para “' + esc(state.search) + '”.'));
    }
  }

  /* ----------------------- exportar / resumen ----------------------- */
  function exportCsv() {
    var rows = Store.all();
    if (!rows.length) { toast('No hay datos para exportar.', true); return; }
    rows.sort(function (a, b) { return (b.date + b.time).localeCompare(a.date + a.time); });
    var head = ['fecha', 'hora', 'nombre', 'tipo', 'monto'];
    var lines = [head.join(',')];
    rows.forEach(function (t) {
      lines.push([t.date, t.time, '"' + (t.name || '').replace(/"/g, '""') + '"', t.type === 'expense' ? 'gasto' : 'ingreso', t.amount.toFixed(2)].join(','));
    });
    var blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pasajes_' + todayISO() + '.csv';
    a.click();
    toast('CSV descargado');
  }

  function copySummary() {
    var days = Store.byDay().filter(function (d) { return d.date !== 'sin-fecha'; })
      .sort(function (a, b) { return a.date.localeCompare(b.date); });
    if (!days.length) { toast('No hay datos.', true); return; }
    var t = Store.totals();
    var lines = ['🎫 INGRESOS POR DÍA', ''];
    days.forEach(function (d) {
      lines.push(prettyDate(d.date) + ':  ' + money(d.income) + '  (' + d.incomeCount + ' cobros)' + (d.expense > 0 ? '  · gastos ' + money(d.expense) : ''));
    });
    lines.push('', 'TOTAL INGRESOS: ' + money(t.income) + '  (' + t.count + ' cobros, ' + t.days + ' días)');
    var text = lines.join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Resumen copiado'); }, function () { toast(text); });
    } else { toast('Copiado'); }
  }

  /* ----------------------- sincronización con la nube ----------------------- */
  var PENDING_KEY = 'pasajes_cloud_pending';

  function pendingGet() {
    try { var a = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function pendingSet(arr) { try { localStorage.setItem(PENDING_KEY, JSON.stringify(arr.slice(0, 1000))); } catch (e) {} }
  function pendingAdd(ids) { var s = pendingGet(); ids.forEach(function (id) { if (s.indexOf(id) < 0) s.push(id); }); pendingSet(s); }
  function pendingRemove(ids) { var rm = {}; ids.forEach(function (id) { rm[id] = 1; }); pendingSet(pendingGet().filter(function (id) { return !rm[id]; })); }

  function setCloudStatus() {
    var el = $('cloudStatus'); if (!el) return;
    if (!window.Cloud || !Cloud.enabled) { el.textContent = '🔒 Solo este dispositivo'; el.className = 'cloud-status'; return; }
    var pend = pendingGet().length;
    if (Cloud.online === false) { el.textContent = '⚠️ Sin conexión' + (pend ? ' · ' + pend + ' por subir' : ''); el.className = 'cloud-status off'; }
    else if (pend) { el.textContent = '☁️ Subiendo ' + pend + '…'; el.className = 'cloud-status'; }
    else if (Cloud.online === true) { el.textContent = '☁️ Registro sincronizado'; el.className = 'cloud-status ok'; }
    else { el.textContent = '☁️ Conectando…'; el.className = 'cloud-status'; }
  }

  // Reintenta subir los pendientes (los que no se confirmaron en la nube).
  function flushPending() {
    if (!window.Cloud || !Cloud.enabled) return Promise.resolve();
    var ids = pendingGet(); if (!ids.length) return Promise.resolve();
    var byId = {}; Store.all().forEach(function (t) { byId[t.id] = t; });
    var txns = ids.map(function (id) { return byId[id]; }).filter(Boolean);
    if (!txns.length) { pendingSet([]); return Promise.resolve(); }
    return Cloud.push(txns).then(function (r) {
      if (r.ok) pendingRemove(txns.map(function (t) { return t.id; }));
      setCloudStatus();
    });
  }

  // Al abrir (o al tocar el chip): baja el registro central, lo fusiona y
  // reintenta lo pendiente.
  function syncFromCloud() {
    if (!window.Cloud || !Cloud.enabled) { setCloudStatus(); return; }
    setCloudStatus();
    Cloud.pull().then(function (rows) {
      if (rows && rows.length) {
        var res = Store.addMany(rows);
        if (res.addedCount) {
          var d0 = Store.byDay()[0]; if (d0) state.expanded[d0.date] = true;
          render();
        }
      }
      setCloudStatus();
      return flushPending();
    }).then(function () { setCloudStatus(); });
  }

  // Sube movimientos nuevos; si falla, quedan pendientes para el próximo intento.
  function pushToCloud(txns) {
    if (!window.Cloud || !Cloud.enabled || !txns || !txns.length) return;
    var ids = txns.map(function (t) { return t.id; });
    pendingAdd(ids); setCloudStatus();
    Cloud.push(txns).then(function (r) {
      if (r.ok) pendingRemove(ids);
      setCloudStatus();
    });
  }

  /* ----------------------- init ----------------------- */
  function init() {
    $('refDate').value = todayISO();

    // selección de archivos
    var dz = $('dropzone'), fi = $('fileInput');
    dz.onclick = function () { fi.click(); };
    dz.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } };
    fi.onchange = function () { addFiles(fi.files); fi.value = ''; };
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('dragover'); });
    });
    dz.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });

    // pegar imagen: botón (Clipboard API) + Ctrl+V global
    $('btnPaste').onclick = pasteFromClipboard;
    document.addEventListener('paste', onPaste);

    $('btnAnalyze').onclick = analyze;

    // revisión
    $('btnSaveReview').onclick = saveReview;
    $('btnCancelReview').onclick = function () { hideModal('reviewModal'); };
    $('btnCancelReview2').onclick = function () { hideModal('reviewModal'); };

    // info
    $('btnInfo').onclick = function () { showModal('infoModal'); };
    $('btnCloseInfo').onclick = function () { hideModal('infoModal'); };

    // herramientas
    $('searchInput').oninput = function () { state.search = this.value; renderDays(Store.byDay()); };
    $('btnExportCsv').onclick = exportCsv;
    $('btnCopySummary').onclick = copySummary;
    $('btnLoadSample').onclick = function () { Store.seedSample(); toast('Ejemplo cargado'); render(); };
    $('btnClearAll').onclick = function () {
      var msg = (window.Cloud && Cloud.enabled)
        ? '¿Borrar TODOS los movimientos, también del registro en la nube? Esto no se puede deshacer.'
        : '¿Borrar TODOS los movimientos? Esto no se puede deshacer.';
      if (Store.hasData() && confirm(msg)) {
        Store.clearAll();
        pendingSet([]);
        if (window.Cloud && Cloud.enabled) { Cloud.clearAll().then(setCloudStatus); }
        toast('Todo borrado'); render();
      }
    };

    // chip de estado: tocar = volver a sincronizar
    var cs = $('cloudStatus');
    if (cs) cs.onclick = function () { syncFromCloud(); };

    // toggle métrica del gráfico
    document.querySelectorAll('.chart-toggle .seg').forEach(function (b) {
      b.onclick = function () {
        document.querySelectorAll('.chart-toggle .seg').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        state.metric = b.getAttribute('data-metric');
        renderChart(Store.byDay());
      };
    });

    // cerrar modales tocando el fondo
    document.querySelectorAll('.modal').forEach(function (m) {
      m.addEventListener('click', function (e) { if (e.target === m) { m.hidden = true; document.body.classList.remove('modal-open'); } });
    });

    Store.onChange(function () { /* render se llama manualmente tras cada acción */ });

    // primer día abierto por defecto
    var d0 = Store.byDay()[0];
    if (d0) state.expanded[d0.date] = true;

    render();
    syncFromCloud();   // baja el registro central y fusiona
  }

  window.UI = { init: init, render: render };
})();
