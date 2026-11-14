' "Stremio Offline" kısayolu bunu çalıştırır: konsol penceresi göstermeden stremio-baslat.ps1'i çağırır.
' İsteğe bağlı 1. argüman: node.exe yolu (servisi başlatmak için).
Option Explicit
Dim sh, fso, dir, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\stremio-baslat.ps1"""
If WScript.Arguments.Count > 0 Then
  If Len(WScript.Arguments(0)) > 0 Then cmd = cmd & " -NodeYolu """ & WScript.Arguments(0) & """"
End If
sh.CurrentDirectory = dir
sh.Run cmd, 0, False
