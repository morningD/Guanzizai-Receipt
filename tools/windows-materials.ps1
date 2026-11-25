param(
    [Parameter(Mandatory = $true)][ValidateSet('printers', 'preview', 'queue', 'print')][string] $Operation,
    [string] $Source,
    [string] $Output,
    [string] $Printer,
    [string] $JobName
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

if ($Operation -eq 'printers') {
    $printers = @(Get-Printer | ForEach-Object {
        @{
            name = $_.Name
            port = [string]$_.PortName
            status = [string]$_.PrinterStatus
            virtual = ($_.PortName -in @('PORTPROMPT:', 'FILE:', 'nul:'))
            network = ([string]$_.Type -eq 'Connection' -or [string]$_.PortName -match '^(IP_|WSD|https?://|\\\\)')
        }
    })
    ConvertTo-Json -InputObject $printers -Compress
    exit
}

function Get-PdfDocument([string] $File) {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $storageType = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $pdfType = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
    $methods = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 }
    $script:asyncOperation = $methods | Where-Object { $_.IsGenericMethodDefinition -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
    $script:asyncAction = $methods | Where-Object { -not $_.IsGenericMethod -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
    $storage = Wait-Operation ($storageType::GetFileFromPathAsync($File)) $storageType
    return Wait-Operation ($pdfType::LoadFromFileAsync($storage)) $pdfType
}

function Wait-Operation($Operation, [Type] $ResultType) {
    $task = $script:asyncOperation.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    return $task.GetAwaiter().GetResult()
}

function Write-PdfPage($Document, [uint32] $Index, [string] $Target, [int] $MaxPixels) {
    $page = $Document.GetPage($Index)
    $stream = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]::new()
    try {
        $options = [Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType = WindowsRuntime]::new()
        $options.BitmapEncoderId = [Windows.Graphics.Imaging.BitmapEncoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]::PngEncoderId
        $scale = $MaxPixels / [Math]::Max($page.Size.Width, $page.Size.Height)
        $options.DestinationWidth = [uint32][Math]::Max(1, [Math]::Round($page.Size.Width * $scale))
        $options.DestinationHeight = [uint32][Math]::Max(1, [Math]::Round($page.Size.Height * $scale))
        $task = $script:asyncAction.Invoke($null, @($page.RenderToStreamAsync($stream, $options)))
        $task.GetAwaiter().GetResult()
        $stream.Seek(0)
        $reader = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
        $file = [System.IO.File]::Create($Target)
        try { $reader.CopyTo($file) } finally { $file.Dispose(); $reader.Dispose() }
    } finally {
        $stream.Dispose()
        $page.Dispose()
    }
}

if ($Operation -eq 'preview') {
    $pdf = Get-PdfDocument $Source
    if ($pdf.PageCount -lt 1) { throw 'PDF has no pages' }
    Write-PdfPage $pdf 0 $Output 1200
    exit
}

$device = Get-Printer | Where-Object { $_.Name -eq $Printer } | Select-Object -First 1
if (-not $device) { throw 'Printer not found' }
$virtual = $device.PortName -in @('PORTPROMPT:', 'FILE:', 'nul:')
if ($virtual -and -not $Output) { throw 'Interactive file-output printers are not supported' }
if ($Operation -eq 'queue') {
    @(Get-PrintJob -PrinterObject $device | Where-Object {
        [string]$_.JobStatus -notmatch '\b(Printed|Completed)\b' -and (-not $JobName -or $_.DocumentName -eq $JobName)
    }).Count
    exit
}

Add-Type -AssemblyName System.Drawing
$document = New-Object System.Drawing.Printing.PrintDocument
$document.PrinterSettings.PrinterName = $device.Name
if ($Output) {
    if (-not $virtual) { throw 'A print output file requires a virtual printer' }
    $document.PrinterSettings.PrintToFile = $true
    $document.PrinterSettings.PrintFileName = $Output
}
$document.DocumentName = $JobName
$document.PrintController = New-Object System.Drawing.Printing.StandardPrintController
$script:index = 0
$script:pdf = $null
$script:pages = 1
if ([IO.Path]::GetExtension($Source) -ieq '.pdf') {
    $script:pdf = Get-PdfDocument $Source
    $script:pages = $script:pdf.PageCount
}
if ($script:pages -lt 1) { throw 'Document has no pages' }

$document.add_PrintPage({
    param($sender, $event)
    $file = $Source
    if ($script:pdf) {
        $file = [IO.Path]::GetTempFileName()
    }
    try {
        if ($script:pdf) { Write-PdfPage $script:pdf $script:index $file 2500 }
        $image = [System.Drawing.Image]::FromFile($file)
        try {
            $area = $event.MarginBounds
            $ratio = [Math]::Min($area.Width / $image.Width, $area.Height / $image.Height)
            $width = [int][Math]::Floor($image.Width * $ratio)
            $height = [int][Math]::Floor($image.Height * $ratio)
            $x = $area.Left + [int](($area.Width - $width) / 2)
            $y = $area.Top + [int](($area.Height - $height) / 2)
            $event.Graphics.DrawImage($image, $x, $y, $width, $height)
        } finally { $image.Dispose() }
    } finally {
        if ($script:pdf) { [IO.File]::Delete($file) }
    }
    $script:index++
    $event.HasMorePages = $script:index -lt $script:pages
})
try { $document.Print() } finally { $document.Dispose() }
# Windows spooler statuses do not guarantee paper output.
'submitted'
