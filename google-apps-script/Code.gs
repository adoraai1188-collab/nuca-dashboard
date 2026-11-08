/**
 * لوحة متابعة تخصيصات المرحلة الحادية عشر — هيئة المجتمعات العمرانية الجديدة
 * تعمل مجاناً على Google Apps Script:
 *   - رصد تلقائي من https://lands.nuca.gov.eg (البيانات المعروضة للجمهور) كل 30 دقيقة
 *   - حفظ البيانات في Google Drive الخاص بك
 *   - رابط ويب يفتح على أي متصفح (لاب توب / موبايل) ويتحدث تلقائياً
 * خطوات التشغيل في ملف «اقرأني.md».
 */

// ======================= الإعدادات =======================
var CONFIG = {
  DAILY_TARGET: 1000,          // الهدف اليومي الافتراضي
  INTERVAL_MIN: 30,            // معدل الرصد التلقائي بالدقائق (30 أو 60)
  QUIET_FROM: 1, QUIET_TO: 7,  // لا رصد مجدول من 1 صباحاً حتى 7:59 صباحاً
  STALE_MIN: 30,               // عند فتح الصفحة: رصد فوري لو آخر رصد أقدم من هذا
  PHASE: 'الحادية عشر',
  BASE: 'https://lands.nuca.gov.eg/ar/',
  SEED_URL: 'https://raw.githubusercontent.com/adoraai1188-collab/nuca-dashboard/main/state/', // تاريخ الرصد السابق
  CHUNK: 25,                   // عدد الطلبات المتوازية
  MAX_RUN_MS: 5 * 60 * 1000,   // حد زمن الرصد الواحد
  TZ: 'Africa/Cairo',
  FOLDER: 'NUCA Dashboard'
};
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// ======================= الإعداد لأول مرة =======================
/** شغّل هذه الدالة مرة واحدة: تختبر الاتصال، تستورد تاريخ الرصد، تجري أول رصد، وتنشئ الجدولة */
function setup() {
  var test = httpBatch_([{ url: CONFIG.BASE + 'Home.aspx' }])[0];
  if (test.code !== 200 || test.text.indexOf('ViewCity.aspx') < 0) {
    throw new Error('تعذر الوصول لموقع الهيئة من سيرفرات جوجل (كود ' + test.code + '). أخبر المطوّر.');
  }
  Logger.log('✓ الاتصال بموقع الهيئة يعمل');
  var st = store_().load();
  if (!Object.keys(st.plots).length) {
    try { importSeed_(st); store_().save(st); Logger.log('✓ تم استيراد تاريخ الرصد السابق: ' + Object.keys(st.plots).length + ' قطعة'); }
    catch (e) { Logger.log('لم يتم استيراد تاريخ سابق (سيبدأ رصد جديد): ' + e); }
  }
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('scheduledRun').timeBased().everyMinutes(CONFIG.INTERVAL_MIN).create();
  Logger.log('✓ تم إنشاء الرصد التلقائي كل ' + CONFIG.INTERVAL_MIN + ' دقيقة');
  var r = collect();
  Logger.log('نتيجة أول رصد: ' + JSON.stringify(r));
}

function scheduledRun() {
  var h = Number(Utilities.formatDate(new Date(), CONFIG.TZ, 'H'));
  if (h >= CONFIG.QUIET_FROM && h <= CONFIG.QUIET_TO) return;
  collect();
}

