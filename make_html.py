# -*- coding: utf-8 -*-
"""
تحديث البيانات من موقع الهيئة ثم إنتاج ملف «لوحة_التخصيصات.html» وفتحه — بدون الحاجة لترك خادم يعمل.
python make_html.py            تحديث ثم إنتاج الملف
python make_html.py --no-update  إنتاج الملف من آخر بيانات محفوظة فقط
"""
import os, sys, webbrowser
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import server, collector  # noqa: E402

if "--no-update" not in sys.argv:
    server.log("جاري التحديث من موقع الهيئة...")
    collector.run(server.DB, server.log)
path = server.write_html()
server.log("تم إنتاج الملف: " + path)
if "--no-open" not in sys.argv:
    webbrowser.open("file:///" + path.replace("\\", "/"))
