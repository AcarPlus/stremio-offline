' Offline İndir servisini pencere açmadan başlatır (oturum açılışı kısayolu bunu çalıştırır).
' Servis zaten çalışıyorsa ikinci örnek sessizce çıkar. İsteğe bağlı 1. argüman: node.exe yolu.
Option Explicit
Dim sh, fso, node
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
node = "node"
If WScript.Arguments.Count > 0 Then
  If Len(WScript.Arguments(0)) > 0 Then node = WScript.Arguments(0)
End If
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run """" & node & """ server.mjs", 0, False
