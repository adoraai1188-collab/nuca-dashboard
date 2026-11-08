#!/bin/sh
# يُشغَّل بواسطة جلسة Claude المجدولة: رصد من موقع الهيئة ثم نشر البيانات على الرابط.
# تنبيه: يبدأ بمزامنة إجبارية مع origin/main (أي تعديلات محلية غير مرفوعة تُحذف).
set -e
cd "$(dirname "$0")"
python3 -m pip install -q -r requirements.txt 2>/dev/null || pip install -q -r requirements.txt
git fetch -q origin main
git reset -q --hard origin/main
TZ=Africa/Cairo python3 cloud_run.py
git add state docs
if git diff --cached --quiet; then echo "لا تغييرات"; exit 0; fi
git -c user.name="nuca-bot" -c user.email="nuca-bot@users.noreply.github.com" commit -q -m "رصد $(TZ=Africa/Cairo date '+%Y-%m-%d %H:%M')"
for i in 1 2 3 4; do
  if git push -q origin HEAD:main; then echo "تم النشر"; exit 0; fi
  sleep $((i*3))
  git fetch -q origin main
  git -c user.name="nuca-bot" -c user.email="nuca-bot@users.noreply.github.com" rebase -q -X theirs origin/main || { git rebase --abort; exit 1; }
done
echo "فشل الرفع"; exit 1
