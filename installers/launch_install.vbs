Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
installer = base & "\install.ps1"
shell.CurrentDirectory = base
command = Chr(34) & powershell & Chr(34) & " -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File " & Chr(34) & installer & Chr(34)
exitCode = shell.Run(command, 1, True)
WScript.Quit exitCode