// ======================= الويب =======================
function doGet(e) {
  if (e && e.parameter && e.parameter.format === 'csv') {
    return ContentService.createTextOutput(buildCsv_(store_().load()))
      .setMimeType(ContentService.MimeType.CSV)
      .downloadAsFile('nuca_phase11_' + Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyyMMdd_HHmm') + '.csv');
  }
  var html = INDEX_HTML
    .replace('/*__STATIC_DATA__*/', 'window.GAS=true;window.EXEC_URL=' + JSON.stringify(ScriptApp.getService().getUrl()) + ';');
  return HtmlService.createHtmlOutput(html)
    .setTitle('أداء التخصيصات — المرحلة الحادية عشر')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** تُستدعى من الصفحة لجلب آخر بيانات */
function getData() {
  var c = CacheService.getScriptCache().get('data');
  if (c) return c;
  var d = store_().loadData();
  if (d) { try { CacheService.getScriptCache().put('data', d, 21600); } catch (e) {} }
  return d || '{}';
}

/** تُستدعى عند فتح الصفحة: رصد فوري لو البيانات قديمة */
function refreshIfStale() {
  var d = JSON.parse(getData() || '{}');
  var age = d.ts ? (Date.now() - d.ts) / 60000 : 1e9;
  if (age < CONFIG.STALE_MIN) return JSON.stringify({ refreshed: false });
  var r = collect();
  return JSON.stringify({ refreshed: !!(r && r.ok !== undefined), result: r });
}

// ======================= HTTP =======================
function httpBatch_(reqs) {
  var out = [];
  for (var i = 0; i < reqs.length; i += CONFIG.CHUNK) {
    var part = reqs.slice(i, i + CONFIG.CHUNK).map(function (r) {
      var h = { 'User-Agent': UA };
      if (r.cookies) h.Cookie = cookieHeader_(r.cookies);
      var o = { url: r.url, method: r.payload ? 'post' : 'get', headers: h, muteHttpExceptions: true, followRedirects: true };
      if (r.payload) o.payload = r.payload;
      return o;
    });
    var res;
    try { res = UrlFetchApp.fetchAll(part); }
    catch (e) { res = part.map(function () { return null; }); }
    res.forEach(function (x) {
      if (!x) { out.push({ code: 0, text: '', setCookies: [] }); return; }
      var sc = x.getAllHeaders()['Set-Cookie'] || [];
      if (typeof sc === 'string') sc = [sc];
      out.push({ code: x.getResponseCode(), text: x.getContentText('UTF-8'), setCookies: sc });
    });
  }
  return out;
}
function cookieHeader_(c) { return Object.keys(c).map(function (k) { return k + '=' + c[k]; }).join('; '); }
function absorbCookies_(jar, list) {
  (list || []).forEach(function (s) { var p = String(s).split(';')[0]; var i = p.indexOf('='); if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
}

// ======================= التحليل =======================
function decode_(s) {
  return String(s).replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(+n); })
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
function text_(s) { return decode_(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function num_(s) { var v = parseFloat(String(s).replace(/,/g, '')); return isNaN(v) ? 0 : v; }
function attr_(tag, name) { var m = new RegExp('\\b' + name + '="([^"]*)"').exec(tag); return m ? decode_(m[1]) : null; }
function hidden_(html) {
  var o = {}, re = /<input[^>]*type="hidden"[^>]*>/g, m;
  while ((m = re.exec(html))) { var n = attr_(m[0], 'name'); if (n) o[n] = attr_(m[0], 'value') || ''; }
  return o;
}
function pages_(html) { var s = {}, re = /Page\$(\d+)/g, m; while ((m = re.exec(html))) s[m[1]] = 1; return s; }
function rows_(html) {
  var out = [], re = /<tr[^>]*>([\s\S]*?)<\/tr>/g, m;
  while ((m = re.exec(html))) {
    var tr = m[1];
    if (tr.indexOf('lblPlotStatus') < 0) continue;
    var tds = [], tre = /<td[^>]*>([\s\S]*?)<\/td>/g, t;
    while ((t = tre.exec(tr))) tds.push(t[1]);
    if (tds.length < 11) continue;
    var st = /lblPlotStatus[^>]*>([\s\S]*?)<\/span>/.exec(tr);
    out.push({ block: text_(tds[0]), plot: text_(tds[1]), area: num_(text_(tds[2])), meter_price: num_(text_(tds[7])),
      total_price: num_(text_(tds[8])), down: num_(text_(tds[9])), status: st ? text_(st[1]) : '' });
  }
  return out;
}
function isGrid_(html) { return html.indexOf('grdPlots') >= 0 || html.indexOf('lblPlotStatus') >= 0; }

// ======================= اكتشاف المناطق =======================
function discover_() {
  var home = httpBatch_([{ url: CONFIG.BASE + 'Home.aspx' }])[0].text;
  var cities = {}, re = /ViewCity\.aspx\?ID=(\d+)"[^>]*>([\s\S]*?)<\/a>/g, m;
  while ((m = re.exec(home))) { var n = text_(m[2]); if (n) cities[m[1]] = n; }
  var cids = Object.keys(cities);
  if (!cids.length) throw new Error('لم يتم العثور على المدن');
  var cres = httpBatch_(cids.map(function (c) { return { url: CONFIG.BASE + 'ViewCity.aspx?ID=' + c }; }));
  var projects = [];
  cres.forEach(function (r, i) {
    var pre = /lblProjectTitle">([^<]*)<\/span>[\s\S]*?ViewProject\.aspx\?ID=(\d+)/g, p;
    while ((p = pre.exec(r.text))) {
      var title = text_(p[1]);
      if (title.indexOf(CONFIG.PHASE) >= 0) projects.push({ city_id: cids[i], city: cities[cids[i]], project_id: p[2], project: title });
    }
  });
  var pres = httpBatch_(projects.map(function (p) { return { url: CONFIG.BASE + 'ViewProject.aspx?ID=' + p.project_id }; }));
  var zones = {}, ok = true;
  pres.forEach(function (r, i) {
    if (r.code !== 200) { ok = false; return; }
    var p = projects[i];
    var region = p.project.replace('المرحلة ' + CONFIG.PHASE, '').replace(/^[\s\-–]+|[\s\-–]+$/g, '');
    var r2 = region.replace(/\s*-\s*[^-]*$/, '').trim(); if (r2) region = r2;
    var zre = /ViewZone\.aspx\?ID=(\d+)/g, z;
    while ((z = zre.exec(r.text))) if (!zones[z[1]]) zones[z[1]] = { city: p.city, region: region, project: p.project };
  });
  return { zones: zones, complete: ok };
}

// ======================= الرصد =======================
function now_() { return Utilities.formatDate(new Date(), CONFIG.TZ, "yyyy-MM-dd'T'HH:mm:ss"); }

function collect() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) return { skipped: 'running' };
  var t0 = Date.now(), started = now_();
  try {
    var S = store_(), st = S.load();
    var today = started.slice(0, 10);
    var firstRun = Object.keys(st.plots).length === 0;
    if (!st.zones_checked || st.zones_checked !== today || !Object.keys(st.zones).length) {
      var d = discover_();
      for (var zid in d.zones) {
        if (!st.zones[zid]) st.zones[zid] = { city: d.zones[zid].city, region: d.zones[zid].region, project: d.zones[zid].project, meter_egp: 0, full: false };
        else { st.zones[zid].city = d.zones[zid].city; st.zones[zid].region = d.zones[zid].region; }
      }
      if (d.complete) {
        for (var oz in st.zones) if (!d.zones[oz]) st.zones[oz].gone = true; else delete st.zones[oz].gone;
        st.zones_checked = today;
      }
    }
    // عدادات القطع الحالية لكل منطقة
    var cnt = {};
    for (var k in st.plots) { var zz = k.split('|')[0]; var c = cnt[zz] || (cnt[zz] = { t: 0, b: 0 }); c.t++; if (st.plots[k][0]) c.b++; }
    var jobs = [];
    for (var z in st.zones) {
      if (st.zones[z].gone) continue;
      var c2 = cnt[z] || { t: 0, b: 0 };
      var plan = (!st.zones[z].full || !c2.t) ? ['avail', 'booked'] : ((c2.t - c2.b) <= c2.b ? ['avail'] : ['booked']);
      jobs.push({ zid: z, plan: plan, step: 0, page: 1, jar: {}, html: null, rows: { avail: [], booked: [] }, state: 'get', done: false, fail: null });
    }
    // الجولات المتوازية
    var url = function (j) { return CONFIG.BASE + 'ViewZone.aspx?ID=' + j.zid; };
    var guard = 0;
    while (true) {
      var active = jobs.filter(function (j) { return !j.done; });
      if (!active.length) break;
      if (Date.now() - t0 > CONFIG.MAX_RUN_MS || ++guard > 400) { active.forEach(function (j) { j.done = true; j.fail = 'timeout'; }); break; }
      var reqs = active.map(function (j) {
        if (j.state === 'get') return { url: url(j) };
        // التبديل للمحجوز يتم من حالة الصفحة الأولى (وإلا يبدأ من نفس رقم الصفحة الحالية)
        var h = hidden_(j.state === 'switch' ? j.firstHtml : j.html), mode = j.plan[j.step] === 'avail' ? 'rdShowAvailable' : 'rdShowBooked';
        h['ctl00$MainContent$PlotType'] = mode; h['ctl00$MainContent$txtPlotNumber'] = '';
        if (j.state === 'switch') { h.__EVENTTARGET = 'ctl00$MainContent$rdShowBooked'; h.__EVENTARGUMENT = ''; }
        else { h.__EVENTTARGET = 'ctl00$MainContent$grdPlots'; h.__EVENTARGUMENT = 'Page$' + j.page; }
        return { url: url(j), payload: h, cookies: j.jar };
      });
      var res = httpBatch_(reqs);
      active.forEach(function (j, i) {
        var r = res[i];
        if (r.code !== 200 || !isGrid_(r.text)) { j.retry = (j.retry || 0) + 1; if (j.retry > 2) { j.done = true; j.fail = 'http ' + r.code; } return; }
        j.retry = 0; absorbCookies_(j.jar, r.setCookies); j.html = r.text;
        var list = j.plan[j.step];
        if (j.state === 'get') {
          j.firstHtml = r.text;
          var me = /سعر المتر بالجنيه المصري:\s*([\d,\.]+)/.exec(text_(r.text)); if (me) st.zones[j.zid].meter_egp = num_(me[1]);
          if (list === 'booked') { j.state = 'switch'; return; }
        }
        j.rows[list] = j.rows[list].concat(rows_(r.text));
        var pg = pages_(r.text), cur = (j.state === 'page') ? j.page : 1;
        if (pg[cur + 1]) { j.state = 'page'; j.page = cur + 1; return; }
        j.step++; j.page = 1;
        if (j.step >= j.plan.length) { j.done = true; return; }
        j.state = 'switch';
      });
    }
    // دمج النتائج
    var ts = now_(), newB = 0, rel = 0, failed = [], verify = [];
    jobs.forEach(function (j) {
      if (j.fail) { failed.push(j.zid); return; }
      var full = j.plan.length === 2, seen = {};
      var put = function (r, booked) {
        var key = j.zid + '|' + r.block + '|' + r.plot; seen[key] = booked;
        var p = st.plots[key];
        if (!p) {
          var isNew = booked && !firstRun && st.zones[j.zid].full;
          st.plots[key] = [booked ? 1 : 0, booked ? ts : null, (firstRun || !st.zones[j.zid].full) ? 1 : 0, r.area, r.total_price, r.down, r.meter_price];
          if (isNew) { newB++; st.plots[key][2] = 0; }
          return;
        }
        p[3] = r.area; p[4] = r.total_price; p[5] = r.down; p[6] = r.meter_price;
        setBooked(key, p, booked);
      };
      var setBooked = function (key, p, booked) {
        if (booked && !p[0]) { p[0] = 1; p[1] = ts; p[2] = 0; newB++; }
        else if (!booked && p[0]) { p[0] = 0; p[1] = null; rel++; }
      };
      j.rows.avail.forEach(function (r) { put(r, 0); });
      j.rows.booked.forEach(function (r) { put(r, 1); });
      if (!full) {
        // قطع لم تظهر في القائمة المفحوصة: تغيّر حالتها يُؤكَّد بالبحث برقم القطعة قبل تسجيله
        var inferred = j.plan[0] === 'avail' ? 1 : 0;
        for (var key in st.plots) {
          if (key.indexOf(j.zid + '|') !== 0 || key in seen) continue;
          if (st.plots[key][0] !== inferred) verify.push({ j: j, key: key, block: key.split('|')[1], plot: key.split('|').slice(2).join('|') });
        }
      }
      st.zones[j.zid].full = true;
    });
    // تأكيد التغييرات بالبحث برقم القطعة
    var unverified = 0, vlist = verify.slice(0, 400);
    unverified += verify.length - vlist.length;
    if (vlist.length && Date.now() - t0 < CONFIG.MAX_RUN_MS) {
      var vres = httpBatch_(vlist.map(function (v) {
        var h = hidden_(v.j.firstHtml);
        h['ctl00$MainContent$txtPlotNumber'] = v.plot; h['ctl00$MainContent$btnSearch'] = 'بحث';
        h['ctl00$MainContent$PlotType'] = 'rdShowAvailable'; h.__EVENTTARGET = ''; h.__EVENTARGUMENT = '';
        return { url: CONFIG.BASE + 'ViewZone.aspx?ID=' + v.j.zid, payload: h, cookies: v.j.jar };
      }));
      vlist.forEach(function (v, i) {
        var r = vres[i], hit = null;
        if (r.code === 200) rows_(r.text).forEach(function (x) { if (x.plot === v.plot && x.block === v.block) hit = x; });
        if (!hit) { unverified++; return; }
        var p = st.plots[v.key];
        if (hit.status.indexOf('حجز مبدئى') >= 0) { if (p[0]) { p[0] = 0; p[1] = null; rel++; } }
        else if (!p[0]) { p[0] = 1; p[1] = ts; p[2] = 0; newB++; }
      });
    } else unverified += vlist.length;
    var tot = 0, bk = 0;
    for (var k2 in st.plots) { if (st.zones[k2.split('|')[0]] && !st.zones[k2.split('|')[0]].gone) { tot++; if (st.plots[k2][0]) bk++; } }
    var note = firstRun ? 'تشغيل أولي (خط الأساس)' : '';
    if (failed.length) note += (note ? ' · ' : '') + 'مناطق لم تكتمل: ' + failed.length;
    if (unverified) note += (note ? ' · ' : '') + 'قطع تُراجع في الرصد التالي: ' + unverified;
    st.runs.push({ id: (st.runs.length ? st.runs[st.runs.length - 1].id : 0) + 1, started: started, finished: ts, total: tot, booked: bk,
      new_booked: newB, released: rel, ok: failed.length ? 0 : 1, note: note });
    if (st.runs.length > 3000) st.runs = st.runs.slice(-3000);
    S.save(st);
    var data = JSON.stringify(buildData_(st));
    S.saveData(data);
    try { CacheService.getScriptCache().put('data', data, 21600); } catch (e) {}
    return { ok: failed.length === 0, total: tot, booked: bk, new_booked: newB, released: rel, verified: vlist.length, unverified: unverified, failed: failed.length, seconds: Math.round((Date.now() - t0) / 1000) };
  } finally {
    lock.releaseLock();
  }
}

// ======================= بيانات الصفحة =======================
function buildData_(st) {
  var zs = {}, daily = {}, recent = [];
  for (var z in st.zones) if (!st.zones[z].gone)
    zs[z] = { zone_id: z, city: st.zones[z].city, region: st.zones[z].region, meter_egp: st.zones[z].meter_egp || 0,
      total: 0, booked: 0, area: 0, area_booked: 0, value_booked: 0, down_booked: 0 };
  for (var k in st.plots) {
    var parts = k.split('|'), zid = parts[0], p = st.plots[k], o = zs[zid];
    if (!o) continue;
    o.total++; o.area += p[3] || 0;
    if (p[0]) {
      o.booked++; o.area_booked += p[3] || 0; o.value_booked += p[4] || 0; o.down_booked += p[5] || 0;
      if (!p[2] && p[1]) {
        var dk = p[1].slice(0, 10) + '|' + zid, dd = daily[dk] || (daily[dk] = { d: p[1].slice(0, 10), zone_id: zid, n: 0, v: 0 });
        dd.n++; dd.v += p[4] || 0;
        recent.push({ ts: p[1], city: o.city, region: o.region, block: parts[1], plot: parts.slice(2).join('|'), area: p[3], total_price: p[4] });
      }
    }
  }
  recent.sort(function (a, b) { return a.ts < b.ts ? 1 : -1; });
  var runs = st.runs.slice(-30).reverse();
  return { zones: Object.keys(zs).map(function (k) { return zs[k]; }), daily: Object.keys(daily).map(function (k) { return daily[k]; }),
    recent: recent.slice(0, 100), runs: runs, baseline: st.runs.length ? st.runs[0].started : null,
    config: { daily_target: CONFIG.DAILY_TARGET, schedule: [] }, progress: { running: false },
    now: st.runs.length ? st.runs[st.runs.length - 1].finished : now_(), ts: Date.now(), next_minutes: CONFIG.INTERVAL_MIN };
}

function buildCsv_(st) {
  var head = ['المدينة', 'المنطقة', 'المربع', 'القطعة', 'المساحة م2', 'سعر المتر $', 'السعر الإجمالي $', 'الدفعة المقدمة $', 'الحالة', 'وقت رصد التخصيص', 'ملاحظة'];
  var esc = function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  var lines = [head.join(',')];
  Object.keys(st.plots).sort().forEach(function (k) {
    var a = k.split('|'), z = st.zones[a[0]], p = st.plots[k];
    if (!z || z.gone) return;
    lines.push([z.city, z.region, a[1], a.slice(2).join('|'), p[3], p[6], p[4], p[5], p[0] ? 'مخصصة' : 'متاحة', p[1] || '', p[2] && p[0] ? 'قبل بدء الرصد' : ''].map(esc).join(','));
  });
  return '﻿' + lines.join('\r\n');
}

// ======================= التخزين (Google Drive) =======================
function store_() {
  var folder = (function () {
    var it = DriveApp.getFoldersByName(CONFIG.FOLDER);
    return it.hasNext() ? it.next() : DriveApp.createFolder(CONFIG.FOLDER);
  })();
  function file(name) { var it = folder.getFilesByName(name); return it.hasNext() ? it.next() : null; }
  function write(name, s) { var f = file(name); if (f) f.setContent(s); else folder.createFile(name, s, 'application/json'); }
  return {
    load: function () {
      var f = file('state.json');
      var st = f ? JSON.parse(f.getBlob().getDataAsString('UTF-8')) : {};
      st.zones = st.zones || {}; st.plots = st.plots || {}; st.runs = st.runs || [];
      return st;
    },
    save: function (st) { write('state.json', JSON.stringify(st)); },
    loadData: function () { var f = file('data.json'); return f ? f.getBlob().getDataAsString('UTF-8') : null; },
    saveData: function (s) { write('data.json', s); }
  };
}

/** استيراد تاريخ الرصد السابق (من النسخة المنشورة على GitHub) حتى لا يبدأ الرصد من الصفر */
function importSeed_(st) {
  function tsv(name) {
    var r = UrlFetchApp.fetch(CONFIG.SEED_URL + name, { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) throw new Error(name + ' ' + r.getResponseCode());
    var lines = r.getContentText('UTF-8').split('\n').filter(String), h = lines[0].split('\t');
    return lines.slice(1).map(function (l) { var v = l.split('\t'), o = {}; h.forEach(function (c, i) { o[c] = v[i] === '' ? null : v[i]; }); return o; });
  }
  tsv('zones.tsv').forEach(function (z) { st.zones[z.zone_id] = { city: z.city, region: z.region, project: z.project, meter_egp: +z.meter_egp || 0, full: true }; });
  tsv('plots.tsv').forEach(function (p) {
    st.plots[p.zone_id + '|' + p.block + '|' + p.plot] = [+p.booked, p.booked_at, +p.baseline, +p.area || 0, +p.total_price || 0, +p.down_payment || 0, +p.meter_price || 0];
  });
  tsv('runs.tsv').forEach(function (r) {
    st.runs.push({ id: +r.id, started: r.started, finished: r.finished, total: +r.total, booked: +r.booked, new_booked: +r.new_booked, released: +r.released, ok: +r.ok, note: r.note || '' });
  });
}

// ======================= صفحة اللوحة (مضمّنة — لا حاجة لملف Index) =======================
var INDEX_HTML = "<!DOCTYPE html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>أداء التخصيصات - المرحلة الحادية عشر</title>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link href=\"https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap\" rel=\"stylesheet\">\n<style>\n:root{\n  --navy:#0f2a4a; --navy-2:#1d3d66; --gold:#c9a227; --gold-d:#a8851a; --gold-l:#f3e3a8;\n  --steel:#4a6f96; --bg:#f3f5f8; --card:#ffffff; --line:#e6e9ef;\n  --ink:#0b1a2b; --ink-2:#4b5563; --ink-3:#8a93a1;\n  --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s4:#eda100; --s5:#e87ba4; --other:#c3c8d1;\n  --good:#16a34a; --bad:#dc2626;\n}\n*{box-sizing:border-box}\nbody{margin:0;background:var(--bg);color:var(--ink);font-family:Cairo,Tahoma,\"Segoe UI\",sans-serif;font-size:15px}\n.wrap{max-width:1240px;margin:0 auto;padding:16px}\n.top{background:linear-gradient(135deg,var(--navy),var(--navy-2));color:#fff;border-radius:18px;padding:18px 22px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;box-shadow:0 6px 20px rgba(15,42,74,.18)}\n.top h1{margin:0;font-size:26px;font-weight:800}\n.top .sub{color:#c8d3e2;font-size:13px;margin-top:2px}\n.live{display:inline-flex;align-items:center;gap:6px;font-weight:700;color:#bff0cf;font-size:13px}\n.dot{width:9px;height:9px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 0 rgba(34,197,94,.7);animation:pulse 2s infinite}\n.dot.off{background:#9ca3af;animation:none}\n@keyframes pulse{70%{box-shadow:0 0 0 8px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}\n.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}\n.btn{border:0;border-radius:12px;padding:9px 16px;font:inherit;font-weight:700;cursor:pointer;display:inline-flex;gap:6px;align-items:center}\n.btn.gold{background:var(--gold);color:var(--navy)} .btn.gold:hover{background:#d9b23a}\n.btn.ghost{background:rgba(255,255,255,.12);color:#fff} .btn.ghost:hover{background:rgba(255,255,255,.2)}\n.btn:disabled{opacity:.6;cursor:wait}\n.upd{font-size:12px;color:#c8d3e2}\n.filters{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:14px 0}\n.f{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:6px 12px;display:flex;flex-direction:column}\n.f label{font-size:11px;color:var(--ink-3);font-weight:700}\n.f select,.f input{border:0;font:inherit;font-weight:700;color:var(--ink);background:transparent;padding:2px 0;outline:none}\n.note{background:#fff8e1;border:1px solid var(--gold-l);color:#7a5d00;border-radius:12px;padding:8px 14px;font-size:13px;margin-bottom:12px;display:none}\n.prog{display:none;background:#e8eef7;border-radius:12px;padding:8px 14px;font-size:13px;color:var(--navy);margin-bottom:12px}\n.prog .bar{height:6px;background:#cfd9e8;border-radius:4px;margin-top:6px;overflow:hidden}\n.prog .bar i{display:block;height:100%;background:var(--steel);width:0;transition:width .4s}\n.grid{display:grid;gap:14px}\n.g2{grid-template-columns:1fr 1fr} .g3{grid-template-columns:repeat(3,1fr)} .g4{grid-template-columns:repeat(4,1fr)}\n.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:16px 18px;box-shadow:0 1px 3px rgba(15,42,74,.05);min-width:0}\n.card h3{margin:0 0 10px;font-size:17px;font-weight:800;display:flex;align-items:center;gap:8px;justify-content:space-between}\n.card h3 small{font-size:12px;color:var(--ink-3);font-weight:600}\n.seg{display:inline-flex;background:var(--bg);border-radius:10px;padding:3px}\n.seg button{border:0;background:transparent;font:inherit;font-size:12px;font-weight:700;padding:3px 10px;border-radius:8px;cursor:pointer;color:var(--ink-2)}\n.seg button.on{background:#fff;color:var(--navy);box-shadow:0 1px 2px rgba(0,0,0,.08)}\n.donutbox{display:flex;align-items:center;gap:18px;flex-wrap:wrap;justify-content:center}\n.legend{flex:1;min-width:220px}\n.legend .row{display:flex;align-items:center;gap:8px;padding:5px 0;font-size:14px;border-bottom:1px dashed var(--line)}\n.legend .row:last-child{border:0}\n.legend .sw{width:11px;height:11px;border-radius:50%;flex:none}\n.legend .nm{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.legend .v{font-weight:800} .legend .p{color:var(--ink-3);font-size:12px;width:46px;text-align:left}\n.ringlist .row{display:flex;justify-content:space-between;padding:4px 0;font-size:14px}\n.ringlist .row b{font-weight:800}\n.ringlist .k{display:flex;gap:8px;align-items:center}\n.tile{border-radius:16px;padding:14px;text-align:center}\n.tile .n{font-size:28px;font-weight:800;line-height:1.2}\n.tile .l{font-size:13px;font-weight:700;opacity:.85}\n.t-blue{background:#e9f2fd;color:#184f95} .t-green{background:#e6f6ee;color:#0f6b3e}\n.t-gold{background:#fbf3dc;color:#8a6a0b} .t-red{background:#fdeaea;color:#a1262a}\n.t-navy{background:#e8ecf3;color:var(--navy)}\n.bookbar{margin-top:12px}\n.bookbar .lbl{display:flex;justify-content:space-between;font-size:13px;font-weight:700;color:var(--ink-2)}\n.bookbar .track{height:10px;background:#e8ebf0;border-radius:6px;overflow:hidden;margin-top:4px}\n.bookbar .track i{display:block;height:100%;background:linear-gradient(90deg,var(--gold-d),var(--gold));border-radius:6px}\ntable{width:100%;border-collapse:collapse;font-size:14px}\nth{font-size:12px;color:var(--ink-3);font-weight:700;text-align:right;padding:8px 6px;border-bottom:1px solid var(--line);white-space:nowrap;cursor:pointer;user-select:none}\ntd{padding:8px 6px;border-bottom:1px solid #f0f2f5;white-space:nowrap}\ntr:hover td{background:#fafbfd}\ntd.num,th.num{text-align:left;font-variant-numeric:tabular-nums}\n.minibar{height:7px;background:#eef0f4;border-radius:4px;width:110px;overflow:hidden;display:inline-block;vertical-align:middle;margin-inline-start:6px}\n.minibar i{display:block;height:100%;background:var(--steel);border-radius:4px}\n.scroll{overflow:auto;max-height:430px}\n.up{color:var(--good);font-weight:800}\n.muted{color:var(--ink-3);font-size:12px}\n.foot{display:flex;gap:10px;justify-content:center;margin:18px 0 6px;flex-wrap:wrap}\n.btn.navy{background:var(--navy);color:#fff;padding:12px 22px}\n.btn.line{background:#fff;color:var(--navy);border:1px solid var(--line);padding:12px 22px}\n#tip{position:fixed;pointer-events:none;background:var(--navy);color:#fff;font-size:13px;padding:7px 10px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.2);display:none;z-index:50;line-height:1.5}\nsvg text{font-family:Cairo,Tahoma,sans-serif}\n.modal{position:fixed;inset:0;background:rgba(11,26,43,.45);display:none;align-items:center;justify-content:center;z-index:40}\n.modal .box{background:#fff;border-radius:18px;padding:22px;width:min(420px,92vw)}\n.modal label{display:block;font-weight:700;font-size:13px;margin:12px 0 4px}\n.modal input{width:100%;border:1px solid var(--line);border-radius:10px;padding:8px 10px;font:inherit}\n.empty{color:var(--ink-3);text-align:center;padding:30px 0;font-size:14px}\n.f select,.f input{min-width:0;width:100%;-webkit-appearance:none;appearance:none}\nhtml,body{overflow-x:hidden}\n@media (max-width:900px){.g2,.g3{grid-template-columns:1fr}.g4{grid-template-columns:1fr 1fr}.filters{grid-template-columns:1fr}}\n@media (max-width:600px){\n  .wrap{padding:10px}\n  .top{padding:14px 16px;border-radius:14px}\n  .top h1{font-size:19px;line-height:1.4}\n  .top .sub{font-size:11px}\n  .filters{grid-template-columns:1fr 1fr;gap:8px}\n  .filters .f:first-child{grid-column:1/-1}\n  .card{padding:12px;border-radius:14px}\n  .card h3{font-size:15px;flex-wrap:wrap}\n  .card h3 small{display:none}\n  .grid{gap:10px}\n  .tile{padding:10px}.tile .n{font-size:22px}.tile .l{font-size:12px}\n  #tiles2 .n{font-size:17px!important}\n  table{font-size:12.5px}\n  th{font-size:11px;padding:6px 3px}\n  td{padding:7px 3px}\n  .minibar{display:none}\n  td[title]{max-width:120px!important;white-space:normal}\n  .hide-m{display:none}\n  [data-m]{display:block!important;font-size:11px}\n  .empty{white-space:normal}\n  .legend{min-width:0;width:100%}\n  .donutbox{flex-direction:column;gap:8px}\n  .btn.navy,.btn.line{padding:10px 14px;font-size:13px}\n  .foot{flex-direction:column;align-items:stretch}\n}\n@media print{.actions,.foot,.filters .f select{display:none}body{background:#fff}.card{break-inside:avoid}}\n</style>\n</head>\n<body>\n<div class=\"wrap\">\n  <div class=\"top\">\n    <div>\n      <div class=\"live\"><span class=\"dot\" id=\"dot\"></span><span id=\"liveTxt\">مباشر</span></div>\n      <h1>أداء التخصيصات — المرحلة الحادية عشر</h1>\n      <div class=\"sub\">قطع الأراضي السكنية · هيئة المجتمعات العمرانية الجديدة · المصدر: lands.nuca.gov.eg</div>\n    </div>\n    <div class=\"actions\">\n      <span class=\"upd\" id=\"upd\">—</span>\n      <button class=\"btn gold\" id=\"btnRefresh\">⟳ تحديث الآن</button>\n      <button class=\"btn ghost\" id=\"btnCfg\">⚙ الإعدادات</button>\n    </div>\n  </div>\n\n  <div class=\"filters\">\n    <div class=\"f\"><label>اليوم</label><input type=\"date\" id=\"fDate\"></div>\n    <div class=\"f\"><label>المدينة</label><select id=\"fCity\"><option value=\"\">كل المدن</option></select></div>\n    <div class=\"f\"><label>المنطقة</label><select id=\"fRegion\"><option value=\"\">كل المناطق</option></select></div>\n  </div>\n\n  <div class=\"prog\" id=\"prog\"><span id=\"progTxt\"></span><div class=\"bar\"><i id=\"progBar\"></i></div></div>\n  <div class=\"note\" id=\"note\"></div>\n\n  <div class=\"grid g2\">\n    <div class=\"card\">\n      <h3><span>توزيع التخصيصات على المدن</span>\n        <span class=\"seg\" id=\"segDist\"><button data-v=\"day\" class=\"on\">اليوم</button><button data-v=\"all\">التراكمي</button></span></h3>\n      <div class=\"donutbox\"><svg id=\"donut\" width=\"220\" height=\"220\" viewBox=\"0 0 220 220\"></svg><div class=\"legend\" id=\"legend\"></div></div>\n    </div>\n    <div class=\"card\">\n      <h3><span>نسبة تحقيق الهدف اليومي</span><small id=\"tgtDate\"></small></h3>\n      <div class=\"donutbox\"><svg id=\"ring\" width=\"220\" height=\"220\" viewBox=\"0 0 220 220\"></svg>\n        <div class=\"legend ringlist\" id=\"ringList\"></div></div>\n    </div>\n  </div>\n\n  <div class=\"card\" style=\"margin-top:14px\">\n    <h3><span>التخصيصات خلال آخر 7 أيام</span><small id=\"wkSum\"></small></h3>\n    <svg id=\"bars\" width=\"100%\" height=\"260\" preserveAspectRatio=\"none\"></svg>\n  </div>\n\n  <div class=\"grid g4\" style=\"margin-top:14px\" id=\"tiles\"></div>\n  <div class=\"card bookbar\" style=\"margin-top:14px\">\n    <div class=\"lbl\"><span>نسبة التخصيص من إجمالي القطع المطروحة</span><span id=\"pctTxt\"></span></div>\n    <div class=\"track\"><i id=\"pctBar\"></i></div>\n  </div>\n\n  <div class=\"grid g4\" style=\"margin-top:14px\" id=\"tiles2\"></div>\n\n  <div class=\"grid g2\" style=\"margin-top:14px\">\n    <div class=\"card\">\n      <h3><span>موقف المدن</span><small>اضغط عنوان العمود للترتيب</small></h3>\n      <div class=\"scroll\"><table id=\"tblCity\"></table></div>\n    </div>\n    <div class=\"card\">\n      <h3><span>أعلى المناطق إقبالاً</span><small>حسب عدد القطع المخصصة</small></h3>\n      <div class=\"scroll\"><table id=\"tblRegion\"></table></div>\n    </div>\n  </div>\n\n  <div class=\"grid g2\" style=\"margin-top:14px\">\n    <div class=\"card\">\n      <h3><span>أحدث التخصيصات المرصودة</span><small id=\"recentN\"></small></h3>\n      <div class=\"scroll\"><table id=\"tblRecent\"></table></div>\n    </div>\n    <div class=\"card\">\n      <h3><span>سجل التحديثات</span></h3>\n      <div class=\"scroll\"><table id=\"tblRuns\"></table></div>\n    </div>\n  </div>\n\n  <div class=\"foot\">\n    <a class=\"btn navy\" id=\"btnExport\" href=\"/api/export.csv\">⬇ تصدير البيانات التفصيلية (Excel / CSV)</a>\n    <button class=\"btn line\" onclick=\"window.print()\">🖨 طباعة / PDF</button>\n  </div>\n  <div class=\"muted\" style=\"text-align:center\">يتم رصد التخصيص بمقارنة حالة كل قطعة بين تحديث وآخر؛ وقت التخصيص = وقت التحديث الذي ظهرت فيه القطعة «غير متاحة» لأول مرة.</div>\n</div>\n\n<div id=\"tip\"></div>\n<div class=\"modal\" id=\"modal\"><div class=\"box\">\n  <h3 style=\"margin:0\">الإعدادات</h3>\n  <label>الهدف اليومي (عدد التخصيصات)</label><input type=\"number\" id=\"cTarget\" min=\"1\">\n  <div id=\"schedBox\"><label>مواعيد التحديث التلقائي (HH:MM مفصولة بفاصلة)</label><input id=\"cSched\" placeholder=\"10:00, 15:00, 21:00\"></div>\n  <div style=\"display:flex;gap:8px;margin-top:16px;justify-content:flex-start\">\n    <button class=\"btn gold\" id=\"cSave\">حفظ</button><button class=\"btn line\" id=\"cClose\">إلغاء</button></div>\n</div></div>\n\n<script>\nconst $=s=>document.querySelector(s);\nconst fmt=n=>Math.round(n).toLocaleString('en-US');\nconst fmtM=n=>n>=1e9?(n/1e9).toFixed(2)+' مليار':n>=1e6?(n/1e6).toFixed(1)+' مليون':fmt(n);\nconst pct=(a,b)=>b?(a/b*100):0;\nconst SER=['var(--s1)','var(--s2)','var(--s3)','var(--s4)'];\nconst NS='http://www.w3.org/2000/svg';\nlet D=null, distMode='day', sortCity={k:'booked',d:-1};\nconst tip=$('#tip');\nfunction showTip(e,html){tip.innerHTML=html;tip.style.display='block';tip.style.left=Math.min(e.clientX+14,innerWidth-220)+'px';tip.style.top=(e.clientY+14)+'px'}\nfunction hideTip(){tip.style.display='none'}\nfunction el(tag,attrs,parent){const n=document.createElementNS(NS,tag);for(const k in attrs)n.setAttribute(k,attrs[k]);parent&&parent.appendChild(n);return n}\nconst todayStr=()=>{const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')};\nconst addDays=(s,k)=>{const d=new Date(s+'T12:00:00');d.setDate(d.getDate()+k);return d.toISOString().slice(0,10)};\nconst shortDate=s=>{const [y,m,d]=s.split('-');return (+d)+'/'+(+m)};\n\nfunction zonesF(){\n  const c=$('#fCity').value, r=$('#fRegion').value;\n  return D.zones.filter(z=>(!c||z.city===c)&&(!r||z.region===r));\n}\nfunction dailyF(){\n  const ids=new Set(zonesF().map(z=>z.zone_id));\n  return D.daily.filter(x=>ids.has(x.zone_id));\n}\nfunction zoneById(id){return D.zones.find(z=>z.zone_id===id)}\n\nfunction fillFilters(){\n  const cities=[...new Set(D.zones.map(z=>z.city))].sort((a,b)=>a.localeCompare(b,'ar'));\n  const fc=$('#fCity'), cur=fc.value;\n  fc.innerHTML='<option value=\"\">كل المدن</option>'+cities.map(c=>`<option>${c}</option>`).join('');\n  fc.value=cur; fillRegions();\n}\nfunction fillRegions(){\n  const c=$('#fCity').value, fr=$('#fRegion'), cur=fr.value;\n  const regs=[...new Set(D.zones.filter(z=>!c||z.city===c).map(z=>(c?'':'')+z.region))].sort((a,b)=>a.localeCompare(b,'ar'));\n  fr.innerHTML='<option value=\"\">كل المناطق</option>'+regs.map(r=>`<option>${r}</option>`).join('');\n  fr.value=regs.includes(cur)?cur:'';\n}\n\nfunction render(){\n  if(!D)return;\n  const date=$('#fDate').value||todayStr();\n  const Z=zonesF(), DY=dailyF();\n  const total=Z.reduce((a,z)=>a+z.total,0), booked=Z.reduce((a,z)=>a+z.booked,0);\n  const dayRows=DY.filter(x=>x.d===date), dayN=dayRows.reduce((a,x)=>a+x.n,0);\n  const dayV=dayRows.reduce((a,x)=>a+(x.v||0),0);\n  const target=D.config.daily_target;\n\n  // note\n  const nt=$('#note');\n  if(D.baseline){const b=D.baseline.slice(0,16).replace('T',' ');\n    nt.style.display='block';nt.innerHTML=`بدأ الرصد في <b>${b}</b>. التخصيصات التي تمت قبل ذلك تظهر في الإجماليات فقط ولا تُحسب ضمن التخصيصات اليومية.`;}\n  else {nt.style.display='block';nt.innerHTML='لا توجد بيانات بعد — اضغط «تحديث الآن» لإنشاء خط الأساس (قد يستغرق عدة دقائق).';}\n\n  // donut by city\n  const byCity={};\n  if(distMode==='day') dayRows.forEach(x=>{const c=zoneById(x.zone_id).city;byCity[c]=(byCity[c]||0)+x.n});\n  else Z.forEach(z=>{byCity[z.city]=(byCity[z.city]||0)+z.booked});\n  const groupKey=$('#fCity').value?'region':'city';\n  let parts;\n  if(groupKey==='region'){const m={};\n    if(distMode==='day') dayRows.forEach(x=>{const r=zoneById(x.zone_id).region;m[r]=(m[r]||0)+x.n});\n    else Z.forEach(z=>{m[z.region]=(m[z.region]||0)+z.booked}); parts=m;} else parts=byCity;\n  let arr=Object.entries(parts).filter(x=>x[1]>0).sort((a,b)=>b[1]-a[1]);\n  const top=arr.slice(0,4), rest=arr.slice(4).reduce((a,x)=>a+x[1],0);\n  const segs=top.map((x,i)=>({name:x[0],v:x[1],c:SER[i]}));\n  if(rest>0)segs.push({name:'أخرى ('+(arr.length-4)+')',v:rest,c:'var(--other)'});\n  const sum=segs.reduce((a,s)=>a+s.v,0);\n  drawDonut(segs,sum,distMode==='day'?'تخصيص اليوم':'إجمالي مخصص');\n  $('#legend').innerHTML=segs.length?segs.map(s=>`<div class=\"row\"><span class=\"sw\" style=\"background:${s.c}\"></span><span class=\"nm\" title=\"${s.name}\">${s.name}</span><span class=\"v\">${fmt(s.v)}</span><span class=\"p\">(${pct(s.v,sum).toFixed(0)}%)</span></div>`).join('')\n    :`<div class=\"empty\">لا توجد تخصيصات ${distMode==='day'?'مرصودة في هذا اليوم':''}</div>`;\n\n  // target ring\n  $('#tgtDate').textContent=date;\n  drawRing(dayN,target);\n  $('#ringList').innerHTML=`\n   <div class=\"row\"><span class=\"k\"><span class=\"sw\" style=\"background:var(--gold);width:11px;height:11px;border-radius:50%\"></span>تخصيصات اليوم</span><b>${fmt(dayN)}</b></div>\n   <div class=\"row\"><span class=\"k\"><span class=\"sw\" style=\"background:#d6dae1;width:11px;height:11px;border-radius:50%\"></span>المتبقي للهدف</span><b>${fmt(Math.max(0,target-dayN))}</b></div>\n   <div class=\"row\"><span class=\"k\"><span class=\"sw\" style=\"background:var(--navy);width:11px;height:11px;border-radius:50%\"></span>الهدف اليومي</span><b>${fmt(target)}</b></div>\n   <div class=\"row\"><span class=\"k\">قيمة تخصيصات اليوم</span><b>$ ${fmtM(dayV)}</b></div>`;\n\n  // 7 days\n  const days=[...Array(7)].map((_,i)=>addDays(date,i-6));\n  const vals=days.map(d=>DY.filter(x=>x.d===d).reduce((a,x)=>a+x.n,0));\n  drawBars(days,vals,date,target);\n  const wk=vals.reduce((a,b)=>a+b,0);\n  $('#wkSum').textContent=`الإجمالي ${fmt(wk)} · المتوسط ${fmt(wk/7)} يومياً`;\n\n  // tiles\n  const avail=total-booked;\n  $('#tiles').innerHTML=[\n    ['t-navy','▦',fmt(total),'إجمالي القطع المطروحة'],\n    ['t-green','⌂',fmt(avail),'قطعة متاحة الآن'],\n    ['t-red','✓',fmt(booked),'إجمالي المخصص'],\n    ['t-gold','◷',fmt(dayN),'مخصص في اليوم المحدد']\n  ].map(t=>`<div class=\"tile ${t[0]}\"><div>${t[1]}</div><div class=\"n\">${t[2]}</div><div class=\"l\">${t[3]}</div></div>`).join('');\n  const p=pct(booked,total);\n  $('#pctTxt').textContent=p.toFixed(1)+'% مخصص';$('#pctBar').style.width=p+'%';\n\n  const vb=Z.reduce((a,z)=>a+z.value_booked,0), db=Z.reduce((a,z)=>a+z.down_booked,0), ab=Z.reduce((a,z)=>a+z.area_booked,0);\n  const daysLeft=avail&&wk?Math.ceil(avail/(wk/7)):null;\n  $('#tiles2').innerHTML=[\n    ['t-blue','$ '+fmtM(vb),'قيمة القطع المخصصة (دولار)'],\n    ['t-blue','$ '+fmtM(db),'الدفعات المقدمة المستحقة (دولار)'],\n    ['t-blue',fmt(ab)+' م²','المساحة المخصصة'],\n    ['t-blue',daysLeft?fmt(daysLeft)+' يوم':'—','المدة المتوقعة لنفاد المتاح (بمعدل الأسبوع)']\n  ].map(t=>`<div class=\"tile ${t[0]}\"><div class=\"n\" style=\"font-size:22px\">${t[1]}</div><div class=\"l\">${t[2]}</div></div>`).join('');\n\n  // city table\n  const cityAgg={};\n  Z.forEach(z=>{const c=cityAgg[z.city]||(cityAgg[z.city]={name:z.city,total:0,booked:0,day:0,value:0});c.total+=z.total;c.booked+=z.booked;c.value+=z.value_booked});\n  dayRows.forEach(x=>{const c=cityAgg[zoneById(x.zone_id).city];if(c)c.day+=x.n});\n  let cr=Object.values(cityAgg).map(c=>({...c,avail:c.total-c.booked,rate:pct(c.booked,c.total)}));\n  cr.sort((a,b)=>{const k=sortCity.k;return (typeof a[k]==='string'?a[k].localeCompare(b[k],'ar'):a[k]-b[k])*sortCity.d});\n  const cols=[['name','المدينة'],['total','المطروح'],['booked','المخصص'],['avail','المتاح'],['day','اليوم'],['rate','نسبة التخصيص']];\n  $('#tblCity').innerHTML='<tr>'+cols.map(c=>`<th data-k=\"${c[0]}\" class=\"${c[0]==='name'?'':'num'}${c[0]==='avail'?' hide-m':''}\">${c[1]}${sortCity.k===c[0]?(sortCity.d<0?' ▼':' ▲'):''}</th>`).join('')+'</tr>'+\n    cr.map(c=>`<tr><td>${c.name}</td><td class=\"num\">${fmt(c.total)}</td><td class=\"num\">${fmt(c.booked)}</td><td class=\"num hide-m\">${fmt(c.avail)}</td><td class=\"num ${c.day?'up':''}\">${c.day?'+'+fmt(c.day):'0'}</td><td class=\"num\">${c.rate.toFixed(1)}%<span class=\"minibar\"><i style=\"width:${c.rate}%\"></i></span></td></tr>`).join('');\n  $('#tblCity').querySelectorAll('th').forEach(th=>th.onclick=()=>{const k=th.dataset.k;sortCity={k,d:sortCity.k===k?-sortCity.d:-1};render()});\n\n  // region table\n  const reg={};\n  Z.forEach(z=>{const k=z.city+'|'+z.region;const r=reg[k]||(reg[k]={city:z.city,region:z.region,total:0,booked:0});r.total+=z.total;r.booked+=z.booked});\n  const rr=Object.values(reg).map(r=>({...r,rate:pct(r.booked,r.total)})).sort((a,b)=>b.booked-a.booked||b.rate-a.rate);\n  $('#tblRegion').innerHTML='<tr><th>المنطقة</th><th class=\"hide-m\">المدينة</th><th class=\"num\">المخصص من المطروح</th><th class=\"num\">النسبة</th></tr>'+\n    rr.map(r=>`<tr><td title=\"${r.region}\" style=\"max-width:220px;overflow:hidden;text-overflow:ellipsis\">${r.region}<div class=\"muted\" style=\"display:none\" data-m>${r.city}</div></td><td class=\"muted hide-m\">${r.city}</td><td class=\"num\">${fmt(r.booked)} من ${fmt(r.total)}</td><td class=\"num\">${r.rate.toFixed(0)}%<span class=\"minibar\" style=\"width:70px\"><i style=\"width:${r.rate}%;background:var(--gold)\"></i></span></td></tr>`).join('');\n\n  // recent\n  const c=$('#fCity').value, rg=$('#fRegion').value;\n  const rec=D.recent.filter(x=>(!c||x.city===c)&&(!rg||x.region===rg));\n  $('#recentN').textContent=rec.length?`آخر ${rec.length}`:'';\n  $('#tblRecent').innerHTML=rec.length?'<tr><th>وقت الرصد</th><th>المدينة</th><th>المنطقة</th><th class=\"num\">القطعة</th><th class=\"num hide-m\">المساحة</th><th class=\"num\">السعر $</th></tr>'+\n    rec.map(x=>`<tr><td class=\"muted\">${x.ts.replace('T',' ').slice(5,16)}</td><td>${x.city}</td><td title=\"${x.region} — مربع ${x.block}\" style=\"max-width:150px;overflow:hidden;text-overflow:ellipsis\">${x.region}</td><td class=\"num\">${x.plot}</td><td class=\"num hide-m\">${fmt(x.area)}</td><td class=\"num\">${fmtM(x.total_price)}</td></tr>`).join('')\n    :'<tr><td class=\"empty\">ستظهر هنا التخصيصات الجديدة بدءاً من التحديث التالي لخط الأساس</td></tr>';\n\n  // runs\n  $('#tblRuns').innerHTML='<tr><th>الوقت</th><th class=\"num\">المطروح</th><th class=\"num\">المخصص</th><th class=\"num\">جديد</th><th class=\"hide-m\">ملاحظة</th></tr>'+\n    D.runs.map(r=>`<tr><td class=\"muted\">${(r.finished||'').replace('T',' ').slice(0,16)}</td><td class=\"num\">${fmt(r.total)}</td><td class=\"num\">${fmt(r.booked)}</td><td class=\"num ${r.new_booked?'up':''}\">${r.new_booked?'+'+fmt(r.new_booked):'0'}</td><td class=\"muted hide-m\" style=\"white-space:normal\">${r.note||(r.ok?'تم':'')}${r.released?` · أُلغي ${r.released}`:''}</td></tr>`).join('');\n\n  const last=D.runs[0];\n  $('#upd').textContent=last?('آخر تحديث: '+last.finished.replace('T',' ').slice(0,16)):'لم يتم التحديث بعد';\n}\n\nfunction drawDonut(segs,sum,label){\n  const s=$('#donut');s.innerHTML='';const cx=110,cy=110,R=92,r=62;\n  if(!sum){el('circle',{cx,cy,r:(R+r)/2,fill:'none',stroke:'#eef0f4','stroke-width':R-r},s);}\n  let a0=-Math.PI/2;const gap=segs.length>1?0.02:0;\n  segs.forEach(sg=>{const a=sg.v/sum*2*Math.PI;const a1=a0+a;\n    const p=arc(cx,cy,R,r,a0+gap/2,a1-gap/2);\n    const path=el('path',{d:p,fill:sg.c,style:'cursor:pointer'},s);\n    path.onmousemove=e=>showTip(e,`<b>${sg.name}</b><br>${fmt(sg.v)} تخصيص · ${pct(sg.v,sum).toFixed(1)}%`);\n    path.onmouseleave=hideTip;a0=a1;});\n  el('text',{x:cx,y:cy-18,'text-anchor':'middle','font-size':13,fill:'var(--ink-2)','font-weight':700},s).textContent='إجمالي';\n  el('text',{x:cx,y:cy+12,'text-anchor':'middle','font-size':32,'font-weight':800,fill:'var(--ink)'},s).textContent=fmt(sum);\n  el('text',{x:cx,y:cy+34,'text-anchor':'middle','font-size':12,fill:'var(--ink-3)','font-weight':700},s).textContent=label;\n}\nfunction arc(cx,cy,R,r,a0,a1){\n  if(a1-a0>=2*Math.PI-0.001)a1=a0+2*Math.PI-0.001;\n  const L=a1-a0>Math.PI?1:0,P=(rad,a)=>[cx+rad*Math.cos(a),cy+rad*Math.sin(a)];\n  const [x0,y0]=P(R,a0),[x1,y1]=P(R,a1),[x2,y2]=P(r,a1),[x3,y3]=P(r,a0);\n  return `M${x0},${y0}A${R},${R} 0 ${L} 1 ${x1},${y1}L${x2},${y2}A${r},${r} 0 ${L} 0 ${x3},${y3}Z`;\n}\nfunction drawRing(v,t){\n  const s=$('#ring');s.innerHTML='';const cx=110,cy=110,R=82,w=22,C=2*Math.PI*R;\n  el('circle',{cx,cy,r:R,fill:'none',stroke:'#eceef2','stroke-width':w},s);\n  const p=Math.min(v/t,1);\n  const g=el('defs',{},s);const lg=el('linearGradient',{id:'gg',x1:0,y1:0,x2:1,y2:1},g);\n  el('stop',{offset:'0','stop-color':'#e2bd45'},lg);el('stop',{offset:'1','stop-color':'#a8851a'},lg);\n  if(p>0)el('circle',{cx,cy,r:R,fill:'none',stroke:'url(#gg)','stroke-width':w,'stroke-linecap':p>0.06?'round':'butt','stroke-dasharray':`${C*p} ${C}`,transform:`rotate(-90 ${cx} ${cy})`},s);\n  el('text',{x:cx,y:cy+8,'text-anchor':'middle','font-size':36,'font-weight':800,fill:'var(--ink)'},s).textContent=Math.round(v/t*100)+'%';\n  el('text',{x:cx,y:cy+32,'text-anchor':'middle','font-size':13,fill:'var(--ink-3)','font-weight':700},s).textContent='من الهدف';\n}\nfunction drawBars(days,vals,sel,target){\n  const s=$('#bars');s.innerHTML='';const W=s.clientWidth||900,H=260;s.setAttribute('viewBox',`0 0 ${W} ${H}`);\n  const top=28,bot=34,ph=H-top-bot,mx=Math.max(...vals,1)*1.1;\n  for(let i=0;i<=3;i++){const y=top+ph*i/3;el('line',{x1:0,x2:W,y1:y,y2:y,stroke:'#eef0f4'},s)}\n  const n=days.length,slot=W/n,bw=Math.min(64,slot*0.5);\n  days.forEach((d,i)=>{\n    const x=W-(i+1)*slot+(slot-bw)/2; // RTL: oldest at right\n    const h=vals[i]/mx*ph,y=top+ph-h,isSel=d===sel;\n    const hit=el('rect',{x:W-(i+1)*slot,y:top,width:slot,height:ph,fill:'transparent'},s);\n    if(h>0){const r=Math.min(4,h/2);el('path',{d:`M${x},${top+ph}V${y+r}Q${x},${y} ${x+r},${y}H${x+bw-r}Q${x+bw},${y} ${x+bw},${y+r}V${top+ph}Z`,fill:isSel?'var(--gold-d)':'var(--gold-l)'},s);}\n    el('line',{x1:x,x2:x+bw,y1:top+ph,y2:top+ph,stroke:'#c9ced8'},s);\n    const t=el('text',{x:x+bw/2,y:y-7,'text-anchor':'middle','font-size':14,'font-weight':800,fill:'var(--ink)'},s);t.textContent=fmt(vals[i]);\n    const lb=el('text',{x:x+bw/2,y:H-10,'text-anchor':'middle','font-size':13,'font-weight':isSel?800:600,fill:isSel?'var(--ink)':'var(--ink-3)'},s);\n    lb.textContent=d===todayStr()?'اليوم':shortDate(d);\n    hit.onmousemove=e=>showTip(e,`<b>${d}</b><br>${fmt(vals[i])} تخصيص<br>${pct(vals[i],target).toFixed(0)}% من الهدف`);\n    hit.onmouseleave=hideTip;\n    hit.onclick=()=>{$('#fDate').value=d;render()};\n  });\n}\n\n/*__STATIC_DATA__*/\nconst GAS=typeof window.GAS!=='undefined';\nconst ONLINE=GAS||typeof window.DATA_URL!=='undefined';\nconst gasCall=(fn)=>new Promise((res,rej)=>google.script.run.withSuccessHandler(res).withFailureHandler(rej)[fn]());\nconst STATIC=ONLINE||typeof window.STATIC_DATA!=='undefined';\nfunction ageTxt(){if(!D||!D.ts)return '';const m=Math.max(0,Math.round((Date.now()-D.ts)/60000));\n  return m<1?'الآن':m<60?`منذ ${m} دقيقة`:`منذ ${Math.floor(m/60)} ساعة و${m%60} دقيقة`;}\nfunction setLive(){$('#liveTxt').textContent='مباشر — آخر رصد من موقع الهيئة '+ageTxt();\n  $('#upd').textContent='آخر رصد: '+D.now.replace('T',' ').slice(0,16)+(D.next_minutes?` · يتم الرصد كل ${D.next_minutes>=60?'ساعة':D.next_minutes+' دقيقة'}`:'');}\nasync function loadOnline(){\n  try{let nd;\n    if(GAS){nd=JSON.parse(await gasCall('getData'));if(!nd.zones)throw 0;}\n    else{const r=await fetch(window.DATA_URL+'?t='+Date.now(),{cache:'no-store'});if(!r.ok)throw 0;nd=await r.json();}const first=!D, changed=first||nd.now!==D.now;\n    if(changed){D=nd;applyLocalTarget();fillFilters();render();if(!first)flashDone({message:`رصد جديد ${nd.now.replace('T',' ').slice(11,16)}`});}\n    $('#dot').classList.remove('off');setLive();\n  }catch(e){$('#dot').classList.add('off');$('#liveTxt').textContent='تعذر الاتصال — تُعرض آخر بيانات محمّلة';}\n}\nfunction applyLocalTarget(){try{const t=+localStorage.getItem('nuca_target');if(t>0)D.config.daily_target=t;}catch(e){}}\nfunction exportStatic(){\n  const H=['المدينة','المنطقة','المربع','القطعة','المساحة م2','سعر المتر $','السعر الإجمالي $','الدفعة المقدمة $','الحالة','وقت رصد التخصيص','ملاحظة'];\n  const zs={};D.zones.forEach(z=>zs[z.zone_id]=z);\n  const esc=v=>{v=v==null?'':String(v);return /[\",\\n]/.test(v)?'\"'+v.replace(/\"/g,'\"\"')+'\"':v};\n  const rows=D.plots.map(p=>{const z=zs[p[0]];return [z.city,z.region,p[1],p[2],p[3],p[4],p[5],p[6],p[7]?'مخصصة':'متاحة',p[8]||'',p[9]?'قبل بدء الرصد':''].map(esc).join(',')});\n  const blob=new Blob(['\\ufeff'+[H.join(','),...rows].join('\\r\\n')],{type:'text/csv;charset=utf-8'});\n  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='nuca_phase11_'+(D.now||'').slice(0,10)+'.csv';a.click();\n}\nasync function load(){\n  if(ONLINE){$('#btnRefresh').style.display='none';$('#schedBox').style.display='none';\n    if(GAS){$('#btnExport').setAttribute('href',window.EXEC_URL+'?format=csv');$('#btnExport').setAttribute('target','_top');}\n    else{$('#btnExport').setAttribute('href','plots.csv');$('#btnExport').setAttribute('download','nuca_phase11.csv');}\n    return loadOnline();}\n  if(STATIC){D=window.STATIC_DATA;applyLocalTarget();fillFilters();render();\n    $('#btnRefresh').style.display='none';$('#schedBox').style.display='none';\n    $('#liveTxt').textContent='نسخة محفوظة — '+D.now.replace('T',' ').slice(0,16);$('#dot').classList.add('off');\n    $('#btnExport').removeAttribute('href');$('#btnExport').style.cursor='pointer';$('#btnExport').onclick=exportStatic;return;}\n  try{const r=await fetch('/api/data');D=await r.json();fillFilters();render();handleProgress(D.progress);$('#dot').classList.remove('off');$('#liveTxt').textContent='مباشر';}\n  catch(e){$('#dot').classList.add('off');$('#liveTxt').textContent='غير متصل بالخادم';}\n}\nlet polling=null;\nfunction flashDone(s){const box=$('#prog');if(s.error)return;box.style.display='block';box.style.background='#e6f6ee';box.style.color='#0f6b3e';\n  $('#progTxt').textContent='✓ تم تحديث البيانات من موقع الهيئة — '+(s.message||'');$('#progBar').style.width='100%';\n  setTimeout(()=>{box.style.display='none';box.style.background='';box.style.color='';},8000);}\nfunction handleProgress(p){\n  const box=$('#prog');\n  if(p&&p.running){box.style.display='block';$('#progTxt').textContent=`⟳ جاري التحديث من موقع الهيئة الآن… تُعرض آخر بيانات محفوظة لحين الانتهاء (${p.done}/${p.total||'?'} منطقة)`;$('#liveTxt').textContent='جاري التحديث…';\n    $('#progBar').style.width=(p.total?p.done/p.total*100:5)+'%';$('#btnRefresh').disabled=true;\n    if(!polling)polling=setInterval(async()=>{const s=await (await fetch('/api/status')).json();if(!s.running){clearInterval(polling);polling=null;await load();flashDone(s);}else handleProgress(s)},3000);}\n  else{box.style.display=p&&p.error?'block':'none';if(p&&p.error)$('#progTxt').textContent='آخر تحديث فشل: '+p.error;$('#btnRefresh').disabled=false;}\n}\n$('#btnRefresh').onclick=async()=>{await fetch('/api/refresh',{method:'POST'});const s=await (await fetch('/api/status')).json();handleProgress(s)};\n$('#fDate').value=todayStr();\n$('#fDate').onchange=render;\n$('#fCity').onchange=()=>{fillRegions();render()};\n$('#fRegion').onchange=render;\n$('#segDist').querySelectorAll('button').forEach(b=>b.onclick=()=>{distMode=b.dataset.v;$('#segDist').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));render()});\n$('#btnCfg').onclick=()=>{$('#cTarget').value=D.config.daily_target;$('#cSched').value=D.config.schedule.join(', ');$('#modal').style.display='flex'};\n$('#cClose').onclick=()=>$('#modal').style.display='none';\n$('#cSave').onclick=async()=>{if(STATIC){try{localStorage.setItem('nuca_target',+$('#cTarget').value);}catch(e){}$('#modal').style.display='none';D.config.daily_target=+$('#cTarget').value;render();return;}await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({daily_target:+$('#cTarget').value,schedule:$('#cSched').value.split(',')})});$('#modal').style.display='none';load()};\naddEventListener('resize',()=>render());\n// تحديث فوري من الموقع عند فتح الصفحة وعند الرجوع إليها\nlet gasRefreshing=false;\nasync function refreshOnOpen(){\n  if(GAS){await loadOnline();if(gasRefreshing)return;\n    const age=D&&D.ts?(Date.now()-D.ts)/60000:1e9; if(age<30)return;\n    gasRefreshing=true;const box=$('#prog');box.style.display='block';$('#progBar').style.width='35%';\n    $('#progTxt').textContent='⟳ جاري الرصد من موقع الهيئة الآن (أقل من دقيقة)… تُعرض آخر بيانات محفوظة';\n    try{await gasCall('refreshIfStale');}catch(e){}\n    gasRefreshing=false;box.style.display='none';await loadOnline();return;}\n  if(ONLINE)return loadOnline();\n  if(STATIC)return;\n  try{const r=await (await fetch('/api/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({min_age:120})})).json();\n    handleProgress(r.progress);}catch(e){}\n}\nload().then(refreshOnOpen);\nif(ONLINE){setInterval(loadOnline,60*1000);\n  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refreshOnOpen()});}\nif(!STATIC){setInterval(load,5*60*1000);\n  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refreshOnOpen()});}\n</script>\n</body>\n</html>\n";
