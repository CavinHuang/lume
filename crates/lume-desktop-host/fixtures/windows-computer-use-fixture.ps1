param([Parameter(Mandatory = $true)][string]$StatePath)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Lume Computer Use Fixture'
$form.Size = New-Object System.Drawing.Size(680, 620)
$form.StartPosition = 'CenterScreen'

$button = New-Object System.Windows.Forms.Button
$button.Text = 'Increment Counter'
$button.AccessibleName = 'Increment Counter'
$button.SetBounds(24, 24, 180, 36)

$counterLabel = New-Object System.Windows.Forms.Label
$counterLabel.Text = 'Counter: 0'
$counterLabel.SetBounds(24, 72, 240, 28)

$input = New-Object System.Windows.Forms.TextBox
$input.Text = 'seed'
$input.AccessibleName = 'Fixture Input'
$input.SetBounds(24, 112, 320, 30)

$list = New-Object System.Windows.Forms.ListBox
$list.AccessibleName = 'Fixture Scroll'
$list.SetBounds(24, 158, 520, 190)
1..40 | ForEach-Object { [void]$list.Items.Add("Scrollable row $_") }

$dragLabel = New-Object System.Windows.Forms.Label
$dragLabel.Text = 'Last drag: none'
$dragLabel.SetBounds(24, 362, 520, 28)

$dragPad = New-Object System.Windows.Forms.Panel
$dragPad.AccessibleName = 'Fixture Drag Pad'
$dragPad.BackColor = [System.Drawing.Color]::Orange
$dragPad.BorderStyle = 'FixedSingle'
$dragPad.SetBounds(24, 402, 520, 120)

$form.Controls.AddRange(@($button, $counterLabel, $input, $list, $dragLabel, $dragPad))

$counter = 0
$lastKey = 'none'
$lastDrag = 'none'
$dragStart = $null

function Write-FixtureState {
  $temporaryPath = "$StatePath.tmp"
  @{
    counter = $counter
    text = $input.Text
    scroll = $list.TopIndex
    lastKey = $lastKey
    lastDrag = $lastDrag
  } | ConvertTo-Json -Compress | Set-Content -LiteralPath $temporaryPath -Encoding utf8
  Move-Item -LiteralPath $temporaryPath -Destination $StatePath -Force
}

$button.Add_Click({
  $script:counter += 1
  $counterLabel.Text = "Counter: $script:counter"
  Write-FixtureState
})
$input.Add_TextChanged({ Write-FixtureState })
$input.Add_KeyDown({
  param($sender, $eventArgs)
  $script:lastKey = $eventArgs.KeyCode.ToString()
  Write-FixtureState
})
$dragPad.Add_MouseDown({
  param($sender, $eventArgs)
  $script:dragStart = $eventArgs.Location
})
$dragPad.Add_MouseUp({
  param($sender, $eventArgs)
  if ($null -ne $script:dragStart) {
    $script:lastDrag = "from ($($script:dragStart.X), $($script:dragStart.Y)) to ($($eventArgs.X), $($eventArgs.Y))"
    $dragLabel.Text = "Last drag: $script:lastDrag"
    Write-FixtureState
  }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$timer.Add_Tick({ Write-FixtureState })
$timer.Start()
$form.Add_Shown({ Write-FixtureState; $form.Activate() })
$form.Add_FormClosed({ $timer.Stop() })

[System.Windows.Forms.Application]::Run($form)
