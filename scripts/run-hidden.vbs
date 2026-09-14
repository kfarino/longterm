' Task Scheduler host with no console. wscript.exe is a Windows subsystem
' binary (no console of its own). Run ..., 0 hides node.exe / powershell.exe,
' which still allocate a window even under -WindowStyle Hidden.
'
' Usage:
'   wscript.exe //nologo //B run-hidden.vbs <exe> [args...]
' Exit code is the child process exit code.
' Working directory is the folder of the first .mjs/.js/.ps1 argument, or
' this script's folder — never node.exe / powershell.exe's install dir.
Option Explicit

If WScript.Arguments.Count < 1 Then
  WScript.Quit 1
End If

Dim sh, fso, cmd, i, cwd, a, ext
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

cwd = fso.GetParentFolderName(WScript.ScriptFullName)
For i = 0 To WScript.Arguments.Count - 1
  a = WScript.Arguments(i)
  If fso.FileExists(a) Then
    ext = LCase(fso.GetExtensionName(a))
    If ext = "mjs" Or ext = "js" Or ext = "cjs" Or ext = "ps1" Then
      cwd = fso.GetParentFolderName(a)
      Exit For
    End If
  End If
Next
sh.CurrentDirectory = cwd

cmd = Quote(WScript.Arguments(0))
For i = 1 To WScript.Arguments.Count - 1
  cmd = cmd & " " & Quote(WScript.Arguments(i))
Next

WScript.Quit sh.Run(cmd, 0, True)

Function Quote(ByVal s)
  Quote = """" & Replace(s, """", """""") & """"
End Function
