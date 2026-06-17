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
    period: 'day',
    chart: null,
    autoT: null,        // timer de auto-análisis al pegar
    pasteCount: 0,      // contador para nombrar imágenes pegadas
    busy: false,        // hay un análisis en curso
    editId: null        // id del movimiento que se está editando
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
  function isExcel(f) { return /\.(xlsx|xls)$/i.test(f.name || '') || /spreadsheet|ms-excel/i.test(f.type || ''); }
  function isImage(f) { return /^image\//.test(f.type || ''); }
  function isAccepted(f) { return f && (isImage(f) || isExcel(f)); }

  // Agrega imágenes a la cola (sin reemplazar). Devuelve cuántas se agregaron.
  // opts.auto => dispara el análisis automático (usado al pegar).
  function addFiles(fileList, opts) {
    opts = opts || {};
    var have = {};
    state.files.forEach(function (f) { have[fileSig(f)] = true; });
    var added = 0;
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      if (!isAccepted(f)) continue;
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
      var chip = el('span', 'chip', (isExcel(f) ? '📄 ' : '🖼️ ') + esc(f.name.length > 22 ? f.name.slice(0, 20) + '…' : f.name));
      var x = el('button', 'chip-x', '✕');
      x.onclick = function () { state.files.splice(i, 1); renderChips(); $('btnAnalyze').disabled = state.files.length === 0; };
      chip.appendChild(x);
      box.appendChild(chip);
    });
  }

  /* ----------------------- análisis OCR ----------------------- */
  function analyze() {
    if (state.busy) return;
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
      var useExcel = isExcel(f);
      var engine = useExcel ? (window.ExcelImport && ExcelImport.extract) : (window.OCR && OCR.extract);
      var verb = useExcel ? 'Importando Excel' : 'Leyendo imagen';
      setProg(idx / files.length, verb + ' ' + (idx + 1) + ' de ' + files.length + '…');
      if (typeof engine !== 'function') {
        console.warn('Motor no disponible para', f.name);
        idx++; next(); return;
      }
      engine(f, {
        refDate: refDate,
        source: f.name,
        onProgress: function (p, m) {
          setProg((idx + (p || 0)) / files.length, (m || verb) + ' (' + (idx + 1) + '/' + files.length + ')');
        }
      }).then(function (rows) {
        all = all.concat(rows || []);
        idx++; next();
      }).catch(function (e) {
        console.error('extract error', e);
        idx++; next();
      });
    }

    function done() {
      state.busy = false;
      setProg(1, 'Listo');
      setTimeout(function () { prog.hidden = true; bar.style.width = '0%'; }, 400);
      $('btnAnalyze').disabled = false;
      if (!all.length) {
        toast('No encontré movimientos. Revisa el Excel de Yape o usa una captura más nítida.', true);
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
    var hasData = Store.hasData();
    $('emptyState').hidden = hasData;
    $('daysList').hidden = !hasData;
    renderKPIs();
    renderChart();
    renderDays(Store.byDay());
  }

  function renderKPIs() {
    var t = Store.totals();
    var incCount = 0, expCount = 0;
    Store.all().forEach(function (x) { if (x.type === 'expense') expCount++; else incCount++; });

    $('kpiIncome').textContent = money(t.income);
    $('kpiIncomeSub').textContent = incCount + (incCount === 1 ? ' cobro' : ' cobros');
    $('kpiExpense').textContent = money(t.expense);
    $('kpiExpenseSub').textContent = expCount + (expCount === 1 ? ' movimiento' : ' movimientos');

    var net = t.net;
    var nEl = $('kpiNet');
    nEl.textContent = (net < 0 ? '− ' : '') + money(Math.abs(net));
    nEl.classList.toggle('val-expense', net < 0);
    nEl.classList.toggle('val-income', net >= 0);
    $('kpiNetSub').textContent = net >= 0 ? 'a favor' : 'en contra';

    // Promedio adaptado al periodo seleccionado.
    var buckets = Store.byPeriod(state.period);
    var word = state.period === 'week' ? 'semanal' : (state.period === 'month' ? 'mensual' : 'diario');
    var unit = state.period === 'week' ? 'semanas' : (state.period === 'month' ? 'meses' : 'días');
    var n = buckets.length || 1;
    $('kpiAvgLabel').textContent = 'Promedio ' + word;
    $('kpiAvg').textContent = money(t.income / n);
    var best = buckets.slice().sort(function (a, b) { return b.income - a.income; })[0];
    $('kpiAvgSub').textContent = buckets.length + ' ' + unit + (best ? ' · máx ' + money(best.income) : '');
  }

  function renderChart() {
    if (!window.Chart) return;
    var period = state.period || 'day', metric = state.metric || 'income';
    var maxBars = period === 'day' ? 30 : (period === 'week' ? 16 : 12);
    var buckets = Store.byPeriod(period).slice(0, maxBars).reverse();   // ascendente
    var labels = buckets.map(function (b) { return b.short; });
    var data = buckets.map(function (b) { return metric === 'expense' ? b.expense : (metric === 'net' ? b.net : b.income); });

    // Título dinámico.
    var mWord = metric === 'expense' ? 'Gastos' : (metric === 'net' ? 'Balance' : 'Ingresos');
    var pWord = period === 'week' ? 'semana' : (period === 'month' ? 'mes' : 'día');
    $('chartTitle').textContent = mWord + ' por ' + pWord;

    // Color por métrica (Neto: verde/rojo según signo).
    function colorFor(v) {
      if (metric === 'net') return v < 0 ? 'rgba(233,84,89,0.92)' : 'rgba(45,200,150,0.92)';
      if (metric === 'expense') return 'rgba(233,84,89,0.9)';
      return 'rgba(124,92,255,0.92)';
    }
    var bg = data.map(colorFor);

    var ctx = $('incomeChart').getContext('2d');
    if (state.chart) state.chart.destroy();
    state.chart = new Chart(ctx, {
      type: 'bar',
      data: { labels: labels, datasets: [{ data: data, backgroundColor: bg, borderRadius: 6, maxBarThickness: 40, borderSkipped: false }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: function (items) { var b = buckets[items[0].dataIndex]; return b ? b.label : ''; },
              label: function (c) { return money(c.parsed.y); }
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#8a8a99', font: { size: 11 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 14 } },
          y: { beginAtZero: true, grid: { color: 'rgba(140,140,160,0.14)' }, ticks: { color: '#8a8a99', callback: function (v) { return 'S/' + v; } } }
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
            '<button class="txn-edit" title="Editar">✎</button>' +
            '<button class="txn-del" title="Eliminar">🗑</button>' +
          '</span>';
        row.querySelector('.txn-edit').onclick = function (ev) { ev.stopPropagation(); openEdit(t); };
        row.querySelector('.txn-del').onclick = function (ev) {
          ev.stopPropagation();
          deleteTxn(t.id);
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

  /* ----------------------- editar / eliminar en el historial ----------------------- */
  function deleteTxn(id) {
    Store.remove(id);
    if (window.Cloud && Cloud.enabled) { Cloud.remove(id).then(setCloudStatus); }
    toast('Movimiento eliminado');
    render();
  }

  function openEdit(t) {
    state.editId = t.id;
    $('editName').value = t.name || '';
    $('editDate').value = t.date || '';
    $('editTime').value = t.time || '';
    $('editAmount').value = t.amount;
    $('editType').value = t.type === 'expense' ? 'expense' : 'income';
    showModal('editModal');
  }

  function saveEdit() {
    var id = state.editId; if (!id) return;
    Store.update(id, {
      name: $('editName').value.trim() || '(sin nombre)',
      date: $('editDate').value,
      time: $('editTime').value,
      amount: $('editAmount').value,
      type: $('editType').value
    });
    var updated = Store.all().filter(function (x) { return x.id === id; })[0];
    if (updated && window.Cloud && Cloud.enabled) {
      Cloud.update(updated).then(function (r) {
        if (!r.ok) toast('Guardado local; la nube rechazó (¿quedó igual a otro?)', true);
        setCloudStatus();
      });
    }
    hideModal('editModal');
    state.editId = null;
    toast('Movimiento actualizado');
    render();
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

    // botón Excel dedicado: abre el mismo selector de archivos
    var be = $('btnExcel');
    if (be) be.onclick = function () { fi.click(); };

    // revisión
    $('btnSaveReview').onclick = saveReview;
    $('btnCancelReview').onclick = function () { hideModal('reviewModal'); };
    $('btnCancelReview2').onclick = function () { hideModal('reviewModal'); };

    // editar movimiento
    $('btnSaveEdit').onclick = saveEdit;
    $('btnCancelEdit').onclick = function () { hideModal('editModal'); state.editId = null; };
    $('btnCloseEdit').onclick = function () { hideModal('editModal'); state.editId = null; };
    $('btnDeleteEdit').onclick = function () {
      var id = state.editId; if (!id) return;
      hideModal('editModal'); state.editId = null;
      deleteTxn(id);
    };

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

    // selector de periodo del gráfico (Día / Semana / Mes)
    document.querySelectorAll('#periodToggle .seg').forEach(function (b) {
      b.onclick = function () {
        document.querySelectorAll('#periodToggle .seg').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        state.period = b.getAttribute('data-period');
        renderKPIs();
        renderChart();
      };
    });

    // selector de métrica del gráfico (Ingresos / Gastos / Neto)
    document.querySelectorAll('#metricToggle .seg').forEach(function (b) {
      b.onclick = function () {
        document.querySelectorAll('#metricToggle .seg').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        state.metric = b.getAttribute('data-metric');
        renderChart();
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
