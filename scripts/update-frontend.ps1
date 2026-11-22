param([string]$Frontend = 'C:\project\h2z.ioc')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
docker build -f "$Frontend/Dockerfile" -t h2z-security/ioc-web:0.1.0 $Frontend
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' }
$containerId = docker create h2z-security/ioc-web:0.1.0
try {
    docker cp "${containerId}:/usr/share/nginx/html/ioc/." "$root/frontend/html/ioc/"
    if ($LASTEXITCODE -ne 0) { throw 'Frontend export failed' }
} finally { docker rm $containerId | Out-Null }
$revision = git -C $Frontend rev-parse HEAD
@{ source = 'h2z.ioc'; revision = $revision; exportedAt = (Get-Date).ToUniversalTime().ToString('o') } |
    ConvertTo-Json | Set-Content -Encoding utf8NoBOM "$root/frontend/provenance.json"
