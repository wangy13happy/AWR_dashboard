// Windows只读进程/原生会话探针；PSS结构继承run5实证，不读进程内存或环境。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.IO;
using System.Threading;
using System.Management;
using System.Web.Script.Serialization;
using System.Text.RegularExpressions;
public static class Native {
  [StructLayout(LayoutKind.Sequential)] public struct Entry {
    public IntPtr Handle; public uint Flags,Type; public long Capture;
    public uint Attributes,Access,Count,Pointers,Paged,NonPaged; public long Creation;
    public ushort TypeLength; public IntPtr TypeName; public ushort NameLength; public IntPtr Name;
    public ulong Specific0,Specific1,Specific2,Specific3,Specific4,Specific5;
  }
  public sealed class Found { public string Path; public string Key; public uint Access; public bool CanWrite; }
  public sealed class Result {
    public int Pid; public string Creation; public bool IdentityMatches,Alive;
    public uint Error,WalkEnd; public int Handles,Files,PathFailures;
    public List<Found> SessionFiles = new List<Found>();
  }
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr h,out long created,out long exit,out long kernel,out long user);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
  [DllImport("kernel32.dll")] static extern uint PssCaptureSnapshot(IntPtr process,uint flags,uint context,out IntPtr snapshot);
  [DllImport("kernel32.dll")] static extern uint PssWalkMarkerCreate(IntPtr allocator,out IntPtr marker);
  [DllImport("kernel32.dll")] static extern uint PssWalkSnapshot(IntPtr snapshot,int kind,IntPtr marker,out Entry entry,uint size);
  [DllImport("kernel32.dll")] static extern uint PssWalkMarkerFree(IntPtr marker);
  [DllImport("kernel32.dll")] static extern uint PssFreeSnapshot(IntPtr process,IntPtr snapshot);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll")] static extern uint GetFileType(IntPtr handle);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(IntPtr handle,StringBuilder path,uint length,uint flags);
  public static int EntrySize() { return Marshal.SizeOf(typeof(Entry)); }
  // 同一打开的进程句柄前后核实创建时间与存活，不将路径存在当成活进程证据。
  public static Result Scan(int pid,string expected,string root) {
    var r=new Result {Pid=pid}; IntPtr p=OpenProcess(0x440,false,pid);
    if(p==IntPtr.Zero){r.Error=(uint)Marshal.GetLastWin32Error();return r;}
    IntPtr snap=IntPtr.Zero,marker=IntPtr.Zero;
    try {
      long created,exit,kernel,user;
      if(!GetProcessTimes(p,out created,out exit,out kernel,out user)){r.Error=(uint)Marshal.GetLastWin32Error();return r;}
      r.Creation=created.ToString();r.IdentityMatches=r.Creation==expected;
      if(!r.IdentityMatches)return r;
      r.Error=PssCaptureSnapshot(p,0x1c,0,out snap); if(r.Error!=0)return r;
      r.Error=PssWalkMarkerCreate(IntPtr.Zero,out marker); if(r.Error!=0)return r;
      for(int n=0;n<20000;n++) {
        Entry e;uint code=PssWalkSnapshot(snap,2,marker,out e,(uint)EntrySize());r.WalkEnd=code;if(code!=0)break;
        r.Handles++;
        string type=e.TypeName!=IntPtr.Zero ? Marshal.PtrToStringUni(e.TypeName,e.TypeLength/2).TrimEnd('\0') : "";
        if(type!="File")continue;r.Files++;
        IntPtr local;
        // 仅复制文件属性读取权限，绝不复制写权限或调用文件写接口。
        if(!DuplicateHandle(p,e.Handle,GetCurrentProcess(),out local,0x80,false,0)){r.PathFailures++;continue;}
        try {
          if(GetFileType(local)!=1)continue;
          var sb=new StringBuilder(32768);uint size=GetFinalPathNameByHandleW(local,sb,(uint)sb.Capacity,0);
          if(size==0 || size>=sb.Capacity){r.PathFailures++;continue;}
          string path=sb.ToString();if(path.StartsWith(@"\\?\"))path=path.Substring(4);
          if(root.Length>0 && !path.StartsWith(root.TrimEnd('\\')+@"\",StringComparison.OrdinalIgnoreCase))continue;
          string normalized=path.Replace('/','\\');
          if((normalized.IndexOf(@"\.codex\sessions\",StringComparison.OrdinalIgnoreCase)>=0 && normalized.EndsWith(".jsonl")) ||
             (normalized.IndexOf(@"\.grok\sessions\",StringComparison.OrdinalIgnoreCase)>=0 && normalized.EndsWith("events.jsonl")) ||
             (normalized.IndexOf(@"\.claude\projects\",StringComparison.OrdinalIgnoreCase)>=0 && normalized.EndsWith(".jsonl")))
            r.SessionFiles.Add(new Found {Path=path,Key=Probe.FileKey(local),Access=e.Access,CanWrite=(e.Access&6)!=0});
        } finally{CloseHandle(local);}
      }
      uint status;if(GetExitCodeProcess(p,out status))r.Alive=status==259;
      if(r.WalkEnd!=259){r.Alive=false;r.SessionFiles.Clear();}
      return r;
    } finally {
      if(marker!=IntPtr.Zero)PssWalkMarkerFree(marker);
      if(snap!=IntPtr.Zero)PssFreeSnapshot(GetCurrentProcess(),snap);
      CloseHandle(p);
    }
  }
}
public static class Probe {
  static readonly JavaScriptSerializer Json=new JavaScriptSerializer { MaxJsonLength=2097152, RecursionLimit=64 };
  static readonly Regex Uuid=new Regex(@"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$",RegexOptions.IgnoreCase);
  static readonly Dictionary<string,History> Histories=new Dictionary<string,History>(StringComparer.OrdinalIgnoreCase);
  // 与 agent-running.js 的 EVIDENCE_GAP_GRACE_MS 一致；启动配置 evidenceGraceMs 会覆盖。
  static int EvidenceGraceMs=1800+500;
  // 与 agent-running.js 的 EXECUTING_HOLD_MS 一致。成功读到仍 Busy 会刷新确认；未再确认的上限由观察器执行。
  static int ExecutingHoldMs=90000;
  static readonly HashSet<int> LastFullPids=new HashSet<int>();
  const int ProbeSleepSliceMs=20;
  const int ProbeSleepSlices=25;
  static readonly Dictionary<string,string[]> Paths=new Dictionary<string,string[]>();
  static volatile bool Stop;
  [StructLayout(LayoutKind.Sequential,Pack=4)] public struct FileInfoNative {
    public uint Attributes; public long Creation,Access,Write; public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
  }
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr h,out FileInfoNative info);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h,out long birth,out long exit,out long kernel,out long user);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr h,uint flags,StringBuilder name,ref uint length);
  [DllImport("shell32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string cmd,out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);

  // 只读取文件标识，用于拒绝路径被替换后误读到另一个文件。
  public static string FileKey(IntPtr handle) {
    FileInfoNative info;return GetFileInformationByHandle(handle,out info) ? info.Volume+":"+info.IndexHigh+":"+info.IndexLow : null;
  }
  // 仅查询创建标识和存活，不读取地址空间、当前目录或环境区域。
  static string Birth(int pid) {
    IntPtr h=OpenProcess(0x1000,false,pid);if(h==IntPtr.Zero)return null;
    try {long birth,exit,kernel,user;uint code;
      if(!GetProcessTimes(h,out birth,out exit,out kernel,out user) || !GetExitCodeProcess(h,out code) || code!=259)return null;
      return birth.ToString();
    } finally {CloseHandle(h);}
  }
  // 原生可执行身份查询不使用MainModule/ReadProcessMemory，也不读取目标进程环境。
  static string Executable(int pid,out string birth) {
    birth=null;IntPtr h=OpenProcess(0x1000,false,pid);if(h==IntPtr.Zero)return null;
    try {
      var text=new StringBuilder(32768);uint length=(uint)text.Capacity;long created,exit,kernel,user;uint code;
      if(!GetProcessTimes(h,out created,out exit,out kernel,out user) || !QueryFullProcessImageNameW(h,0,text,ref length) || !GetExitCodeProcess(h,out code) || code!=259)return null;
      birth=created.ToString();return text.ToString();
    }
    finally {CloseHandle(h);}
  }
  // .NET Framework默认路径上限不能截断Grok编码cwd；文件访问使用本地扩展路径。
  static string Fs(string path) {return path!=null && path.Length>2 && path[1]==':' ? @"\\?\"+path : path;}
  // 仅把JSON对象作为结构记录，未知形状返回空对象。
  static Dictionary<string,object> Obj(object value) {return value as Dictionary<string,object> ?? new Dictionary<string,object>();}
  // 字段必须真实为字符串，拒绝将任意对象转成身份号。
  static string Text(Dictionary<string,object> o,string k) {object v;return o.TryGetValue(k,out v) ? v as string : null;}
  // 有界字段查找，不通过异常补造缺失的活动证据。
  static object Value(Dictionary<string,object> o,string k) {object v;return o.TryGetValue(k,out v) ? v : null;}
  // 只解析原生事件/注册表的明确时间字段，缺失返回无效的零值。
  static long Stamp(object v) {
    DateTimeOffset parsed;
    if(v is string && DateTimeOffset.TryParse((string)v,out parsed))return parsed.ToUnixTimeMilliseconds();
    try {return v==null ? 0 : Convert.ToInt64(v);}catch{return 0;}
  }
  // 仅序列化调用点列出的安全投影字段，不复制消息或命令正文。
  static Dictionary<string,object> Row(params object[] values) {
    var r=new Dictionary<string,object>();for(int n=0;n<values.Length;n+=2)r[(string)values[n]]=values[n+1];return r;
  }
  // 命令正文只在内存按参数位置解析，不持久化；fork来源从不作为当前目标。
  static string CommandId(string command,string client) {
    if(String.IsNullOrEmpty(command))return null;int count;IntPtr array=CommandLineToArgvW(command,out count);if(array==IntPtr.Zero)return null;
    try {
      var a=new List<string>();for(int n=0;n<count;n++)a.Add(Marshal.PtrToStringUni(Marshal.ReadIntPtr(array,n*IntPtr.Size)));
      bool fork=a.Contains("--fork-session");string id=null;
      var valued=new HashSet<string>(new string[]{"-c","--config","-m","--model","-C","--cd","-s","--sandbox","--output-format","--input-format","--system-prompt","--settings","--mcp-config","--tools","--permission-mode","--effort","--reasoning-effort","--leader-socket","--output-last-message","-o","--add-dir","--agent"});
      for(int n=1;n<a.Count;n++) {
        string arg=a[n];if(arg=="--")break;
        if(client=="codex" && arg=="fork")return null;
        if(arg=="--fork-session")continue;
        if((client=="codex" && arg=="resume") || arg=="--session-id" || arg=="--resume" || (client!="codex" && (arg=="-r" || arg=="--session"))) {
          if(n+1<a.Count && Uuid.IsMatch(a[n+1]))id=a[++n].ToLowerInvariant();else return null;continue;
        }
        if(valued.Contains(arg)){n++;continue;}
        if(arg.StartsWith("-"))continue;
        if(client=="codex" && (arg=="exec" || arg=="app-server"))continue;
        break;
      }
      return fork ? null : id;
    } finally {LocalFree(array);}
  }
  // fork 子的父会话只来自 --resume=<uuid> 或 --resume/-r 后的 uuid。
  // --resume-session-at 是消息锚点，不是父会话。没有 --fork-session 时不建立父链。
  static string ForkParent(string command) {
    if(String.IsNullOrEmpty(command))return null;int count;IntPtr array=CommandLineToArgvW(command,out count);if(array==IntPtr.Zero)return null;
    try {
      var a=new List<string>();for(int n=0;n<count;n++)a.Add(Marshal.PtrToStringUni(Marshal.ReadIntPtr(array,n*IntPtr.Size)));
      if(!a.Contains("--fork-session"))return null;
      for(int n=1;n<a.Count;n++) {
        string arg=a[n];if(arg=="--")break;
        string name=arg;string inline=null;int eq=arg.IndexOf('=');
        if(arg.StartsWith("-") && eq>0){name=arg.Substring(0,eq);inline=arg.Substring(eq+1);}
        if(name!="--resume" && name!="-r")continue;
        string value=inline;if(value==null && n+1<a.Count)value=a[n+1];
        return value!=null && Uuid.IsMatch(value) ? value.ToLowerInvariant() : null;
      }
      return null;
    } finally {LocalFree(array);}
  }
  sealed class History {
    public string Key,Id,ParentId,Partial="";public long Offset,Started,StableAt;public DateTime Modified;public bool Busy,BadIdentity;
  }
  // 只在确有父 UUID 时附带 parentId，不把空字符串当成继承链。
  static Dictionary<string,object> WithParent(Dictionary<string,object> row,History h) {
    if(h.ParentId!=null) row["parentId"]=h.ParentId;return row;
  }
  // -1 打不开或查询失败，不当作退出；0 已退出；1 仍存活。墓碑只发给已确认退出的 pid。
  static int Liveness(int pid) {
    IntPtr h=OpenProcess(0x1000,false,pid);if(h==IntPtr.Zero)return -1;
    try {uint code;if(!GetExitCodeProcess(h,out code))return -1;return code==259?1:0;}
    finally {CloseHandle(h);}
  }
  // 有界增量读原生jsonl，未读到稳定完整尾部时返回未知，不用文件最近写入时间猜忙。
  static Dictionary<string,object> HistoryOf(string path,string expectedKey,string client,long created) {
    string filename=Fs(path);
    using(var stream=new FileStream(filename,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete)) {
      string key=FileKey(stream.SafeFileHandle.DangerousGetHandle());if(key==null || (expectedKey!=null && key!=expectedKey))return null;
      var before=new FileInfo(filename);long length=stream.Length;DateTime modified=before.LastWriteTimeUtc;
      History h;
      if(!Histories.TryGetValue(path,out h) || h.Key!=key || length<h.Offset || (length<=h.Offset && h.Modified!=modified)){h=new History {Key=key};Histories[path]=h;}
      h.Modified=modified;
      stream.Position=h.Offset;byte[] buffer=new byte[(int)Math.Min(1048576,length-h.Offset)];int read=stream.Read(buffer,0,buffer.Length);h.Offset+=read;
      string chunk=h.Partial+Encoding.UTF8.GetString(buffer,0,read);int last=chunk.LastIndexOf('\n');
      if(last>=0) {
        string complete=chunk.Substring(0,last);h.Partial=chunk.Substring(last+1);
        foreach(string line in complete.Split('\n')) {
          if(line.Length==0)continue;
          // 不解析消息正文：仅已知结构行进入JSON解码，其他记录仍计入读取偏移。
          if(!Regex.IsMatch(line,@"\""type\""\s*:\s*\""(session_meta|event_msg|turn_started|turn_ended)\"""))continue;
          try {
            var o=Obj(Json.DeserializeObject(line));string type=Text(o,"type");var payload=Obj(Value(o,"payload"));
            if(type=="session_meta") {
              string id=Text(payload,"id");if(!Uuid.IsMatch(id ?? "")){h.BadIdentity=true;continue;}
              if(h.Id!=null && h.Id!=id)h.BadIdentity=true;h.Id=id.ToLowerInvariant();
              // 只取 fork 父 UUID。后续 meta 没再写 forked_from_id 时保留已知父链，不读取 cwd 或正文。
              string parent=Text(payload,"forked_from_id");
              if(parent!=null && Uuid.IsMatch(parent)) {string normalized=parent.ToLowerInvariant();if(normalized!=h.Id)h.ParentId=normalized;}
            }
            string kind=type=="event_msg" ? Text(payload,"type") : type;
            if(client=="codex" && (kind=="task_started" || kind=="task_complete" || kind=="turn_aborted" || kind=="task_aborted")) {
              h.Busy=kind=="task_started";h.Started=Stamp(Value(o,"timestamp"));
            }
            // 本机 Grok events 只有 session_id 与 session_relationship=primary，没有父会话字段，不造 parentId。
            if(client=="grok" && (kind=="turn_started" || kind=="turn_ended")) {
              string id=Text(o,"session_id");if(id!=null) {if(!Uuid.IsMatch(id) || (h.Id!=null && h.Id!=id))h.BadIdentity=true;else h.Id=id.ToLowerInvariant();}
              h.Busy=kind=="turn_started";h.Started=Stamp(Value(o,"ts"));
            }
          } catch {h.Busy=false;h.Started=0;}
        }
      } else h.Partial=chunk;
      if(h.Partial.Length>2097152){h.Partial="";h.Busy=false;h.Started=0;h.StableAt=0;return null;}
      var after=new FileInfo(filename);
      bool unstable=h.Offset!=length || h.Partial.Length!=0 || after.Length!=length || after.LastWriteTimeUtc!=modified;
      // 身份损坏或从未成功解析出会话号时不沿用旧忙闲。
      if(h.BadIdentity || h.Id==null)return null;
      long nowMs=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
      // 尾部仍在写入且本轮仍解析为 Busy：这是重新确认，不是回合结束。短间隔标 held，更长的流式回合标 scan-hold。
      // 本轮已经解析到 task_complete / turn_ended 则 Busy 为假，不发布 executing，持有也不能把已结束回合重新点亮。
      if(unstable) {
        if(h.Busy && h.Started>=created && ExecutingHoldMs>0) {
          string evidence=h.StableAt>0 && nowMs>=h.StableAt && nowMs-h.StableAt<=EvidenceGraceMs ? "held" : "scan-hold";
          h.StableAt=nowMs;
          return WithParent(Row("id",h.Id,"state","executing","startedAt",h.Started,"evidence",evidence,"evidenceAt",nowMs),h);
        }
        return null;
      }
      h.StableAt=nowMs;
      return WithParent(Row("id",h.Id,"state",h.Busy && h.Started>=created ? "executing":"ended","startedAt",h.Started),h);
    }
  }
  // CLI明确当前号时只在标准原生会话根查找文件；不存在或多文件歧义均保守关闭。
  static IEnumerable<string> Locate(string root,string client,string id) {
    string cacheKey=root+"|"+client+"|"+id;string[] paths;
    if(Paths.TryGetValue(cacheKey,out paths))return paths;
    var found=new List<string>();if(root==null || !Directory.Exists(root))return found;
    var pending=new Queue<string>();pending.Enqueue(root);int entries=0;
    while(pending.Count>0 && entries<20000) {
      string dir=pending.Dequeue();
      if((File.GetAttributes(dir)&FileAttributes.ReparsePoint)!=0)continue;
      foreach(string file in Directory.EnumerateFiles(dir,client=="codex" ? "rollout-*.jsonl":"events.jsonl")) {
        if(++entries>20000)return new string[0];
        if(file.IndexOf(id,StringComparison.OrdinalIgnoreCase)>=0)found.Add(file);
      }
      foreach(string child in Directory.EnumerateDirectories(dir)){if(++entries>20000)return new string[0];pending.Enqueue(child);}
    }
    paths=found.ToArray();if(Paths.Count>1024)Paths.Clear();Paths[cacheKey]=paths;return paths;
  }
  // 注册表必须属于同一PID/完整创建FILETIME；hostSessionId是原样别名，绝不变造ID。
  static Dictionary<string,object> Claude(string root,int pid,string creation,long created) {
    string file=Path.Combine(root,pid+".json");if(!File.Exists(file) || new FileInfo(file).Length>32768 || (File.GetAttributes(file)&FileAttributes.ReparsePoint)!=0)return null;
    var o=Obj(Json.DeserializeObject(File.ReadAllText(file,Encoding.UTF8)));string id=Text(o,"sessionId");
    if(!Uuid.IsMatch(id ?? "") || Convert.ToInt32(Value(o,"pid"))!=pid || Convert.ToString(Value(o,"procStart"))!=creation)return null;
    long updated=Stamp(Value(o,"statusUpdatedAt"));if(updated<created)return null;
    return Row("id",id.ToLowerInvariant(),"hostSessionId",Text(o,"hostSessionId"),"state",Text(o,"status")=="busy" ? "executing":"ended","startedAt",updated);
  }
  static readonly Dictionary<string,string> CommandCache=new Dictionary<string,string>();
  static readonly Dictionary<string,string> ParentCache=new Dictionary<string,string>();
  // 同一创建实例只读一次命令行。失败也缓存，避免每轮扫描都查询。
  static string ClaudeForkParent(int pid,string birth) {
    string instance=pid+":"+birth;string parent;
    if(ParentCache.TryGetValue(instance,out parent))return parent;
    parent=null;
    try {
      using(var search=new ManagementObjectSearcher("SELECT CommandLine FROM Win32_Process WHERE ProcessId="+pid))
      using(var values=search.Get())foreach(ManagementObject row in values)using(row)parent=ForkParent(row["CommandLine"] as string);
    } catch {parent=null;}
    ParentCache[instance]=parent;return parent;
  }
  // 只打开三种精确客户端；测试白名单时直接查这些PID，完全跳过全机发现。
  static List<Dictionary<string,object>> Scan(Dictionary<string,object> config) {
    var output=new List<Dictionary<string,object>>();var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    object ids=Value(config,"pids");var filterIds=ids as object[];
    if(filterIds!=null && filterIds.Length==0)return output;
    var candidates=new HashSet<int>();
    if(filterIds!=null) {
      foreach(object id in filterIds){int pid=Convert.ToInt32(id);if(pid<=0)throw new Exception("pid");candidates.Add(pid);}
    } else {
      foreach(string name in new string[]{"codex","claude","grok"})foreach(Process process in Process.GetProcessesByName(name))using(process)candidates.Add(process.Id);
    }
    if(candidates.Count>256)throw new Exception("process_limit");
    var live=new HashSet<string>();
    foreach(int pid in candidates) {
        string birth;string executable=Executable(pid,out birth);if(executable==null || birth==null)continue;
        string client=Path.GetFileNameWithoutExtension(executable).ToLowerInvariant();
        if(client!="codex" && client!="claude" && client!="grok")continue;
        long created=Int64.Parse(birth)/10000-11644473600000;
        string instance=pid+":"+birth;live.Add(instance);
        var sessions=new List<Dictionary<string,object>>();
        try {
          if(client=="claude") {
            var registration=Claude(Text(config,"claudeRegistry"),pid,birth,created);
            if(registration!=null) {
              string parent=ClaudeForkParent(pid,birth);string id=(string)registration["id"];
              if(!String.IsNullOrEmpty(parent) && parent!=id)registration["parentId"]=parent;
              sessions.Add(registration);
            }
          } else {
            var native=Native.Scan(pid,birth,Text(config,"allowedRoot") ?? "");
            if(!native.Alive || !native.IdentityMatches)continue;
            string current=null;var files=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
            foreach(var f in native.SessionFiles)if(f.CanWrite && f.Key!=null && !f.Path.StartsWith(@"\\"))files[f.Path]=f.Key;
            // 写句柄身份已足够时不查询命令行；没有文件证据才只读当前PID的控制参数，按创建实例缓存。
            if(files.Count==0 && !CommandCache.TryGetValue(instance,out current)) {
              try {
                using(var search=new ManagementObjectSearcher("SELECT CommandLine FROM Win32_Process WHERE ProcessId="+pid))
                using(var values=search.Get())foreach(ManagementObject row in values)using(row)current=CommandId(row["CommandLine"] as string,client);
              } catch {current=null;}
              CommandCache[instance]=current;
            }
            if(files.Count==0 && current!=null)foreach(string p in Locate(Text(config,client+"Sessions"),client,current))files[p]=null;
            if(files.Count>64)continue;
            foreach(var pair in files) {
              if((client=="codex" && pair.Key.IndexOf(@"\.codex\sessions\",StringComparison.OrdinalIgnoreCase)<0) || (client=="grok" && pair.Key.IndexOf(@"\.grok\sessions\",StringComparison.OrdinalIgnoreCase)<0))continue;
              if((File.GetAttributes(Fs(pair.Key))&FileAttributes.ReparsePoint)!=0)continue;
              seen.Add(pair.Key);if(seen.Count>256)throw new Exception("file_limit");var history=HistoryOf(pair.Key,pair.Value,client,created);
              if(history!=null && (current==null || (string)history["id"]==current))sessions.Add(history);
            }
          }
        } catch {sessions.Clear();}
        if(Birth(pid)==birth)output.Add(Row("pid",pid,"client",client,"createdAt",created,"alive",true,"sessions",sessions));
    }
    foreach(string instance in new List<string>(CommandCache.Keys))if(!live.Contains(instance))CommandCache.Remove(instance);
    foreach(string instance in new List<string>(ParentCache.Keys))if(!live.Contains(instance))ParentCache.Remove(instance);
    foreach(string path in new List<string>(Histories.Keys))if(!seen.Contains(path))Histories.Remove(path);
    LastFullPids.Clear();
    foreach(var row in output) {
      object alive=Value(row,"alive");object pid=Value(row,"pid");
      if(alive is bool && (bool)alive && pid!=null) LastFullPids.Add(Convert.ToInt32(pid));
    }
    return output;
  }
  // 完整 PSS 扫描之前先读 Claude 小注册表，并给上一轮已确认退出的 pid 发墓碑。
  // 空测试白名单直接返回，不碰用户主目录。打不开的进程不发墓碑。
  static List<Dictionary<string,object>> FastProcesses(Dictionary<string,object> config) {
    var output=new List<Dictionary<string,object>>();
    object ids=Value(config,"pids");var filter=ids as object[];
    if(filter!=null && filter.Length==0)return output;
    var allow=filter==null ? null : new HashSet<int>();
    if(filter!=null)foreach(object id in filter)allow.Add(Convert.ToInt32(id));
    var seen=new HashSet<int>();
    string root=Text(config,"claudeRegistry");
    if(root!=null && Directory.Exists(root)) {
      int files=0;
      foreach(string file in Directory.EnumerateFiles(root,"*.json")) {
        if(++files>256)break;
        try {
          if((File.GetAttributes(file)&FileAttributes.ReparsePoint)!=0)continue;
          int pid;if(!Int32.TryParse(Path.GetFileNameWithoutExtension(file),out pid)||pid<=0)continue;
          if(allow!=null && !allow.Contains(pid))continue;
          if(new FileInfo(file).Length>32768)continue;
          seen.Add(pid);
          int live=Liveness(pid);
          if(live==0){output.Add(Row("pid",pid,"client","claude","createdAt",1,"alive",false,"sessions",new object[0]));continue;}
          if(live!=1)continue;
          string birth=Birth(pid);if(birth==null)continue;
          long created=Int64.Parse(birth)/10000-11644473600000;
          var registration=Claude(root,pid,birth,created);
          if(registration!=null) {
            string parent=ClaudeForkParent(pid,birth);string id=(string)registration["id"];
            if(!String.IsNullOrEmpty(parent) && parent!=id)registration["parentId"]=parent;
            output.Add(Row("pid",pid,"client","claude","createdAt",created,"alive",true,"sessions",new Dictionary<string,object>[]{registration}));
          }
        } catch {continue;}
      }
    }
    foreach(int pid in new List<int>(LastFullPids)) {
      if(seen.Contains(pid))continue;
      if(allow!=null && !allow.Contains(pid))continue;
      if(Liveness(pid)==0)output.Add(Row("pid",pid,"client","codex","createdAt",1,"alive",false,"sessions",new object[0]));
    }
    return output;
  }
  // stdin关闭即退出，后台线程不阻止服务进程意外结束后的清理；没有自我重启或计划任务。
  public static int Main() {
    try {
      AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling",false);
      AppContext.SetSwitch("Switch.System.IO.BlockLongPaths",false);
      Console.InputEncoding=Encoding.UTF8;Console.OutputEncoding=new UTF8Encoding(false);
      var config=Obj(Json.DeserializeObject(Console.ReadLine()));
      object grace=Value(config,"evidenceGraceMs");if(grace!=null)EvidenceGraceMs=Convert.ToInt32(grace);
      object hold=Value(config,"executingHoldMs");if(hold!=null)ExecutingHoldMs=Convert.ToInt32(hold);
      if(ExecutingHoldMs<EvidenceGraceMs)ExecutingHoldMs=EvidenceGraceMs;
      var thread=new Thread(delegate() {
        while(!Stop) {
          long start=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();var watch=Stopwatch.StartNew();
          try {
            Console.WriteLine(Json.Serialize(Row("type","scan-start","at",start)));
            try {
              var fast=FastProcesses(config);
              Console.WriteLine(Json.Serialize(Row("type","sample","ok",true,"phase","fast","covered",false,"sampledAt",DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),"scanMs",watch.Elapsed.TotalMilliseconds,"processes",fast)));
            } catch {}
            var rows=Scan(config);watch.Stop();
            Console.WriteLine(Json.Serialize(Row("type","sample","ok",true,"phase","full","sampledAt",DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),"scanMs",watch.Elapsed.TotalMilliseconds,"processes",rows)));
          } catch {Console.WriteLine(Json.Serialize(Row("type","sample","ok",false,"sampledAt",start,"scanMs",watch.Elapsed.TotalMilliseconds,"processes",new object[0])));}
          Console.Out.Flush();for(int n=0;n<ProbeSleepSlices && !Stop;n++)Thread.Sleep(ProbeSleepSliceMs);
        }
      });thread.IsBackground=true;thread.Start();
      while(Console.ReadLine()!=null){}Stop=true;thread.Join(500);return 0;
    } catch {return 1;}
  }
}
