# -*- coding: utf-8 -*-
"""
جامع بيانات تخصيصات المرحلة الحادية عشر من بوابة أراضي هيئة المجتمعات العمرانية الجديدة
المصدر: https://lands.nuca.gov.eg  (البيانات المعروضة للجمهور فقط)
"""
import re, sqlite3, time, json, threading
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
from bs4 import BeautifulSoup

BASE = "https://lands.nuca.gov.eg/ar/"
PHASE_KEYWORD = "الحادية عشر"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) NUCA-Dashboard"
WORKERS = 6            # عدد الاتصالات المتوازية (قيمة منخفضة احتراماً للموقع)
TIMEOUT = 60
RETRIES = 3

_lock = threading.Lock()
progress = {"running": False, "done": 0, "total": 0, "message": "", "error": None}


def _session():
    s = requests.Session()
    s.headers["User-Agent"] = UA
    return s


def _get(s, url, data=None):
    last = None
    for i in range(RETRIES):
        try:
            r = s.post(url, data=data, timeout=TIMEOUT) if data else s.get(url, timeout=TIMEOUT)
            r.raise_for_status()
            return BeautifulSoup(r.text, "html.parser")
        except Exception as e:  # noqa
            last = e
            time.sleep(2 * (i + 1))
    raise last


def _clean(t):
    return " ".join(t.split())


def _num(t):
    try:
        return float(t.replace(",", ""))
    except Exception:
        return 0.0


# ---------------------------------------------------------------- discovery
def discover_zones(s=None):
    """يكتشف كل المدن ← المشروعات ← المناطق التابعة للمرحلة الحادية عشر"""
    s = s or _session()
    home = _get(s, BASE + "Home.aspx")
    cities = {}
    for a in home.find_all("a", href=re.compile(r"ViewCity\.aspx\?ID=\d+")):
        n = _clean(a.get_text())
        if n:
            cities[re.search(r"ID=(\d+)", a["href"]).group(1)] = n
    zones = []
    for cid, cname in cities.items():
        cp = _get(s, BASE + f"ViewCity.aspx?ID={cid}")
        pids = []
        for a in cp.find_all("a", href=re.compile(r"ViewProject\.aspx\?ID=\d+")):
            box = a.find_parent(["div", "td", "li"])
            if box and PHASE_KEYWORD in box.get_text():
                pid = re.search(r"ID=(\d+)", a["href"]).group(1)
                if pid not in pids:
                    pids.append(pid)
        for pid in pids:
            pp = _get(s, BASE + f"ViewProject.aspx?ID={pid}")
            txt = _clean(pp.get_text())
            i = txt.find("دخول")
            title = txt[i + 5:i + 200].split(" من فضلك")[0].strip()
            if PHASE_KEYWORD not in title:
                continue
            region = title.replace("المرحلة الحادية عشر", "").strip(" -–")
            region = re.sub(r"\s*-\s*[^-]*$", "", region).strip() or region  # حذف اسم المدينة في النهاية
            for z in pp.find_all("a", href=re.compile(r"ViewZone\.aspx\?ID=\d+")):
                zid = re.search(r"ID=(\d+)", z["href"]).group(1)
                if not any(x["zone_id"] == zid for x in zones):
                    zones.append(dict(city_id=cid, city=cname, project_id=pid,
                                      project=title, region=region, zone_id=zid))
    return zones


# ---------------------------------------------------------------- zone scraping
def _hidden(soup):
    return {i["name"]: i.get("value", "") for i in soup.select("input[type=hidden]") if i.get("name")}


def _rows(soup):
    out = []
    tb = soup.find("table", id=re.compile("grdPlots")) or soup.find("table")
    if not tb:
        return out
    for tr in tb.find_all("tr"):
        st = tr.find("span", id=re.compile("lblPlotStatus"))
        if not st:
            continue
        td = [_clean(c.get_text()) for c in tr.find_all("td", recursive=False)]
        if len(td) < 11:
            continue
        out.append(dict(block=td[0], plot=td[1], area=_num(td[2]), base_price=_num(td[3]),
                        corner=_num(td[4]), garden=_num(td[5]), sea=_num(td[6]),
                        meter_price=_num(td[7]), total_price=_num(td[8]),
                        down_payment=_num(td[9]), status=_clean(st.get_text())))
    return out


def _pages(soup):
    return {int(m) for m in re.findall(r"Page\$(\d+)", str(soup))}


def _walk(s, url, soup, mode):
    """يمر على كل صفحات الجدول للوضع الحالي (متاح/محجوز)"""
    rows = _rows(soup)
    page = 1
    while (page + 1) in _pages(soup):
        page += 1
        d = _hidden(soup)
        d.update({"__EVENTTARGET": "ctl00$MainContent$grdPlots", "__EVENTARGUMENT": f"Page${page}",
                  "ctl00$MainContent$PlotType": mode, "ctl00$MainContent$txtPlotNumber": ""})
        soup = _get(s, url, d)
        rows += _rows(soup)
    return rows


def scrape_zone(zone):
    s = _session()
    url = BASE + f"ViewZone.aspx?ID={zone['zone_id']}"
    soup = _get(s, url)
    meter_egp = re.search(r"سعر المتر بالجنيه المصري:\s*([\d,\.]+)", soup.get_text())
    available = _walk(s, url, soup, "rdShowAvailable")
    d = _hidden(soup)
    d.update({"__EVENTTARGET": "ctl00$MainContent$rdShowBooked", "__EVENTARGUMENT": "",
              "ctl00$MainContent$PlotType": "rdShowBooked", "ctl00$MainContent$txtPlotNumber": ""})
    bsoup = _get(s, url, d)
    booked = _walk(s, url, bsoup, "rdShowBooked")
    for r in available:
        r["booked"] = 0
    for r in booked:
        r["booked"] = 1
    return dict(zone=zone, meter_egp=_num(meter_egp.group(1)) if meter_egp else 0, plots=available + booked)


