' Hidden login-task wrapper: no project reads, credentials, or supervisor loop.
' The limited interactive script host waits for the fixed Node child and returns its exit code.
' Keep this legacy Script Host source ASCII; it does not reliably decode UTF-8 comments.
Option Explicit

Dim fileSystem, shell, projectRoot, nodePath, runnerPath, registryPath, statePath
Dim command, result
On Error Resume Next
If WScript.Arguments.Count <> 1 Then WScript.Quit 1
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
If Err.Number <> 0 Then WScript.Quit 1

' Derive all targets and the fixed port from this script location, not caller-supplied paths.
projectRoot = fileSystem.GetParentFolderName(fileSystem.GetParentFolderName(WScript.ScriptFullName))
nodePath = WScript.Arguments(0)
runnerPath = fileSystem.BuildPath(projectRoot, "bin\background-runner.mjs")
registryPath = fileSystem.BuildPath(projectRoot, "config\projects.json")
statePath = fileSystem.BuildPath(projectRoot, "run\background")
If Err.Number <> 0 Then WScript.Quit 1
If LCase(fileSystem.GetFileName(nodePath)) <> "node.exe" Then WScript.Quit 1
If LCase(fileSystem.GetAbsolutePathName(nodePath)) <> LCase(nodePath) Then WScript.Quit 1
If Not fileSystem.FileExists(nodePath) Then WScript.Quit 1
If Not fileSystem.FileExists(runnerPath) Then WScript.Quit 1
If Not fileSystem.FileExists(registryPath) Then WScript.Quit 1

' Run expands percent-delimited environment variables. Reject those paths, quotes and newlines.
command = QuoteArgument(nodePath) & " --no-warnings " & QuoteArgument(runnerPath) _
    & " --port 4317 --projects " & QuoteArgument(registryPath) _
    & " --state-directory " & QuoteArgument(statePath)
shell.CurrentDirectory = projectRoot
If Err.Number <> 0 Then WScript.Quit 1
Err.Clear
result = shell.Run(command, 0, True)
If Err.Number <> 0 Then WScript.Quit 1
WScript.Quit result

' Quote one fixed absolute path; no command interpreter or arbitrary command text is accepted.
Function QuoteArgument(value)
    If Len(value) = 0 Or InStr(value, Chr(34)) > 0 Or InStr(value, "%") > 0 _
        Or InStr(value, vbCr) > 0 Or InStr(value, vbLf) > 0 Then WScript.Quit 1
    QuoteArgument = Chr(34) & value & Chr(34)
End Function
