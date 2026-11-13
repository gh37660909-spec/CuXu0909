param(
  [Parameter(Mandatory = $true)][string]$Path
)

# OCR with line bounding boxes, returned as JSON.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($operation, $resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  $task.Result
}

$full = (Resolve-Path -LiteralPath $Path).Path
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) {
  [Console]::Error.WriteLine('系统没有可用的 OCR 语言包')
  exit 1
}
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

$lines = @()
foreach ($line in $result.Lines) {
  $minX = [double]::MaxValue; $minY = [double]::MaxValue
  $maxX = 0.0; $maxY = 0.0
  foreach ($word in $line.Words) {
    $rect = $word.BoundingRect
    if ($rect.X -lt $minX) { $minX = $rect.X }
    if ($rect.Y -lt $minY) { $minY = $rect.Y }
    if (($rect.X + $rect.Width) -gt $maxX) { $maxX = $rect.X + $rect.Width }
    if (($rect.Y + $rect.Height) -gt $maxY) { $maxY = $rect.Y + $rect.Height }
  }
  $lines += [ordered]@{
    text = $line.Text
    x = [math]::Round($minX, 1)
    y = [math]::Round($minY, 1)
    w = [math]::Round($maxX - $minX, 1)
    h = [math]::Round($maxY - $minY, 1)
  }
}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
ConvertTo-Json -Compress -InputObject @{ lines = $lines }
