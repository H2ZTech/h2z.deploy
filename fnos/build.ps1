# Build the fpk from Windows by running build.sh inside WSL (the Windows fnpack loses the exec bit of cmd/*).
# Usage: powershell -File fnos\build.ps1   (needs WSL with a Linux distro, and internet for the first fnpack download)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$wslPath = (wsl wslpath -a ($here -replace '\\', '/')).Trim()
wsl bash "$wslPath/build.sh"
if ($LASTEXITCODE -ne 0) { throw "build failed" }
Get-Item (Join-Path $here 'dist\com.h2ztech.security.fpk') | Select-Object FullName, Length
