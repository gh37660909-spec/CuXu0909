param(
  [Parameter(Mandatory = $true)][string]$InputFile,
  [Parameter(Mandatory = $true)][string]$OutputFile
)

$ErrorActionPreference = 'Stop'
$ext = [IO.Path]::GetExtension($InputFile).ToLowerInvariant()
$app = $null

try {
  switch ($ext) {
    '.pptx' {
      $app = New-Object -ComObject PowerPoint.Application
      $pres = $app.Presentations.Open($InputFile, $true, $false, $false)
      $pres.SaveAs($OutputFile, 32)
      $pres.Close()
    }
    '.ppt' {
      $app = New-Object -ComObject PowerPoint.Application
      $pres = $app.Presentations.Open($InputFile, $true, $false, $false)
      $pres.SaveAs($OutputFile, 32)
      $pres.Close()
    }
    '.docx' {
      $app = New-Object -ComObject Word.Application
      $app.Visible = $false
      $app.DisplayAlerts = 0
      $doc = $app.Documents.Open($InputFile, $false, $true)
      $doc.SaveAs2($OutputFile, 17)
      $doc.Close($false)
    }
    '.doc' {
      $app = New-Object -ComObject Word.Application
      $app.Visible = $false
      $app.DisplayAlerts = 0
      $doc = $app.Documents.Open($InputFile, $false, $true)
      $doc.SaveAs2($OutputFile, 17)
      $doc.Close($false)
    }
    '.xlsx' {
      $app = New-Object -ComObject Excel.Application
      $app.Visible = $false
      $app.DisplayAlerts = $false
      $wb = $app.Workbooks.Open($InputFile)
      $wb.ExportAsFixedFormat(0, $OutputFile)
      $wb.Close($false)
    }
    '.xls' {
      $app = New-Object -ComObject Excel.Application
      $app.Visible = $false
      $app.DisplayAlerts = $false
      $wb = $app.Workbooks.Open($InputFile)
      $wb.ExportAsFixedFormat(0, $OutputFile)
      $wb.Close($false)
    }
    default { throw "Unsupported file: $ext" }
  }
}
finally {
  if ($app -ne $null) {
    try { $app.Quit() } catch { }
    try { [Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null } catch { }
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}

if (-not (Test-Path -LiteralPath $OutputFile)) {
  throw 'Office did not produce a PDF'
}
