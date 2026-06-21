$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

New-Item -ItemType Directory -Force -Path "data", "dist", "logs", ".cache" | Out-Null

$MinBalanceSpec = if ($env:RNG_MIN_BALANCE) { $env:RNG_MIN_BALANCE } else { "" }
$BloomLevel = if ($env:RNG_BLOOM_LEVEL) { $env:RNG_BLOOM_LEVEL } else { "8" }
$IslandLevel = if ($env:RNG_ISLAND_LEVEL) { $env:RNG_ISLAND_LEVEL } else { "4" }
$PassThroughArgs = @()
foreach ($arg in $args) {
    if ($arg -match "^[0-9]+(\.[0-9]+)?btc$") {
        $MinBalanceSpec = $arg
    }
    elseif ($arg -match "^bloom([0-9])$") {
        $BloomLevel = $Matches[1]
    }
    elseif ($arg -match "^island([0-9])$") {
        $IslandLevel = $Matches[1]
    }
    else {
        $PassThroughArgs += $arg
    }
}
$args = $PassThroughArgs

function Convert-BtcToSats([string] $Spec) {
    if (-not $Spec) {
        return [Int64]0
    }
    if ($Spec -notmatch "^([0-9]+)(?:\.([0-9]+))?btc$") {
        throw "Invalid balance filter '$Spec'. Use values like 1btc or 10btc."
    }

    $whole = [Int64]$Matches[1]
    $frac = if ($Matches[2]) { $Matches[2] } else { "" }
    if ($frac.Length -gt 8) {
        $frac = $frac.Substring(0, 8)
    }
    while ($frac.Length -lt 8) {
        $frac += "0"
    }

    return ($whole * 100000000) + [Int64]$frac
}

$MinBalanceSats = Convert-BtcToSats $MinBalanceSpec
if ($MinBalanceSpec -and $MinBalanceSats -le 0) {
    throw "Invalid balance filter '$MinBalanceSpec'. Use values like 1btc or 10btc."
}
if ($BloomLevel -match "^bloom([0-9])$") {
    $BloomLevel = $Matches[1]
}
if ($BloomLevel -notmatch "^[0-9]$") {
    throw "Invalid bloom level '$BloomLevel'. Use bloom0 through bloom9."
}
if ($IslandLevel -match "^island([0-9])$") {
    $IslandLevel = $Matches[1]
}
if ($IslandLevel -notmatch "^[0-9]$") {
    throw "Invalid island level '$IslandLevel'. Use island0 through island9."
}
$env:RNG_MIN_BALANCE_SATS = "$MinBalanceSats"
$env:RNG_BLOOM_LEVEL = "$BloomLevel"
$env:RNG_ISLAND_LEVEL = "$IslandLevel"

if ($MinBalanceSats -gt 0) {
    Write-Host "Using target balance >= $MinBalanceSpec ($MinBalanceSats sats), bloom$BloomLevel, island$IslandLevel"
}
else {
    Write-Host "Using all targets, bloom$BloomLevel, island$IslandLevel"
}

$Repo = if ($env:RNG_REPO) { $env:RNG_REPO } else { "github.com/alastorid/rng" }
$ApiRepo = $Repo -replace "^github.com/", ""
$DataBranch = if ($env:RNG_DATA_BRANCH) { $env:RNG_DATA_BRANCH } else { "data" }
$DataWorktree = ".cache\data-branch"
$DataArchiveDir = Join-Path $DataWorktree "data\blockchair_bitcoin_addresses_latest"
$ExtractDir = "data\blockchair_bitcoin_addresses_latest_extracted"
if ($env:RNG_TARGETS_FILE) {
    $TargetsFile = $env:RNG_TARGETS_FILE
}
elseif ($MinBalanceSats -gt 0) {
    $TargetsFile = "data\blockchair_bitcoin_addresses_latest_targets_min_$($MinBalanceSats)sats.txt"
}
else {
    $TargetsFile = "data\blockchair_bitcoin_addresses_latest_targets.txt"
}
$ReleaseTag = if ($env:RNG_RELEASE_TAG) { $env:RNG_RELEASE_TAG } else { "bitcrack-latest" }
$Backend = if ($env:RNG_BACKEND) { $env:RNG_BACKEND } else { "opencl" }
$Keyspace = if ($env:RNG_KEYSPACE) { $env:RNG_KEYSPACE } else { "" }
$ContinueFile = if ($env:RNG_CONTINUE_FILE) { $env:RNG_CONTINUE_FILE } else { "logs\bitcrack-$Backend.continue" }
$OutFile = if ($env:RNG_OUT_FILE) { $env:RNG_OUT_FILE } else { "logs\hits.txt" }

