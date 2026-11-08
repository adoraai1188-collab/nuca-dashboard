@echo off
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul || (echo Python غير مثبت. حمّله من https://www.python.org/downloads/ وفعّل خيار "Add Python to PATH" & pause & exit /b)
python -m pip install -q -r requirements.txt
python make_html.py
