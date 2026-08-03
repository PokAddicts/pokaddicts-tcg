@echo off
cd /d "%~dp0scripts\yuyutei-scraper"
python -u yuyutei_scraper.py
echo.
echo Done - press any key to close this window.
pause >nul
