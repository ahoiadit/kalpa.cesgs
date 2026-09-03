/**
 * KALPA — Backend Google Apps Script
 * =====================================================================
 * Dipanggil HANYA oleh proxy Node (api/index.js), bukan langsung dari
 * peramban. Semua permintaan datang sebagai POST berisi JSON
 * { action, token, ... }. Pola ini sama dengan Research Hub.
 *
 * Dua lembar dipakai:
 *   KALPA_Akun   -> email | sandi | nama | peran      (untuk login)
 *   KALPA_Data   -> uid | modul | updated_at | ...     (data assessment)
 *
 * Kolom KALPA_Data dibuat otomatis dari payload (mergeHelper), jadi
 * menambah field baru di sisi KALPA tidak perlu mengedit spreadsheet.
 *
 * Action yang dilayani
 *   ping   -> { ok:true }
 *   login  -> { action:'login', email, sandi }
 *             -> { ok:true, akun:{ email, nama, peran } }  (tanpa sandi)
 *   pull   -> { ok:true, rev, data:[..], akun:[..tanpa sandi..] }
 *   sync   -> { action:'sync', records:[{uid,..}], deleted:[uid,..] }
 *             -> sama seperti pull (data terbaru)
 * =====================================================================
 */

var CONFIG = {
  SHEET_ID: 'PASTE_SPREADSHEET_ID_DI_SINI',

  AKUN_SHEET: 'KALPA_Akun',
  DATA_SHEET: 'KALPA_Data',

  // Harus sama dengan env KALPA_GAS_TOKEN di Vercel. Boleh dikosongkan
  // ('') hanya kalau proxy juga tidak mengirim token.
  TOKEN: '',

  UID_COL: 'uid',
  TS_COL: 'updated_at'
};

// ---------------------------------------------------------------------
// ENDPOINT
// ---------------------------------------------------------------------

function doPost(e) {
  var body = {};
  try {
    if (e && e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
  } catch (ex) {
    return json_({ ok: false, error: 'body bukan JSON' });
  }
  return route_(body);
}

// Memudahkan uji manual dari peramban: ?action=ping&token=...
function doGet(e) {
  var p = (e && e.parameter) || {};
  return route_(p);
}

function route_(input) {
  try {
    var action = String(input.action || '').trim();
    if (action === 'ping') return json_({ ok: true });

    if (!cekToken_(input.token)) return json_({ ok: false, error: 'token salah' });

    switch (action) {
      case 'login': return login_(input);
      case 'pull':  return json_(snapshot_());
      case 'sync':  return sync_(input);
      default:      return json_({ ok: false, error: 'action tidak dikenal: ' + action });
    }
  } catch (ex) {
    return json_({ ok: false, error: String(ex) });
  }
}

// ---------------------------------------------------------------------
// LOGIN
// ---------------------------------------------------------------------

function login_(input) {
  var email = String(input.email || input.mail || '').trim().toLowerCase();
  var sandi = String(input.sandi || input.pass || '');
  if (!email || !sandi) return json_({ ok: false, error: 'Surel dan kata sandi wajib diisi.' });

  var akun = bacaSemua_(ambilLembar_(CONFIG.AKUN_SHEET));
  for (var i = 0; i < akun.length; i++) {
    var a = akun[i];
    if (String(a.email || '').trim().toLowerCase() === email &&
        String(a.sandi || '') === sandi) {
      return json_({
        ok: true,
        akun: {
          email: String(a.email || '').toLowerCase(),
          nama:  String(a.nama || ''),
          peran: String(a.peran || 'Peneliti')
        }
      });
    }
  }
  return json_({ ok: false, error: 'Surel atau kata sandi tidak cocok.' });
}

/** Daftar akun tanpa kolom sandi (dipakai di snapshot). */
function akunTanpaSandi_() {
  return bacaSemua_(ambilLembar_(CONFIG.AKUN_SHEET)).map(function (a) {
    var c = {};
    Object.keys(a).forEach(function (k) { if (k !== 'sandi') c[k] = a[k]; });
    return c;
  });
}

// ---------------------------------------------------------------------
// DATA
// ---------------------------------------------------------------------

function snapshot_() {
  return {
    ok: true,
    rev: String(Date.now()),
    syncedAt: new Date().toISOString(),
    data: bacaSemua_(ambilLembar_(CONFIG.DATA_SHEET)),
    akun: akunTanpaSandi_()
  };
}

function sync_(input) {
  var lembar = ambilLembar_(CONFIG.DATA_SHEET);
  var records = Array.isArray(input.records) ? input.records : [];
  var deleted = Array.isArray(input.deleted) ? input.deleted : [];
  if (records.length) upsertBanyak_(lembar, records);
  if (deleted.length) hapusBanyak_(lembar, deleted);
  return json_(snapshot_());
}

// ---------------------------------------------------------------------
// PENYIMPANAN (skema-lentur)
// ---------------------------------------------------------------------

function ss_() {
  if (!CONFIG.SHEET_ID || CONFIG.SHEET_ID.indexOf('PASTE_') === 0) {
    throw new Error('CONFIG.SHEET_ID belum diisi');
  }
  return SpreadsheetApp.openById(CONFIG.SHEET_ID);
}

function ambilLembar_(nama) {
  var ss = ss_();
  var sh = ss.getSheetByName(nama);
  if (!sh) sh = ss.insertSheet(nama);
  if (sh.getLastRow() === 0) {
    if (nama === CONFIG.AKUN_SHEET) {
      sh.getRange(1, 1, 1, 4).setValues([['email', 'sandi', 'nama', 'peran']]);
    } else {
      sh.getRange(1, 1, 1, 3).setValues([[CONFIG.UID_COL, 'modul', CONFIG.TS_COL]]);
    }
  }
  return sh;
}

function header_(sh) {
  var lastCol = sh.getLastColumn();
  if (lastCol === 0) return [];
  return sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (x) { return String(x); });
}

