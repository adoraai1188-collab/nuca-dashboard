# -*- coding: utf-8 -*-
"""
تشغيل الرصد على GitHub Actions:
  - يسترجع الحالة السابقة من مجلد state/ (ملفات نصية تُحفظ في المستودع)
  - يجلب البيانات من موقع الهيئة ويحسب التخصيصات الجديدة
  - يحفظ الحالة الجديدة وينتج الموقع في مجلد site/ (index.html + data.json)
"""
import csv, json, os, sqlite3, sys, tempfile, time, shutil
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import collector, server  # noqa: E402

STATE = os.path.join(HERE, "state")
SITE = os.path.join(HERE, "docs")
INTERVAL_MIN = int(os.environ.get("INTERVAL_MIN", "60"))
DAILY_TARGET = int(os.environ.get("DAILY_TARGET", "1000"))
TABLES = {"zones": "zones.tsv", "plots": "plots.tsv", "runs": "runs.tsv"}


def load_state(con):
    for t, fn in TABLES.items():
        path = os.path.join(STATE, fn)
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8", newline="") as f:
            rows = list(csv.reader(f, delimiter="\t"))
        if len(rows) < 2:
            continue
        cols = rows[0]
        con.executemany(f"INSERT OR REPLACE INTO {t}({','.join(cols)}) VALUES({','.join('?' * len(cols))})",
                        [[None if v == "" else v for v in r] for r in rows[1:]])
    con.commit()


def save_state(con):
    os.makedirs(STATE, exist_ok=True)
    order = {"zones": "zone_id", "plots": "zone_id, block, plot", "runs": "id"}
    for t, fn in TABLES.items():
        cur = con.execute(f"SELECT * FROM {t} ORDER BY {order[t]}")
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
        if t == "runs":
            rows = rows[-2000:]
        with open(os.path.join(STATE, fn), "w", encoding="utf-8", newline="") as f:
            w = csv.writer(f, delimiter="\t", lineterminator="\n")
            w.writerow(cols)
            w.writerows(["" if v is None else v for v in r] for r in rows)


def main():
    tmp = tempfile.mkdtemp()
    db_path = os.path.join(tmp, "nuca.db")
    con = collector.db(db_path)
    load_state(con)
    con.close()

    ok = collector.run(db_path, print)
    con = collector.db(db_path)
    save_state(con)
    con.close()

    server.DB = db_path
    server.load_cfg = lambda: {"daily_target": DAILY_TARGET, "schedule": []}
    data = server.build_data(with_plots=False)
    data["progress"] = {"running": False}
    data["ts"] = int(time.time() * 1000)
    data["next_minutes"] = INTERVAL_MIN
    os.makedirs(SITE, exist_ok=True)
    with open(os.path.join(SITE, "data.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(SITE, "plots.csv"), "wb") as f:
        f.write(server.export_csv())
    open(os.path.join(SITE, ".nojekyll"), "w").close()
    tpl = open(os.path.join(HERE, "web", "index.html"), encoding="utf-8").read()
    html = tpl.replace("/*__STATIC_DATA__*/", "window.DATA_URL='data.json';", 1)
    with open(os.path.join(SITE, "index.html"), "w", encoding="utf-8") as f:
        f.write(html)
    shutil.rmtree(tmp, ignore_errors=True)
    if not ok:
        print("تحذير: فشل التحديث، تم نشر آخر بيانات محفوظة")


if __name__ == "__main__":
    main()