function Find-Dump {
    if (-not (Test-Path $ExtractDir)) {
        return $null
    }
    Get-ChildItem -Path $ExtractDir -Recurse -File |
        Where-Object { $_.Name -like "*.tsv" -or $_.Name -like "*.tsv.gz" -or $_.Name -like "*.csv" } |
        Sort-Object FullName |
        Select-Object -First 1
}

function Ensure-Data {
    $dump = Find-Dump
    if ($dump) {
        return $dump.FullName
    }

    Write-Host "Fetching dataset archive parts from git branch '$DataBranch'..."
    & git fetch origin "${DataBranch}:refs/remotes/origin/$DataBranch" --depth=1 2>&1 | ForEach-Object { Write-Host $_ }
    if ((Test-Path (Join-Path $DataWorktree ".git"))) {
        & git -C $DataWorktree reset --hard "origin/$DataBranch" 2>&1 | ForEach-Object { Write-Host $_ }
    }
    else {
        if (Test-Path $DataWorktree) {
            Remove-Item -Recurse -Force $DataWorktree
        }
        & git worktree add --force --detach $DataWorktree "origin/$DataBranch" 2>&1 | ForEach-Object { Write-Host $_ }
    }

    $firstPart = Join-Path $DataArchiveDir "blockchair_bitcoin_addresses_latest.7z.001"
    if (-not (Test-Path $firstPart)) {
        throw "Cannot find split 7z dataset at $DataArchiveDir"
    }

    $sevenZip = Get-Command 7z -ErrorAction SilentlyContinue
    if (-not $sevenZip) {
        $sevenZip = Get-Command 7zz -ErrorAction SilentlyContinue
    }
    if (-not $sevenZip) {
        throw "7z is required to extract the dataset. Install 7-Zip and make 7z.exe available in PATH."
    }

    Write-Host "Extracting dataset locally..."
    if (Test-Path $ExtractDir) {
        Remove-Item -Recurse -Force $ExtractDir
    }
    New-Item -ItemType Directory -Force -Path $ExtractDir | Out-Null
    & $sevenZip.Source x $firstPart "-o$ExtractDir" -y 2>&1 | ForEach-Object { Write-Host $_ }

    $dump = Find-Dump
    if (-not $dump) {
        throw "Dataset extracted, but no .tsv/.tsv.gz/.csv file was found in $ExtractDir"
    }
    return $dump.FullName
}

