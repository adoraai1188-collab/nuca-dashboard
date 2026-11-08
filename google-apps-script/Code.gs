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
  var html = HtmlService.createHtmlOutputFromFile('Index').getContent()
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