function pastikanKolom_(sh, keys) {
  var head = header_(sh);
  var tambah = [];
  keys.forEach(function (k) {
    if (head.indexOf(k) === -1 && tambah.indexOf(k) === -1) tambah.push(k);
  });
  if (tambah.length) sh.getRange(1, head.length + 1, 1, tambah.length).setValues([tambah]);
  return header_(sh);
}

function bacaSemua_(sh) {
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol === 0) return [];
  var head = header_(sh);
  var nilai = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  return nilai.map(function (baris) {
    var o = {};
    head.forEach(function (h, i) { if (h) o[h] = baris[i]; });
    return o;
  }).filter(function (o) {
    var kunci = o[CONFIG.UID_COL] != null ? o[CONFIG.UID_COL] : o.email;
    return kunci !== '' && kunci != null;
  });
}

function petaUid_(sh) {
  var peta = {}, lastRow = sh.getLastRow();
  if (lastRow < 2) return peta;
  var head = header_(sh), idx = head.indexOf(CONFIG.UID_COL);
  if (idx === -1) return peta;
  var kolom = sh.getRange(2, idx + 1, lastRow - 1, 1).getValues();
  kolom.forEach(function (r, i) { var u = String(r[0]); if (u) peta[u] = i + 2; });
  return peta;
}

function upsertBanyak_(sh, records) {
  var semuaKey = {};
  records.forEach(function (rec) { Object.keys(rec).forEach(function (k) { semuaKey[k] = true; }); });
  semuaKey[CONFIG.UID_COL] = true;
  semuaKey[CONFIG.TS_COL] = true;
  pastikanKolom_(sh, Object.keys(semuaKey));

  var head = header_(sh), peta = petaUid_(sh), stamp = new Date();

  records.forEach(function (rec) {
    var uid = String(rec[CONFIG.UID_COL] || '');
    if (!uid) return;
    rec[CONFIG.TS_COL] = stamp;
    if (peta[uid]) {
      head.forEach(function (h, i) {
        if (rec.hasOwnProperty(h)) sh.getRange(peta[uid], i + 1).setValue(rec[h]);
      });
    } else {
      var barisBaru = sh.getLastRow() + 1;
      var nilai = head.map(function (h) { return rec.hasOwnProperty(h) ? rec[h] : null; });
      sh.getRange(barisBaru, 1, 1, head.length).setValues([nilai]);
      peta[uid] = barisBaru;
    }
  });
}

function hapusBanyak_(sh, uids) {
  var peta = petaUid_(sh), baris = [];
  uids.forEach(function (u) { var b = peta[String(u)]; if (b) baris.push(b); });
  baris.sort(function (a, b) { return b - a; });
  baris.forEach(function (b) { sh.deleteRow(b); });
}

// ---------------------------------------------------------------------
// UTIL
// ---------------------------------------------------------------------

function cekToken_(t) {
  if (!CONFIG.TOKEN) return true;
  return String(t || '') === String(CONFIG.TOKEN);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------
// Uji cepat dari editor (Run)
// ---------------------------------------------------------------------

function tesSeed() {
  // Buat satu akun contoh + satu data contoh. Ganti/ hapus setelah uji.
  var ak = ambilLembar_(CONFIG.AKUN_SHEET);
  upsertKunci_(ak, 'email', {
    email: 'admin@cesgs.or.id', sandi: 'ubah-sandi-ini', nama: 'Admin KALPA', peran: 'Administrator'
  });
  var dt = ambilLembar_(CONFIG.DATA_SHEET);
  upsertBanyak_(dt, [{ uid: 'demo-1', modul: 'Acute', nama_aset: 'Kantor Pusat', lokasi: 'Surabaya', skor_risiko: 0.7 }]);
  Logger.log(snapshot_());
}

// upsert lembar akun berbasis kolom email (bukan uid)
function upsertKunci_(sh, kolomKunci, obj) {
  pastikanKolom_(sh, Object.keys(obj));
  var head = header_(sh), idx = head.indexOf(kolomKunci);
  var lastRow = sh.getLastRow();
  var target = 0;
  if (idx !== -1 && lastRow >= 2) {
    var kol = sh.getRange(2, idx + 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < kol.length; i++) {
      if (String(kol[i][0]).toLowerCase() === String(obj[kolomKunci]).toLowerCase()) { target = i + 2; break; }
    }
  }
  if (!target) target = sh.getLastRow() + 1;
  head.forEach(function (h, i) { if (obj.hasOwnProperty(h)) sh.getRange(target, i + 1).setValue(obj[h]); });
}