function Ensure-Targets([string] $DumpPath) {
    if ((Test-Path $TargetsFile) -and ((Get-Item $TargetsFile).Length -gt 0) -and ((Get-Item $TargetsFile).LastWriteTimeUtc -gt (Get-Item $DumpPath).LastWriteTimeUtc)) {
        return $TargetsFile
    }

    Write-Host "Preparing BitCrack target address list..."
    if ($MinBalanceSats -gt 0) {
        Write-Host "Filtering addresses with balance >= $MinBalanceSpec ($MinBalanceSats sats)..."
    }
    $targetDir = Split-Path -Parent $TargetsFile
    if ($targetDir) {
        New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    }

    $tmp = "$TargetsFile.tmp"
    if (Test-Path $tmp) {
        Remove-Item -Force $tmp
    }

    if ($DumpPath.EndsWith(".gz")) {
        $stream = [System.IO.File]::OpenRead($DumpPath)
        $gzip = [System.IO.Compression.GZipStream]::new($stream, [System.IO.Compression.CompressionMode]::Decompress)
        $reader = [System.IO.StreamReader]::new($gzip)
    }
    else {
        $reader = [System.IO.StreamReader]::new($DumpPath)
        $stream = $null
        $gzip = $null
    }

    try {
        $writer = [System.IO.StreamWriter]::new($tmp, $false)
        try {
            $balanceColumn = 1
            $lineNumber = 0
            while (($line = $reader.ReadLine()) -ne $null) {
                $lineNumber++
                $columns = $line -split "[,`t]"
                if ($columns.Count -eq 0) {
                    continue
                }

                $first = $columns[0].Trim()
                if ($lineNumber -eq 1 -and $first.ToLowerInvariant() -eq "address") {
                    for ($i = 0; $i -lt $columns.Count; $i++) {
                        $name = $columns[$i].Trim().ToLowerInvariant()
                        if ($name -eq "balance" -or $name -eq "balance_satoshi" -or $name -eq "balance_satoshis") {
                            $balanceColumn = $i
                        }
                    }
                    continue
                }

                if ($MinBalanceSats -gt 0) {
                    $balance = [Int64]0
                    if ($columns.Count -gt $balanceColumn) {
                        [void][Int64]::TryParse($columns[$balanceColumn].Trim(), [ref]$balance)
                    }
                    if ($balance -lt $MinBalanceSats) {
                        continue
                    }
                }

                if ($first -match "^[13][123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{20,}$" -or $first -match "^bc1[023456789acdefghjklmnpqrstuvwxyz]{20,}$") {
                    $writer.WriteLine($first)
                }
            }
        }
        finally {
            $writer.Dispose()
        }
    }
    finally {
        $reader.Dispose()
        if ($gzip) { $gzip.Dispose() }
        if ($stream) { $stream.Dispose() }
    }

    Move-Item -Force $tmp $TargetsFile
    if ((Get-Item $TargetsFile).Length -eq 0) {
        throw "No supported Base58 addresses were parsed from $DumpPath"
    }
    return $TargetsFile
}

function Get-AssetVersion([string] $Asset) {
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if ($gh) {
        $version = gh release view $ReleaseTag --repo $Repo --json assets --jq ".assets[] | select(.name == `"$Asset`") | `"\(.id):\(.updatedAt)`"" 2>$null
        if ($LASTEXITCODE -eq 0 -and $version) {
            return $version
        }
    }

    if ($env:GITHUB_TOKEN) {
        try {
            $release = Invoke-RestMethod `
                -Headers @{ Authorization = "Bearer $env:GITHUB_TOKEN" } `
                -Uri "https://api.github.com/repos/$ApiRepo/releases/tags/$ReleaseTag"
            $found = $release.assets | Where-Object { $_.name -eq $Asset } | Select-Object -First 1
            if ($found) {
                return "$($found.id):$($found.updated_at)"
            }
        }
        catch {
            return $null
        }
    }

    return $null
}

