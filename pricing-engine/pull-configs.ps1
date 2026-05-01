$ErrorActionPreference = 'Stop'

$Remote = 'gmtech'
$RemoteDir = '/home/gmtech/priceTable-1/pricing-engine'
$Files = @('config.json', 'config-largeformat.json')
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Ts = Get-Date -Format 'yyyyMMdd-HHmmss'

Set-Location $ScriptDir
New-Item -ItemType Directory -Force -Path 'backups' | Out-Null

foreach ($f in $Files) {
    if (Test-Path $f) {
        Copy-Item $f "backups/$f.$Ts.bak"
    }
    & scp -q "${Remote}:$RemoteDir/$f" $f
    if ($LASTEXITCODE -ne 0) { throw "scp failed for $f" }
    $size = (Get-Item $f).Length
    "{0,-30} {1} bytes" -f $f, $size
}

Write-Output ''
Write-Output "Backed up previous to backups/*.$Ts.bak"
Write-Output "Run: git diff $($Files -join ' ')"