# ---------------------------------------------------------------- database
SCHEMA = """
CREATE TABLE IF NOT EXISTS zones(zone_id TEXT PRIMARY KEY, city_id TEXT, city TEXT, project_id TEXT,
  project TEXT, region TEXT, meter_egp REAL);
CREATE TABLE IF NOT EXISTS plots(zone_id TEXT, block TEXT, plot TEXT, area REAL, base_price REAL,
  corner REAL, garden REAL, sea REAL, meter_price REAL, total_price REAL, down_payment REAL,
  booked INTEGER, status TEXT, first_seen TEXT, booked_at TEXT, baseline INTEGER DEFAULT 0,
  last_seen TEXT, PRIMARY KEY(zone_id, block, plot));
CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY AUTOINCREMENT, started TEXT, finished TEXT,
  total INTEGER, booked INTEGER, new_booked INTEGER, released INTEGER, ok INTEGER, note TEXT);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, zone_id TEXT,
  block TEXT, plot TEXT, kind TEXT);
"""


def db(path):
    con = sqlite3.connect(path, check_same_thread=False)
    con.executescript(SCHEMA)
    return con


def run(db_path, log=print):
    """تشغيل دورة تحديث كاملة وتخزين الفروقات"""
    with _lock:
        if progress["running"]:
            return False
        progress.update(running=True, done=0, total=0, message="اكتشاف المناطق...", error=None)
    started = datetime.now().isoformat(timespec="seconds")
    con = db(db_path)
    try:
        zones = discover_zones()
        if not zones:
            raise RuntimeError("لم يتم العثور على مناطق للمرحلة الحادية عشر")
        progress.update(total=len(zones), message="جلب بيانات القطع...")
        results, failed = [], []
        with ThreadPoolExecutor(WORKERS) as ex:
            futs = {ex.submit(scrape_zone, z): z for z in zones}
            for f in as_completed(futs):
                z = futs[f]
                try:
                    results.append(f.result())
                except Exception as e:  # noqa
                    failed.append(z["zone_id"]); log(f"فشل المنطقة {z['zone_id']}: {e}")
                progress["done"] += 1
        now = datetime.now().isoformat(timespec="seconds")
        first_run = con.execute("SELECT COUNT(*) FROM plots").fetchone()[0] == 0
        new_b = released = 0
        cur = con.cursor()
        for res in results:
            z = res["zone"]
            cur.execute("INSERT OR REPLACE INTO zones VALUES(?,?,?,?,?,?,?)",
                        (z["zone_id"], z["city_id"], z["city"], z["project_id"], z["project"], z["region"], res["meter_egp"]))
            for p in res["plots"]:
                key = (z["zone_id"], p["block"], p["plot"])
                old = cur.execute("SELECT booked FROM plots WHERE zone_id=? AND block=? AND plot=?", key).fetchone()
                vals = (p["area"], p["base_price"], p["corner"], p["garden"], p["sea"], p["meter_price"],
                        p["total_price"], p["down_payment"], p["booked"], p["status"], now)
                if old is None:
                    is_base = 1 if (first_run or not p["booked"]) else 0
                    booked_at = None
                    if p["booked"]:
                        booked_at = now
                        if not first_run:
                            new_b += 1
                            cur.execute("INSERT INTO events(ts,zone_id,block,plot,kind) VALUES(?,?,?,?,'booked')", (now,) + key)
                    cur.execute("""INSERT INTO plots(zone_id,block,plot,area,base_price,corner,garden,sea,meter_price,
                        total_price,down_payment,booked,status,last_seen,first_seen,booked_at,baseline)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", key + vals + (now, booked_at, 1 if first_run else 0))
                else:
                    cur.execute("""UPDATE plots SET area=?,base_price=?,corner=?,garden=?,sea=?,meter_price=?,
                        total_price=?,down_payment=?,booked=?,status=?,last_seen=? WHERE zone_id=? AND block=? AND plot=?""",
                                vals + key)
                    if p["booked"] and not old[0]:
                        new_b += 1
                        cur.execute("UPDATE plots SET booked_at=?, baseline=0 WHERE zone_id=? AND block=? AND plot=?", (now,) + key)
                        cur.execute("INSERT INTO events(ts,zone_id,block,plot,kind) VALUES(?,?,?,?,'booked')", (now,) + key)
                    elif not p["booked"] and old[0]:
                        released += 1
                        cur.execute("UPDATE plots SET booked_at=NULL WHERE zone_id=? AND block=? AND plot=?", key)
                        cur.execute("INSERT INTO events(ts,zone_id,block,plot,kind) VALUES(?,?,?,?,'released')", (now,) + key)
        tot = sum(len(r["plots"]) for r in results)
        bk = sum(p["booked"] for r in results for p in r["plots"])
        note = "تشغيل أولي (خط الأساس)" if first_run else ""
        if failed:
            note += f" مناطق فشلت: {','.join(failed)}"
        cur.execute("INSERT INTO runs(started,finished,total,booked,new_booked,released,ok,note) VALUES(?,?,?,?,?,?,?,?)",
                    (started, now, tot, bk, new_b, released, 0 if failed else 1, note.strip()))
        con.commit()
        progress["message"] = f"تم: {tot} قطعة، {bk} مخصصة، {new_b} تخصيص جديد"
        log(progress["message"])
        return True
    except Exception as e:  # noqa
        progress["error"] = str(e); log(f"خطأ: {e}")
        return False
    finally:
        con.close()
        progress["running"] = False


if __name__ == "__main__":
    import sys
    run(sys.argv[1] if len(sys.argv) > 1 else "nuca.db")
