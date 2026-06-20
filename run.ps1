$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

New-Item -ItemType Directory -Force -Path "data", "dist", "logs" | Out-Null

$Bin = "dist\rng-native-windows-amd64.exe"
$Repo = if ($env:RNG_REPO) { $env:RNG_REPO } else { "github.com/alastorid/rng" }
$DataBranch = if ($env:RNG_DATA_BRANCH) { $env:RNG_DATA_BRANCH } else { "data" }
$DataWorktree = ".cache\data-branch"
$DataArchiveDir = Join-Path $DataWorktree "data\blockchair_bitcoin_addresses_latest"
$ExtractDir = "data\blockchair_bitcoin_addresses_latest_extracted"
$ReleaseTag = if ($env:RNG_RELEASE_TAG) { $env:RNG_RELEASE_TAG } else { "native-latest" }
$Backend = if ($env:RNG_BACKEND) { $env:RNG_BACKEND } else { "cpu" }

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
    New-Item -ItemType Directory -Force -Path ".cache" | Out-Null
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

if (-not (Test-Path $Bin)) {
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if ($gh) {
        gh release download $ReleaseTag --repo $Repo --pattern rng-native-windows-amd64.exe --dir dist --clobber
    }
    elseif ($env:GITHUB_TOKEN) {
        $release = Invoke-RestMethod `
            -Headers @{ Authorization = "Bearer $env:GITHUB_TOKEN" } `
            -Uri "https://api.github.com/repos/alastorid/rng/releases/tags/$ReleaseTag"
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

if ($Backend -eq "opencl") {
    [Console]::Error.WriteLine("This binary can list OpenCL devices, but the OpenCL key-generation backend is not implemented yet.")
    & ".\$Bin" --list-devices
    exit 1
}

$Dump = Ensure-Data
& ".\$Bin" --backend $Backend --address-dump $Dump --continuous --delay-ms 0 --progress-interval 5s
