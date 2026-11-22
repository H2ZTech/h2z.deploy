param([string]$Frontend = 'C:\project\h2z.ioc')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
docker build -f "$Frontend/Dockerfile" -t h2z-security/ioc-web:0.1.0 $Frontend
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' }
