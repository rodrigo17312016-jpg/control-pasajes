/* =========================================================================
   cloud.js — Sincronización con Supabase (registro central de movimientos).

   La app no tiene login (single-user). Usa la llave PUBLICABLE de Supabase,
   que está DISEÑADA para ir en el cliente: la seguridad la da el RLS de la
   tabla `pasajes_movimientos` (no es un secreto, igual que el anon key).

   Estrategia:
     - Al abrir  : pull()  → baja TODO el registro central y lo fusiona local.
     - Al guardar: push()  → sube los movimientos nuevos (upsert, ignora
                              duplicados por dedup_key UNIQUE).
     - Al borrar : remove()/clearAll().
   Si no hay internet, todo sigue funcionando en localStorage y los pendientes
   se reintentan en la siguiente apertura.

   Expone window.Cloud.
   ========================================================================= */
(function () {
  'use strict';

  var URL_BASE = 'https://rslzosmeteyzxmgfkppe.supabase.co';
  var KEY = 'sb_publishable_8z0FKmRgYsg0j_kmrjJFyA_G0afrypd';   // llave publicable (segura en cliente)
  var TABLE = 'pasajes_movimientos';
  var REST = URL_BASE + '/rest/v1/' + TABLE;

  function baseHeaders() {
    return { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  }

  // id estable por dispositivo (para saber de dónde vino cada registro).
  function deviceId() {
    try {
      var d = localStorage.getItem('pasajes_device_id');
      if (!d) { d = 'dev_' + Math.random().toString(36).slice(2, 9); localStorage.setItem('pasajes_device_id', d); }
      return d;
    } catch (e) { return 'dev_anon'; }
  }

  // txn de la app -> fila de la BD
  function toRow(t) {
    return {
      id: t.id,
      dedup_key: (window.Store ? Store.keyOf(t) : ''),
      name: t.name || '',
      fecha: t.date || null,
      hora: t.time || null,
      monto: Number(t.amount) || 0,
      tipo: t.type === 'expense' ? 'expense' : 'income',
      source: t.source || null,
      note: t.note || null,
      device: deviceId()
    };
  }

  // fila de la BD -> txn de la app
  function fromRow(r) {
    return {
      id: r.id,
      name: r.name || '',
      date: r.fecha || '',
      time: r.hora || '',
      amount: Number(r.monto) || 0,
      type: r.tipo === 'expense' ? 'expense' : 'income',
      source: r.source || '',
      note: r.note || ''
    };
  }

  var Cloud = {
    enabled: true,
    online: null,   // null = aún no se sabe, true/false tras el primer intento

    // Sube movimientos (upsert; ignora duplicados por dedup_key).
    push: function (txns) {
      if (!this.enabled || !txns || !txns.length) return Promise.resolve({ ok: true, count: 0 });
      var rows = txns.map(toRow).filter(function (r) { return r.id && r.dedup_key; });
      if (!rows.length) return Promise.resolve({ ok: true, count: 0 });
      var h = baseHeaders();
      h['Prefer'] = 'resolution=ignore-duplicates,return=minimal';
      return fetch(REST + '?on_conflict=dedup_key', {
        method: 'POST', headers: h, body: JSON.stringify(rows)
      }).then(function (res) {
        Cloud.online = res.ok;
        if (!res.ok) console.warn('Cloud.push status', res.status);
        return { ok: res.ok, status: res.status, count: rows.length };
      }).catch(function (e) {
        Cloud.online = false; console.warn('Cloud.push', e);
        return { ok: false, error: String(e) };
      });
    },

    // Baja TODO el registro central -> txn[] de la app.
    pull: function () {
      if (!this.enabled) return Promise.resolve([]);
      return fetch(REST + '?select=*&order=fecha.desc.nullslast,hora.desc.nullslast', { headers: baseHeaders() })
        .then(function (res) { Cloud.online = res.ok; return res.ok ? res.json() : []; })
        .then(function (rows) { return (rows || []).map(fromRow); })
        .catch(function (e) { Cloud.online = false; console.warn('Cloud.pull', e); return []; });
    },

    // Actualiza un movimiento editado (PATCH por id; recalcula dedup_key).
    update: function (t) {
      if (!this.enabled || !t || !t.id) return Promise.resolve({ ok: true });
      var h = baseHeaders(); h['Prefer'] = 'return=minimal';
      return fetch(REST + '?id=eq.' + encodeURIComponent(t.id), {
        method: 'PATCH', headers: h, body: JSON.stringify(toRow(t))
      }).then(function (res) {
        Cloud.online = res.ok;
        if (!res.ok) console.warn('Cloud.update status', res.status);
        return { ok: res.ok, status: res.status };
      }).catch(function (e) { Cloud.online = false; console.warn('Cloud.update', e); return { ok: false }; });
    },

    // Borra un movimiento por id.
    remove: function (id) {
      if (!this.enabled || !id) return Promise.resolve({ ok: true });
      return fetch(REST + '?id=eq.' + encodeURIComponent(id), { method: 'DELETE', headers: baseHeaders() })
        .then(function (res) { Cloud.online = res.ok; return { ok: res.ok }; })
        .catch(function (e) { Cloud.online = false; console.warn('Cloud.remove', e); return { ok: false }; });
    },

    // Borra TODO el registro central (id es PK, nunca null => matchea todo).
    clearAll: function () {
      if (!this.enabled) return Promise.resolve({ ok: true });
      return fetch(REST + '?id=not.is.null', { method: 'DELETE', headers: baseHeaders() })
        .then(function (res) { Cloud.online = res.ok; return { ok: res.ok }; })
        .catch(function (e) { Cloud.online = false; console.warn('Cloud.clearAll', e); return { ok: false }; });
    }
  };

  window.Cloud = Cloud;
})();
