param(
  [Parameter(Mandatory = $true)][string]$Path
)

# Windows built-in OCR. Prints recognized text, exits 1 when unavailable.
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path)) {
  [Console]::Error.WriteLine("图片不存在：$Path")
  exit 1
}

$full = (Resolve-Path -LiteralPath $Path).Path

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]

  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

  function Await($operation, $resultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
    $task = $asTask.Invoke($null, @($operation))
    $task.Wait(-1) | Out-Null
    $task.Result
  }

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
  $text = ($result.Lines | ForEach-Object { $_.Text }) -join "`n"
  if ([string]::IsNullOrWhiteSpace($text)) {
    [Console]::Error.WriteLine('图片里没有识别到文字')
    exit 2
  }
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Write-Output $text
} catch {
  [Console]::Error.WriteLine("OCR 失败：$($_.Exception.Message)")
  exit 1
}
