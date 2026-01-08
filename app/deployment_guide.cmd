@echo off
echo Ionia Ingestion API - Deployment Guide
echo =====================================
echo.
echo 1) Create and activate a Python virtual environment
echo    python -m venv .venv
echo    .venv\Scripts\activate
echo.
echo 2) Install dependencies
echo    pip install fastapi uvicorn
echo    pip install google-api-python-client google-auth
echo.
echo 3) Configure environment variables
echo    set IONIA_VALIDATION_KEYS={"IONIA-KC-2026-8FJ3A":"KC"}
echo    set IONIA_API_KEYS={"kc_2026_secret_x9f3":"KC"}
echo    set IONIA_GOOGLE_SHEET_ID=your_sheet_id
echo    set IONIA_GOOGLE_CREDENTIALS_JSON={"type":"service_account",...}
echo    rem or set IONIA_GOOGLE_CREDENTIALS_FILE=C:\path\to\service_account.json
echo    set IONIA_SHEETS_GAMES_RANGE=games!A:Z
echo    set IONIA_SHEETS_STREAMS_RANGE=streams!A:Z
echo.
echo 4) Run the API
echo    uvicorn app.main:app --host 0.0.0.0 --port 8000
echo.
echo Notes:
echo - /activate does not require Bearer auth.
echo - All other endpoints require: Authorization: Bearer ^<token^>
echo - Google Sheets writes are optional; missing vars disable writes.
echo.
echo This file is informational only; commands are printed but not executed.
