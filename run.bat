@echo off
cd /d "%~dp0"
echo Устанавливаю зависимости...
pip install -r requirements.txt
echo.
echo Запуск сервера (Ctrl+C для остановки)...
python main.py
pause
