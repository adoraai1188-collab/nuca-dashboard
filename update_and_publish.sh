#!/bin/sh
# يُشغَّل بواسطة مهمة Claude المجدولة: رصد من موقع الهيئة ثم نشر البيانات على الرابط
set -e
cd "$(dirname "$0")"
python3 -m pip install -q -r requirements.txt 2>/dev/null || pip install -q -r requirements.txt
git pull -q --rebase origin main || true
TZ=Africa/Cairo python3 cloud_run.py
git add state docs
if git diff --cached --quiet; then echo "لا تغييرات"; exit 0; fi
git -c user.name="nuca-bot" -c user.email="nuca-bot@users.noreply.github.com" commit -q -m "رصد $(TZ=Africa/Cairo date '+%Y-%m-%d %H:%M')"
for i in 1 2 3 4; do git push -q origin main && break; sleep $((i*2)); git pull -q --rebase origin main || true; done
