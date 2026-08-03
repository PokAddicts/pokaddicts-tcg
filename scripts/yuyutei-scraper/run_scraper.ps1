# Wrapper invoked by the "PokAddicts Yuyu-tei Scraper" scheduled task -
# runs the actual scraper and keeps a rolling log of the last run's
# output, since a scheduled task has no visible console to read from.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
"=== Run started $timestamp ===" | Out-File -FilePath "run_log.txt" -Encoding utf8
python -u yuyutei_scraper.py *>> "run_log.txt"
"=== Run finished $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Out-File -FilePath "run_log.txt" -Append -Encoding utf8
