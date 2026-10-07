<#
  OCR engine for the ELV project management system.
  Uses ONLY what ships with Windows 10/11:
    - Windows.Data.Pdf          -> rasterize PDF pages (no poppler needed)
    - Windows.Graphics.Imaging  -> decode images (jpg/png/bmp/tif/webp)
    - Windows.Media.Ocr         -> OCR (zh-Hans-CN)

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File ocr.ps1 `
        -Path <input file> -OutFile <result json> [-Scale 2.5] [-MaxPages 5] [-Lang zh-Hans-CN]

  Always writes a JSON result file (never relies on stdout, so encoding is safe).
  This file is intentionally ASCII-only: Windows PowerShell 5.1 reads .ps1 as ANSI
  without a BOM, so non-ASCII source would be mangled.
#>
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [double]$Scale = 4.0,
  [int]$MaxPages = 40,
  [string]$Lang = 'zh-Hans-CN'
)

$ErrorActionPreference = 'Stop'
$sw = [System.Diagnostics.Stopwatch]::StartNew()

function Write-Result ($obj) {
  $json = $obj | ConvertTo-Json -Depth 8 -Compress
  [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

  # ---- WinRT async helpers (PS 5.1 has no built-in await) ----
  $asTaskOp = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
  $asTaskAct = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
    })[0]

  function Await ($op, $type) {
    $t = $asTaskOp.MakeGenericMethod($type).Invoke($null, @($op))
    $t.Wait(-1) | Out-Null
    $t.Result
  }
  function AwaitAction ($op) {
    $t = $asTaskAct.Invoke($null, @($op))
    $t.Wait(-1) | Out-Null
  }

  # ---- load WinRT types ----
  [void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  [void][Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage, ContentType = WindowsRuntime]
  [void][Windows.Data.Pdf.PdfDocument, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Data.Pdf.PdfPageRenderOptions, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

  # ---- OCR engine ----
  $engine = $null
  try {
    $language = New-Object Windows.Globalization.Language -ArgumentList $Lang
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
  } catch { }
  if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if (-not $engine) {
    Write-Result @{ ok = $false; error = 'No OCR engine available. Install a Windows OCR language pack.' }
    exit 0
  }
  $engineTag = $engine.RecognizerLanguage.LanguageTag

  $fullPath = (Resolve-Path -LiteralPath $Path).Path
  $ext = [System.IO.Path]::GetExtension($fullPath).ToLowerInvariant()
  $lines = New-Object System.Collections.ArrayList
  $pageInfo = New-Object System.Collections.ArrayList
  $kind = ''

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($fullPath)) ([Windows.Storage.StorageFile])

  if ($ext -eq '.pdf') {
    $kind = 'pdf'
    $pdf = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
    $count = [Math]::Min($pdf.PageCount, $MaxPages)
    for ($i = 0; $i -lt $count; $i++) {
      $page = $pdf.GetPage($i)
      try {
        $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
        $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
        # render at a fixed high resolution so small print stays legible for OCR
        # (only width is set: height follows the page aspect ratio)
        $opts.DestinationWidth = [uint32][Math]::Round($page.Size.Width * $Scale)
        AwaitAction ($page.RenderToStreamAsync($stream, $opts))
        $stream.Seek(0)
        $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $res = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        $pageLines = 0
        foreach ($l in $res.Lines) {
          [void]$lines.Add($l.Text)
          $pageLines++
        }
        [void]$pageInfo.Add(@{ page = $i + 1; width = $bitmap.PixelWidth; height = $bitmap.PixelHeight; lines = $pageLines })
        $bitmap.Dispose()
      } finally { $page.Dispose() }
    }
  }
  elseif ($ext -in @('.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff', '.webp', '.gif')) {
    $kind = 'image'
    $stream = Await ($file.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    try {
      $res = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
      foreach ($l in $res.Lines) { [void]$lines.Add($l.Text) }
      [void]$pageInfo.Add(@{ page = 1; width = $bitmap.PixelWidth; height = $bitmap.PixelHeight; lines = $res.Lines.Count })
    } finally { $bitmap.Dispose() }
  }
  else {
    Write-Result @{ ok = $false; kind = 'unsupported'; error = ("Unsupported file type: " + $ext) }
    exit 0
  }

  $sw.Stop()
  Write-Result @{
    ok        = $true
    kind      = $kind
    engine    = $engineTag
    scale     = $Scale
    pages     = $pageInfo
    lines     = @($lines)
    text      = ($lines -join "`n")
    elapsedMs = $sw.ElapsedMilliseconds
  }
}
catch {
  Write-Result @{ ok = $false; error = ($_.Exception.Message); detail = ($_.ScriptStackTrace) }
}
