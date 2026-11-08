# -*- coding: utf-8 -*-
"""
خادم لوحة متابعة تخصيصات المرحلة الحادية عشر - يعمل محلياً على جهازك
التشغيل:  python server.py   ثم افتح  http://localhost:8765
"""
import json, os, sqlite3, threading, time, csv, io, webbrowser
from datetime import datetime
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse
sys_path_here = os.path.dirname(os.path.abspath(__file__))
import sys as _sys
if sys_path_here not in _sys.path:
    _sys.path.insert(0, sys_path_here)
import collector  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "nuca.db")
CFG = os.path.join(HERE, "config.json")
PORT = 8765
DEFAULT_CFG = {"daily_target": 1000, "schedule": ["10:00", "15:00", "21:00"]}


def load_cfg():
    try:
        c = json.load(open(CFG, encoding="utf-8"))
        return {**DEFAULT_CFG, **c}
    except Exception:
        return dict(DEFAULT_CFG)


def save_cfg(c):
    json.dump(c, open(CFG, "w", encoding="utf-8"), ensure_ascii=False, indent=2)


def log(msg):
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    print(line, flush=True)
    with open(os.path.join(HERE, "log.txt"), "a", encoding="utf-8") as f:
        f.write(line + "\n")


OUT_HTML = os.path.join(HERE, "لوحة_التخصيصات.html")


def write_html(path=OUT_HTML):
    """ينتج ملف HTML واحد مستقل يحتوي البيانات بالكامل (يفتح بدون خادم ويمكن إرساله)"""
    data = build_data(with_plots=True)
    data["progress"] = {"running": False}
    tpl = open(os.path.join(HERE, "web", "index.html"), encoding="utf-8").read()
    js = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    html = tpl.replace("/*__STATIC_DATA__*/", "window.STATIC_DATA=" + js + ";", 1)
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    return path


def _run_and_export():
    if collector.run(DB, log):
        try:
            log("تم حفظ ملف HTML: " + write_html())
        except Exception as e:  # noqa
            log(f"تعذر حفظ ملف HTML: {e}")


def last_finished_age():
    """عدد الثواني منذ آخر تحديث ناجح (None لو لا يوجد)"""
    try:
        con = collector.db(DB)
        r = con.execute("SELECT MAX(finished) FROM runs").fetchone()[0]
        con.close()
        return (datetime.now() - datetime.fromisoformat(r)).total_seconds() if r else None
    except Exception:
        return None


def start_refresh(min_age=0):
    """يبدأ تحديثاً من الموقع. min_age: لا تحدّث لو آخر تحديث أحدث من هذا العدد من الثواني"""
    if collector.progress["running"]:
        return False
    age = last_finished_age()
    if min_age and age is not None and age < min_age:
        return False
    threading.Thread(target=_run_and_export, daemon=True).start()
    return True


def scheduler():
    fired = set()
    while True:
        now = datetime.now()
        key = now.strftime("%Y-%m-%d %H:%M")
        if now.strftime("%H:%M") in load_cfg()["schedule"] and key not in fired:
            fired.add(key); log("تحديث مجدول"); start_refresh()
        time.sleep(20)


def q(con, sql, *a):
    con.row_factory = sqlite3.Row
    return [dict(r) for r in con.execute(sql, a).fetchall()]


