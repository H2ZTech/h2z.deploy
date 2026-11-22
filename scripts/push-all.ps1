# 把各仓库本地提交推到 GitHub（H2ZTech）：对每个仓库先 git pull --rebase，再 git push origin main。
#
#   powershell -ExecutionPolicy Bypass -File scripts\push-all.ps1            # 全部
#   powershell -ExecutionPolicy Bypass -File scripts\push-all.ps1 -Only h2z.ioc,h2z.backend
#   powershell -ExecutionPolicy Bypass -File scripts\push-all.ps1 -DryRun    # 只看每个仓库领先几个提交，不推
#
# 平时只推送：CI 默认只出 amd64 镜像、不跑界面层测试，省 GitHub Actions 分钟（组织每月 2000 分钟）。
# 要“全量”的那几样用开关触发（需要装 gh 并登录：gh auth login；推送完成后才触发，推送失败的仓库不触发）：
#   -Arm64    h2z.ioc 前端镜像 + h2z.recorder 镜像加构建 arm64（RK3588 等），出的镜像带 amd64 + arm64
#   -Ui       h2z.ioc 跑界面层 FM 测试（headless Chrome，约 85 分钟，别经常跑）
#   -Release  h2z.security 发布在线更新（签名清单）。要等前面各仓库的镜像在 Actions 里构建完再跑，
#             所以通常单独跑：scripts\push-all.ps1 -Only h2z.security -Release
#   例：powershell -ExecutionPolicy Bypass -File scripts\push-all.ps1 -Arm64          # 推送并出 arm64
#       powershell -ExecutionPolicy Bypass -File scripts\push-all.ps1 -Only h2z.ioc -Ui   # 只触发界面层（没有要推的也会触发）
#
# 顺序：h2z.backend → h2z.ioc → h2z.recorder → h2z.ai.server → h2z.security（最后推 security：
# 它的发布流水线要等前面几个仓库的镜像发完）。仓库默认在本仓库的上一级目录（C:\project\），可用 -Root 改。
# 工作区有没提交的改动时跳过该仓库（不会替你提交）。
# h2z.ioc 的 docs/FEATURES.md 是生成的，rebase 冲突时自动用 tools/fm-sync.mjs 重新生成后继续。
param(
  [string]$Root = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
  [string[]]$Only = @(),
  [switch]$DryRun,
  [switch]$Arm64,
  [switch]$Ui,
  [switch]$Release
)

$repos = @('h2z.backend', 'h2z.ioc', 'h2z.recorder', 'h2z.ai.server', 'h2z.security')
if ($Only.Count -gt 0) { $repos = $repos | Where-Object { $Only -contains $_ } }
$failed = @()

function Run([string]$dir, [string[]]$gitArgs) {
  & git -C $dir @gitArgs
  return $LASTEXITCODE
}

foreach ($name in $repos) {
  $dir = Join-Path $Root $name
  Write-Host "`n=== $name ($dir)" -ForegroundColor Cyan
  if (-not (Test-Path (Join-Path $dir '.git'))) { Write-Host '  没找到这个仓库，跳过' -ForegroundColor Yellow; continue }

  $dirty = (& git -C $dir status --porcelain --untracked-files=no)
  if ($dirty) { Write-Host '  有没提交的改动，跳过（先提交或暂存）：' -ForegroundColor Yellow; $dirty | ForEach-Object { Write-Host "    $_" }; $failed += $name; continue }

  if ((Run $dir @('fetch', 'origin')) -ne 0) { Write-Host '  fetch 失败' -ForegroundColor Red; $failed += $name; continue }
  $ahead = [int](& git -C $dir rev-list --count 'origin/main..HEAD')
  $behind = [int](& git -C $dir rev-list --count 'HEAD..origin/main')
  Write-Host "  领先 $ahead 个提交，落后 $behind 个"
  if ($ahead -eq 0) { Write-Host '  没有要推的' -ForegroundColor Green; continue }
  if ($DryRun) { & git -C $dir log --oneline 'origin/main..HEAD'; continue }

  if ($behind -gt 0) {
    if ((Run $dir @('pull', '--rebase', 'origin', 'main')) -ne 0) {
      $fixed = $false
      if ($name -eq 'h2z.ioc') {
        # FEATURES.md 是生成的：冲突就取我方、重新生成、继续
        for ($i = 0; $i -lt 20; $i++) {
          $conf = (& git -C $dir diff --name-only --diff-filter=U)
          if (-not $conf) { break }
          if (($conf | Where-Object { $_ -ne 'docs/FEATURES.md' })) { break }
          & git -C $dir checkout --ours docs/FEATURES.md
          & node (Join-Path $dir 'tools/fm-sync.mjs')
          & git -C $dir add docs/FEATURES.md
          $env:GIT_EDITOR = 'true'
          & git -C $dir rebase --continue
          if ($LASTEXITCODE -eq 0) { $fixed = $true; break }
        }
      }
      if (-not $fixed) {
        Write-Host '  rebase 有冲突，已停在冲突处：请手动解决后 git rebase --continue，再重跑本脚本；或 git rebase --abort 放弃' -ForegroundColor Red
        $failed += $name; continue
      }
    }
  }

  if ((Run $dir @('push', 'origin', 'main')) -ne 0) { Write-Host '  push 失败' -ForegroundColor Red; $failed += $name; continue }
  Write-Host '  已推送' -ForegroundColor Green
}

# 手动触发的“全量”工作流：只对这次处理的、没出问题的仓库触发
function Dispatch([string]$name, [string]$workflow, [string[]]$fields) {
  if ($repos -notcontains $name) { return }
  if ($failed -contains $name) { Write-Host "  $name 有问题，不触发 $workflow" -ForegroundColor Yellow; return }
  $ghArgs = @('workflow', 'run', $workflow, '-R', "H2ZTech/$name", '--ref', 'main')
  foreach ($f in $fields) { $ghArgs += @('-f', $f) }
  if ($DryRun) { Write-Host "  [DryRun] gh $($ghArgs -join ' ')"; return }
  & gh @ghArgs
  if ($LASTEXITCODE -eq 0) { Write-Host "  已触发 $name / $workflow（$($fields -join ' ')）" -ForegroundColor Green }
  else { Write-Host "  触发 $name / $workflow 失败（gh 没登录？）" -ForegroundColor Red; $script:failed += $name }
}
if ($Arm64 -or $Ui -or $Release) {
  Write-Host "`n=== 触发手动工作流" -ForegroundColor Cyan
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Host '  没装 gh（https://cli.github.com），或者去 GitHub 网页：Actions → 选工作流 → Run workflow' -ForegroundColor Red
    $failed += 'gh'
  } else {
    if ($Arm64) { Dispatch 'h2z.ioc' 'docker.yml' @('arm64=true'); Dispatch 'h2z.recorder' 'ci.yml' @('arm64=true') }
    if ($Ui) { Dispatch 'h2z.ioc' 'fm.yml' @('ui=true') }
    if ($Release) { Dispatch 'h2z.security' 'release.yml' @() }
  }
}

if ($failed.Count -gt 0) { Write-Host "`n有问题的仓库：$($failed -join ', ')" -ForegroundColor Red; exit 1 }
Write-Host "`n全部完成" -ForegroundColor Green
