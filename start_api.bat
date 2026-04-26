@echo off
REM Start the Flask API server
echo Iniciando servidor de API para extração de imagens...
cd /d "%~dp0"
call .venv\Scripts\activate.bat
python api.py
pause