def build_data(with_plots=False):
    con = collector.db(DB)
    try:
        zones = q(con, """SELECT z.zone_id, z.city, z.region, z.meter_egp,
            COUNT(p.plot) total, COALESCE(SUM(p.booked),0) booked,
            COALESCE(SUM(p.area),0) area, COALESCE(SUM(CASE WHEN p.booked=1 THEN p.area END),0) area_booked,
            COALESCE(SUM(CASE WHEN p.booked=1 THEN p.total_price END),0) value_booked,
            COALESCE(SUM(CASE WHEN p.booked=1 THEN p.down_payment END),0) down_booked
            FROM zones z LEFT JOIN plots p ON p.zone_id=z.zone_id GROUP BY z.zone_id""")
        daily = q(con, """SELECT substr(booked_at,1,10) d, zone_id, COUNT(*) n,
            SUM(total_price) v FROM plots WHERE booked=1 AND baseline=0 AND booked_at IS NOT NULL
            GROUP BY d, zone_id""")
        recent = q(con, """SELECT p.booked_at ts, z.city, z.region, p.block, p.plot, p.area, p.total_price
            FROM plots p JOIN zones z ON z.zone_id=p.zone_id
            WHERE p.booked=1 AND p.baseline=0 ORDER BY p.booked_at DESC LIMIT 100""")
        runs = q(con, "SELECT * FROM runs ORDER BY id DESC LIMIT 30")
        first = q(con, "SELECT MIN(started) s FROM runs")[0]["s"]
        plots = None
        if with_plots:
            plots = [list(r) for r in con.execute("""SELECT zone_id, block, plot, area, meter_price, total_price,
                down_payment, booked, booked_at, baseline FROM plots ORDER BY zone_id, block, CAST(plot AS INT)""")]
        return {"plots": plots, "zones": zones, "daily": daily, "recent": recent, "runs": runs,
                "baseline": first, "config": load_cfg(), "progress": collector.progress,
                "now": datetime.now().isoformat(timespec="seconds")}
    finally:
        con.close()


def export_csv():
    con = collector.db(DB)
    rows = con.execute("""SELECT z.city, z.region, p.block, p.plot, p.area, p.meter_price, p.total_price,
        p.down_payment, CASE p.booked WHEN 1 THEN 'مخصصة' ELSE 'متاحة' END, p.booked_at,
        CASE p.baseline WHEN 1 THEN 'قبل بدء الرصد' ELSE '' END
        FROM plots p JOIN zones z ON z.zone_id=p.zone_id ORDER BY z.city, z.region, p.block, CAST(p.plot AS INT)""").fetchall()
    con.close()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["المدينة", "المنطقة", "المربع", "القطعة", "المساحة م2", "سعر المتر $", "السعر الإجمالي $",
                "الدفعة المقدمة $", "الحالة", "وقت رصد التخصيص", "ملاحظة"])
    w.writerows(rows)
    return ("﻿" + buf.getvalue()).encode("utf-8")


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = urlparse(self.path).path
        if p in ("/", "/index.html"):
            return self.send(200, open(os.path.join(HERE, "web", "index.html"), "rb").read(), "text/html; charset=utf-8")
        if p == "/api/data":
            return self.send(200, build_data())
        if p == "/api/status":
            return self.send(200, collector.progress)
        if p == "/api/export.csv":
            fn = f"nuca_phase11_{datetime.now():%Y%m%d_%H%M}.csv"
            return self.send(200, export_csv(), "text/csv; charset=utf-8",
                             {"Content-Disposition": f'attachment; filename="{fn}"'})
        self.send(404, {"error": "not found"})

    def do_POST(self):
        p = urlparse(self.path).path
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}") if n else {}
        if p == "/api/refresh":
            # عند فتح الصفحة: تحديث فوري ما لم يكن هناك تحديث تم خلال آخر دقيقتين
            min_age = int(body.get("min_age", 0)) if isinstance(body, dict) else 0
            return self.send(200, {"started": start_refresh(min_age), "progress": collector.progress})
        if p == "/api/config":
            c = load_cfg()
            if "daily_target" in body:
                c["daily_target"] = max(1, int(body["daily_target"]))
            if "schedule" in body:
                c["schedule"] = [s.strip() for s in body["schedule"] if len(s.strip()) == 5]
            save_cfg(c)
            return self.send(200, c)
        self.send(404, {"error": "not found"})


if __name__ == "__main__":
    import sys
    if not os.path.exists(CFG):
        save_cfg(DEFAULT_CFG)
    threading.Thread(target=scheduler, daemon=True).start()
    con = collector.db(DB); empty = con.execute("SELECT COUNT(*) FROM runs").fetchone()[0] == 0; con.close()
    log("أول تشغيل: جاري إنشاء خط الأساس..." if empty else "تحديث فوري من موقع الهيئة عند فتح البرنامج...")
    start_refresh()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    url = f"http://localhost:{PORT}"
    log(f"اللوحة تعمل على {url}")
    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