function Download-Asset([string] $Asset, [string] $OutPath) {
    $outDir = Split-Path -Parent $OutPath
    if ($outDir) {
        New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    }

    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if ($gh) {
        $assets = gh release view $ReleaseTag --repo $Repo --json assets --jq ".assets[].name"
        if ($LASTEXITCODE -ne 0) {
            throw "Could not inspect release '$ReleaseTag' in $Repo."
        }
        if ($Asset -notin @($assets)) {
            throw "Release '$ReleaseTag' does not contain '$Asset'. Available assets: $($assets -join ', ')"
        }
        gh release download $ReleaseTag --repo $Repo --pattern $Asset --dir dist --clobber
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to download '$Asset' from release '$ReleaseTag'."
        }
        Move-Item -Force (Join-Path "dist" $Asset) $OutPath
    }
    elseif ($env:GITHUB_TOKEN) {
        $release = Invoke-RestMethod `
            -Headers @{ Authorization = "Bearer $env:GITHUB_TOKEN" } `
            -Uri "https://api.github.com/repos/$ApiRepo/releases/tags/$ReleaseTag"
        $found = $release.assets | Where-Object { $_.name -eq $Asset } | Select-Object -First 1
        if (-not $found) {
            throw "Could not find $Asset in release $ReleaseTag."
        }
        Invoke-WebRequest `
            -Headers @{
                Authorization = "Bearer $env:GITHUB_TOKEN"
                Accept = "application/octet-stream"
            } `
            -Uri "https://api.github.com/repos/$ApiRepo/releases/assets/$($found.id)" `
            -OutFile $OutPath
    }
    else {
        throw "Cannot download private release asset. Install/authenticate GitHub CLI with 'gh auth login', or set GITHUB_TOKEN."
    }
}

function Ensure-LatestAsset([string] $Asset, [string] $OutPath) {
    $marker = Join-Path "dist" ".$Asset.version"
    $remoteVersion = Get-AssetVersion $Asset

    if ($remoteVersion) {
        $localVersion = if (Test-Path $marker) { Get-Content -Raw $marker } else { "" }
        $localVersion = $localVersion.Trim()

        if ((Test-Path $OutPath) -and $localVersion -eq $remoteVersion) {
            return
        }

        if (Test-Path $OutPath) {
            Write-Host "Updating $Asset from release '$ReleaseTag'..."
        }
        else {
            Write-Host "Downloading $Asset from release '$ReleaseTag'..."
        }

        try {
            Download-Asset $Asset $OutPath
            Set-Content -Path $marker -Value $remoteVersion
        }
        catch {
            if (Test-Path $OutPath) {
                Write-Host "Could not update $Asset; using existing $OutPath."
            }
            else {
                throw "Could not download $Asset and no local binary exists at $OutPath."
            }
        }
        return
    }

    if (-not (Test-Path $OutPath)) {
        Write-Host "Downloading $Asset from release '$ReleaseTag'..."
        Download-Asset $Asset $OutPath
    }
    else {
        Write-Host "Could not check release '$ReleaseTag' for updates; using existing $OutPath."
    }
}

switch ($Backend.ToLowerInvariant()) {
    "cuda" {
        $Bin = if ($env:RNG_BIN) { $env:RNG_BIN } else { "dist\cuBitCrack.exe" }
        $Asset = "cuBitCrack-windows-amd64.exe"
    }
    "opencl" {
        $Bin = if ($env:RNG_BIN) { $env:RNG_BIN } else { "dist\clBitCrack.exe" }
        $Asset = "clBitCrack-windows-amd64.exe"
    }
    "cl" {
        $Bin = if ($env:RNG_BIN) { $env:RNG_BIN } else { "dist\clBitCrack.exe" }
        $Asset = "clBitCrack-windows-amd64.exe"
    }
    default {
        throw "Unsupported RNG_BACKEND '$Backend'. Use cuda or opencl."
    }
}

if ($env:RNG_BIN) {
    if (-not (Test-Path $Bin)) {
        throw "RNG_BIN points to '$Bin', but it does not exist."
    }
}
else {
    Ensure-LatestAsset $Asset $Bin
}

$Dump = Ensure-Data
$Targets = if ($env:RNG_TARGETS_FILE) { $env:RNG_TARGETS_FILE } else { $Dump }

$BitCrackArgs = @("--compressed", "--continue", $ContinueFile, "-i", $Targets, "-o", $OutFile)
if ($Keyspace) {
    $BitCrackArgs += @("--keyspace", $Keyspace)
}
if ($env:RNG_DEVICE) {
    $BitCrackArgs += @("--device", $env:RNG_DEVICE)
}
if ($env:RNG_BLOCKS) {
    $BitCrackArgs += @("--blocks", $env:RNG_BLOCKS)
}
if ($env:RNG_THREADS) {
    $BitCrackArgs += @("--threads", $env:RNG_THREADS)
}
if ($env:RNG_POINTS) {
    $BitCrackArgs += @("--points", $env:RNG_POINTS)
}
$BitCrackArgs += $args

& $Bin @BitCrackArgs
