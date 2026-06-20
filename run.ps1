$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

New-Item -ItemType Directory -Force -Path "data", "dist", "logs" | Out-Null

$Bin = "dist\rng-native-windows-amd64.exe"
$Dump = "data\blockchair_bitcoin_addresses_latest.tsv.gz"

if (-not (Test-Path $Bin)) {
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if ($gh) {
        gh release download native-latest --repo github.com/alastorid/rng --pattern rng-native-windows-amd64.exe --dir dist --clobber
    }
    elseif ($env:GITHUB_TOKEN) {
        $release = Invoke-RestMethod `
            -Headers @{ Authorization = "Bearer $env:GITHUB_TOKEN" } `
            -Uri "https://api.github.com/repos/alastorid/rng/releases/tags/native-latest"
        $asset = $release.assets | Where-Object { $_.name -eq "rng-native-windows-amd64.exe" } | Select-Object -First 1
        if (-not $asset) {
            throw "Could not find rng-native-windows-amd64.exe in native-latest release."
        }
        Invoke-WebRequest `
            -Headers @{
                Authorization = "Bearer $env:GITHUB_TOKEN"
                Accept = "application/octet-stream"
            } `
            -Uri "https://api.github.com/repos/alastorid/rng/releases/assets/$($asset.id)" `
            -OutFile $Bin
    }
    else {
        throw "Cannot download private release asset. Install/authenticate GitHub CLI with 'gh auth login', or set GITHUB_TOKEN."
    }
}

if (-not (Test-Path $Dump)) {
    Invoke-WebRequest `
        -Uri "https://gz.blockchair.com/bitcoin/addresses/blockchair_bitcoin_addresses_latest.tsv.gz" `
        -OutFile $Dump
}

& ".\$Bin" --address-dump $Dump --continuous --delay-ms 0
