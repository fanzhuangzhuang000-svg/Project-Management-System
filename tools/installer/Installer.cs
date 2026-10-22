using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace ElvPmsSetup
{
    /// <summary>
    /// 弱电智能化工程项目管理系统 —— 安装程序
    ///
    /// 做三件事：
    ///   1. 把打包进来的 Node 运行环境 + 程序文件解到目标目录（用户无需自己装 Node）
    ///   2. 建快捷方式、可选开机自启（后台静默跑，同事随时能访问）
    ///   3. 在「应用和功能」里注册卸载项
    ///
    /// 卸载时只删程序目录，data / backup 原样保留，绝不碰用户数据。
    ///
    /// 命令行（供静默安装与自动化测试）：
    ///   /silent              静默安装
    ///   /dir=路径            指定安装目录
    ///   /no-desktop          不建桌面快捷方式
    ///   /no-autostart        不设开机自启
    ///   /uninstall           卸载
    /// </summary>
    static class Program
    {
        const string APP_NAME = "弱电智能化工程项目管理系统";
        const string APP_SHORT = "弱电项目管理系统";
        const string APP_ID = "ELV-PMS";
        const string REG_UNINSTALL = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\ELV-PMS";
        const string PAYLOAD_RES = "Payload";
        const int PORT = 8787;

        static string installDir;
        static bool silent, noDesktop, noAutostart, uninstallMode;

        /// <summary>
        /// 「打开系统.vbs」的正文 —— 桌面图标的落点。
        ///
        /// 这是整个安装体验最容易被吐槽的一处。老版本桌面快捷方式只调「后台启动.vbs」，
        /// 那个脚本只起服务、不开浏览器：用户双击完既没有窗口也没有网页，
        /// 自然认为「图标点了没反应」，然后再双击几次 —— 于是起了好几个 node 抢 8787。
        /// 所以这里必须做到：已在运行就直接开浏览器，没运行就等它起来再开。
        ///
        /// 探测方式也是踩过坑才定下来的：
        ///   · 不能用 MSXML2.XMLHTTP 去请求 127.0.0.1 —— 系统代理会把本机请求也劫持走，
        ///     代理绕不通就误判成「端口被占用」，服务明明好的却打不开。
        ///   · 也不用 netstat | findstr —— 要起 cmd 进程、会闪黑窗，输出还受系统语言影响。
        ///   现在用 WMI：MSFT_NetTCPConnection 问端口有没有在监听，
        ///   Win32_Process 问跑的是不是本安装目录下的 node。
        /// </summary>
        static readonly string OPEN_VBS = @"
' 弱电项目管理系统 · 一键打开
'   已在运行  -> 直接打开浏览器
'   没有运行  -> 后台静默启动，等端口就绪后自动打开浏览器
'
' 探测为什么不用 HTTP、也不用 netstat，见 Installer.cs 里的注释。
Option Explicit

Dim TITLE
Dim sh, fso, appDir, url, nodePath, serverPath, dataPath, q
Dim portLive, oursRunning, skipBrowse, argItem

TITLE = ""弱电项目管理系统""

' /no-browser：只把服务拉起来，不弹浏览器。
' 给自动化测试和 IT 排障用 —— 否则每次验证都会在桌面上鼓捣出一堆浏览器窗口。
skipBrowse = False
For Each argItem In WScript.Arguments
  If LCase(argItem) = ""/no-browser"" Then skipBrowse = True
Next

Set sh  = CreateObject(""WScript.Shell"")
Set fso = CreateObject(""Scripting.FileSystemObject"")
q = Chr(34)

appDir     = fso.GetParentFolderName(WScript.ScriptFullName)
nodePath   = appDir & ""\node.exe""
serverPath = appDir & ""\app\server.js""
dataPath   = appDir & ""\data""
url        = ""http://127.0.0.1:"" & @PORT@

If Not fso.FileExists(nodePath) Then
  MsgBox ""找不到 node.exe，安装目录可能不完整："" & vbCrLf & appDir, 16, TITLE
  WScript.Quit 2
End If

If Not fso.FolderExists(dataPath) Then fso.CreateFolder dataPath

portLive    = PortListening(@PORT@)
oursRunning = OursRunning()

If (Not portLive) And (Not oursRunning) Then
  sh.Popup ""正在启动服务，请稍候…"", 2, TITLE, 64

  sh.CurrentDirectory = appDir & ""\app""
  sh.Environment(""PROCESS"")(""PMS_DATA_DIR"") = dataPath
  sh.Environment(""PROCESS"")(""PMS_PORT"")     = CStr(@PORT@)

  sh.Run q & nodePath & q & "" --no-warnings "" & q & serverPath & q & "" --port "" & @PORT@, 0, False

  portLive = WaitPort(@PORT@, 30)

  If Not portLive Then
    If OursRunning() Then
      MsgBox ""服务进程起来了，但端口 @PORT@ 一直没监听上。"" & vbCrLf & vbCrLf & _
             ""多半是被别的程序占用了，或者防火墙 / 杀毒软件拦了 node.exe。"" & vbCrLf & vbCrLf & _
             ""日志："" & dataPath & ""\startup.log"", 48, TITLE
    Else
      MsgBox ""服务启动失败（进程起来后马上退出了）。"" & vbCrLf & vbCrLf & _
             ""常见原因："" & vbCrLf & _
             ""· 端口 @PORT@ 被其他程序占用"" & vbCrLf & _
             ""· 杀毒软件拦截了 node.exe"" & vbCrLf & vbCrLf & _
             ""日志："" & dataPath & ""\startup.log"", 48, TITLE
    End If
    WScript.Quit 3
  End If

  oursRunning = True
End If

If (Not oursRunning) And portLive Then
  ' 端口上蹲着别人的服务。自动化场景下不要弹框（会卡住没人点的测试）
  If skipBrowse Then WScript.Quit 0
  If MsgBox(""端口 @PORT@ 上跑的不是本系统的服务（被别的程序占了）。"" & vbCrLf & vbCrLf & _
            ""还是打开浏览器看看吗？"", vbYesNo + 48, TITLE) <> vbYes Then WScript.Quit 4
End If

If skipBrowse Then WScript.Quit 0
sh.Run url, 1, False
WScript.Quit 0

' ---------- 探测 ----------

' 端口是否处于监听状态（MSFT_NetTCPConnection.State = 2 即 Listen）
Function PortListening(p)
  Dim wmi, rows
  PortListening = False
  On Error Resume Next
  Set wmi = GetObject(q & ""winmgmts:\\.\root\StandardCimv2"" & q)
  If Err.Number <> 0 Then Err.Clear : Exit Function
  Set rows = wmi.ExecQuery(q & ""select LocalPort from MSFT_NetTCPConnection where LocalPort="" & p & "" and State=2"" & q)
  If Err.Number <> 0 Then Err.Clear : Exit Function
  If Not (rows Is Nothing) Then
    If rows.Count > 0 Then PortListening = True
  End If
  Err.Clear
  On Error GoTo 0
End Function

' 轮询等端口就绪，最长 secs 秒
Function WaitPort(p, secs)
  Dim i
  WaitPort = False
  For i = 1 To secs * 2
    If PortListening(p) Then
      WaitPort = True
      Exit Function
    End If
    WScript.Sleep 500
  Next
End Function

' 本安装目录下是否有 node 在跑。
' 默认返回 True（放行）：WMI 查不动时宁可多开一个浏览器，
' 也不能凭空把用户拦住说「你的服务没起来」。
Function OursRunning()
  Dim wmi, procs, proc, exe, cmdline, target
  OursRunning = True
  target = LCase(appDir)
  On Error Resume Next
  Set wmi = GetObject(q & ""winmgmts:\\.\root\cimv2"" & q)
  If Err.Number <> 0 Then Err.Clear : Exit Function
  Set procs = wmi.ExecQuery(q & ""select ExecutablePath, CommandLine from Win32_Process where Name='node.exe'"" & q)
  If Err.Number <> 0 Or procs Is Nothing Then Err.Clear : Exit Function
  For Each proc In procs
    exe = vbNullString
    If Not IsNull(proc.ExecutablePath) Then exe = LCase(proc.ExecutablePath)
    cmdline = vbNullString
    If Not IsNull(proc.CommandLine) Then cmdline = LCase(proc.CommandLine)
    If InStr(exe, target) > 0 Or InStr(cmdline, target) > 0 Then
      Err.Clear
      Exit Function
    End If
  Next
  OursRunning = False
  Err.Clear
  On Error GoTo 0
End Function
";

        static string DefaultDir
        {
            get
            {
                string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                return Path.Combine(local, APP_ID);
            }
        }

        [STAThread]
        static int Main(string[] args)
        {
            ParseArgs(args);
            if (installDir == null || installDir.Length == 0)
            {
                // 没指定目录时：
                //  - 如果自己叫「卸载.exe」，说明就在安装目录里，用它所在目录（自定义安装路径也能卸干净）
                //  - 否则用默认安装位置
                string self = Assembly.GetExecutingAssembly().Location;
                if (self != null && self.Length > 0
                    && Path.GetFileName(self).Equals("卸载.exe", StringComparison.OrdinalIgnoreCase))
                    installDir = Path.GetDirectoryName(self);
                else
                    installDir = DefaultDir;
            }
            installDir = Path.GetFullPath(installDir);

            try
            {
                if (uninstallMode)
                    return silent
                        ? RunUninstall(delegate(string s) { Console.Error.WriteLine("[卸载] " + s); })
                        : RunUninstallWizard();

                if (!silent && Environment.UserInteractive)
                    return RunInstallWizard();

                // 静默安装也把进度写到 stderr，方便自动化脚本核对
                return RunInstall(delegate(string s) { Console.Error.WriteLine("[安装] " + s); });
            }
            catch (Exception ex)
            {
                if (silent)
                {
                    Console.Error.WriteLine("[安装失败] " + ex.Message);
                    Console.Error.WriteLine("[类型] " + ex.GetType().FullName);
                    Console.Error.WriteLine("[堆栈] " + ex.StackTrace);
                    if (ex.InnerException != null)
                        Console.Error.WriteLine("[内层] " + ex.InnerException.Message);
                    return 1;
                }
                MessageBox.Show("出错了：" + ex.Message, APP_NAME, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        static void ParseArgs(string[] args)
        {
            foreach (string a in args)
            {
                string s = a.Trim();
                if (s.Equals("/silent", StringComparison.OrdinalIgnoreCase) || s.Equals("-silent", StringComparison.OrdinalIgnoreCase))
                    silent = true;
                else if (s.Equals("/uninstall", StringComparison.OrdinalIgnoreCase) || s.Equals("-uninstall", StringComparison.OrdinalIgnoreCase))
                    uninstallMode = true;
                else if (s.Equals("/no-desktop", StringComparison.OrdinalIgnoreCase))
                    noDesktop = true;
                else if (s.Equals("/no-autostart", StringComparison.OrdinalIgnoreCase))
                    noAutostart = true;
                else if (s.StartsWith("/dir=", StringComparison.OrdinalIgnoreCase))
                    installDir = s.Substring(5).Trim('"');
            }
        }

        /* ==================== 安装：带界面 ==================== */
        static int RunInstallWizard()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (SetupForm f = new SetupForm())
            {
                Application.Run(f);
                return f.ExitCode;
            }
        }

        /* ==================== 安装：静默 ==================== */
        static int RunInstall(Action<string> log)
        {
            if (log != null) log("检查安装目录…");
            PrepareDir();
            // 覆盖安装：先把正在运行的旧版本停掉。
            // 不停的话 node.exe 和 app\ 下的文件被占用，解压会失败或只覆盖一半，
            // 装完变成一个半新半旧、起不来的程序。
            if (File.Exists(Path.Combine(installDir, "node.exe")))
            {
                if (log != null) log("检测到已安装过，正在停止正在运行的服务…");
                StopServer();
            }
            // 解压之前先备份数据库。
            // 理由：覆盖安装是唯一会动到用户现有文件的时刻，解压中途失败（磁盘满、
            // 杀软锁文件、断电）会留下一个半截的库。这时候有一份 30 秒前的副本，
            // 比事后跟用户解释「数据可能受损」有用得多。
            BackupDb(log, "安装前自动备份");
            if (log != null) log("正在解压程序文件（约 30 秒）…");
            ExtractPayload(log);
            if (log != null) log("正在创建启动器…");
            WriteLaunchers();
            // 顺序要紧：CreateShortcuts 会引用「卸载.exe」，
            // 而首次安装时这个文件还没被复制出来 —— 先复制再建快捷方式，
            // 否则开始菜单里的「卸载」指向一个不存在的路径，点了毫无反应。
            CopyUninstaller();
            if (log != null) log("正在创建快捷方式…");
            CreateShortcuts();
            if (log != null) log("正在注册卸载信息…");
            RegisterUninstall();
            if (!noAutostart)
            {
                if (log != null) log("正在设置开机自启…");
                SetAutoStart(true);
            }
            if (log != null) log("正在启动服务…");
            StartServer();
            if (log != null) log("完成");
            return 0;
        }

        static void PrepareDir()
        {
            Directory.CreateDirectory(installDir);
            Directory.CreateDirectory(Path.Combine(installDir, "app"));
            Directory.CreateDirectory(Path.Combine(installDir, "data"));
            Directory.CreateDirectory(Path.Combine(installDir, "backup"));
        }

        /// <summary>
        /// 把 data\pms.db 复制一份到 backup\&lt;阶段&gt;\&lt;时间戳&gt;\。
        ///
        /// 只复制主库和它的 -wal / -shm，不复制整个 data 目录：
        /// 附件可能几十 GB，全量拷贝会让安装卡十几分钟，用户会以为卡死了。
        ///
        /// 备份失败不阻断流程（磁盘满的情况下更要让安装继续，否则用户两头落空），
        /// 但会写进日志，装完能查到。
        /// </summary>
        static void BackupDb(Action<string> log, string stage)
        {
            try
            {
                string db = Path.Combine(installDir, "data", "pms.db");
                if (!File.Exists(db) || new FileInfo(db).Length == 0) return;

                string root = Path.Combine(installDir, "backup", stage);
                string dir = Path.Combine(root, DateTime.Now.ToString("yyyyMMdd-HHmmss"));
                Directory.CreateDirectory(dir);
                File.Copy(db, Path.Combine(dir, "pms.db"), true);
                // WAL 模式下最近的改动还在 -wal 里，光复制主库会丢掉最后一批写入
                foreach (string ext in new string[] { "-wal", "-shm" })
                {
                    string side = db + ext;
                    if (!File.Exists(side)) continue;
                    try { File.Copy(side, Path.Combine(dir, "pms.db" + ext), true); }
                    catch { /* 辅助文件拷不到就算了，主库已经有了 */ }
                }
                if (log != null) log("数据库已备份到 " + dir);
                PruneBackups(root, 3);
            }
            catch (Exception ex)
            {
                if (log != null) log("警告：备份数据库失败（" + ex.Message + "），继续安装");
            }
        }

        /// <summary>只保留最近 keep 份自动备份，别让 backup 目录无限长</summary>
        static void PruneBackups(string root, int keep)
        {
            try
            {
                string[] dirs = Directory.GetDirectories(root);
                Array.Sort(dirs, StringComparer.OrdinalIgnoreCase);
                for (int i = 0; i < dirs.Length - keep; i++)
                {
                    try { Directory.Delete(dirs[i], true); } catch { }
                }
            }
            catch { }
        }

        /// <summary>把内嵌的 payload.zip 解到安装目录</summary>
        static void ExtractPayload(Action<string> log)
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            using (Stream s = asm.GetManifestResourceStream(PAYLOAD_RES))
            {
                if (s == null) throw new Exception("安装包损坏：找不到内嵌的程序数据");
                using (ZipArchive zip = new ZipArchive(s, ZipArchiveMode.Read))
                {
                    int total = zip.Entries.Count, done = 0;
                    // 覆盖安装时偶尔会有文件还占着（服务刚停、系统还在释放句柄）。
                    // 收集起来最后一起报，别让用户看到一个没头没尾的失败。
                    List<string> locked = new List<string>();
                    List<string> guarded = new List<string>();
                    foreach (ZipArchiveEntry e in zip.Entries)
                    {
                        string rel = e.FullName.Replace('/', Path.DirectorySeparatorChar);
                        string target = Path.Combine(installDir, rel);

                        // 用户数据目录一律不碰。
                        // 打安装包时本来就不该带 data/，但这是「丢数据」级别的事故，
                        // 不能只靠打包脚本自觉 —— 在这里设一道硬闸：
                        // 包里就算混进了 data\pms.db，也绝不覆盖用户正在用的库。
                        string relNorm = rel.Replace('\\', '/').TrimStart('/');
                        if (IsUserDataPath(relNorm)) { guarded.Add(relNorm); continue; }

                        // 防目录穿越
                        if (!Path.GetFullPath(target).StartsWith(Path.GetFullPath(installDir), StringComparison.OrdinalIgnoreCase))
                            continue;

                        if (rel.EndsWith(Path.DirectorySeparatorChar.ToString()) || e.Name.Length == 0)
                        {
                            Directory.CreateDirectory(target);
                        }
                        else
                        {
                            Directory.CreateDirectory(Path.GetDirectoryName(target));
                            try
                            {
                                e.ExtractToFile(target, true);
                            }
                            catch (IOException)
                            {
                                // 等一下再试一次：多半是刚被 kill 的进程还没完全释放
                                System.Threading.Thread.Sleep(400);
                                try { e.ExtractToFile(target, true); }
                                catch (Exception ex2) { locked.Add(Path.GetFileName(target) + "（" + ex2.GetType().Name + "）"); }
                            }
                            catch (UnauthorizedAccessException ex)
                            {
                                locked.Add(Path.GetFileName(target) + "（" + ex.GetType().Name + "）");
                            }
                        }
                        done++;
                        if (log != null && done % 5 == 0) log("解压中… " + done + "/" + total);
                    }
                    if (guarded.Count > 0 && log != null)
                        log("已跳过安装包内的 " + guarded.Count + " 个用户数据文件（不覆盖现有数据）");
                    if (locked.Count > 0)
                    {
                        throw new Exception(
                            "有 " + locked.Count + " 个文件被占用，没能覆盖：\n  " + string.Join("\n  ", locked.ToArray())
                            + "\n\n请先停止本系统（开始菜单 →「停止服务」，或任务管理器结束 node.exe），然后重新运行安装程序。\n"
                            + "你的数据（data 目录）不受影响。");
                    }
                }
            }
        }

        /// <summary>
        /// 判断 payload 里的路径是否属于「用户数据」或「用户备份」，这些一律不覆盖。
        /// data 是业务库和附件，backup 是历史备份 —— 两者都是卸载时也要保留的东西，
        /// 安装时自然更没有理由去覆盖。
        /// </summary>
        static bool IsUserDataPath(string rel)
        {
            if (rel.Length == 0) return false;
            foreach (string dir in new string[] { "data", "backup" })
            {
                if (rel.Equals(dir, StringComparison.OrdinalIgnoreCase)) return true;
                if (rel.StartsWith(dir + "/", StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        /// <summary>生成后台启动器 / 停止脚本 / 打开入口</summary>
        static void WriteLaunchers()
        {
            string node = Path.Combine(installDir, "node.exe");
            string appDir = Path.Combine(installDir, "app");
            string dataDir = Path.Combine(installDir, "data");
            string server = Path.Combine(appDir, "server.js");

            // ---- VBS：静默后台启动（0 = 不显示窗口）----
            StringBuilder vbs = new StringBuilder();
            vbs.AppendLine("' 后台静默启动服务（双击不会出现黑窗口）");
            vbs.AppendLine("Option Explicit");
            vbs.AppendLine("Dim sh, env, cmd");
            vbs.AppendLine("Set sh = CreateObject(\"WScript.Shell\")");
            vbs.AppendLine("Set env = sh.Environment(\"PROCESS\")");
            vbs.AppendLine("env(\"PMS_DATA_DIR\") = \"" + Vbs(dataDir) + "\"");
            vbs.AppendLine("env(\"PMS_PORT\") = \"" + PORT + "\"");
            vbs.AppendLine("sh.CurrentDirectory = \"" + Vbs(appDir) + "\"");
            vbs.AppendLine("cmd = \"\"\"\" & \"" + Vbs(node) + "\" & \"\"\" --no-warnings \"\"\" & \"" + Vbs(server) + "\" & \"\"\" --port " + PORT + "\"");
            vbs.AppendLine("sh.Run cmd, 0, False");
            File.WriteAllText(Path.Combine(installDir, "后台启动.vbs"), vbs.ToString(), Encoding.Default);

            // ---- 启动.bat（想看着窗口时用）----
            StringBuilder bat = new StringBuilder();
            bat.AppendLine("@echo off");
            bat.AppendLine("title " + APP_NAME);
            bat.AppendLine("cd /d \"%~dp0\"");
            bat.AppendLine("if not exist \"data\" mkdir \"data\"");
            bat.AppendLine("if not exist \"backup\" mkdir \"backup\"");
            bat.AppendLine("echo.");
            bat.AppendLine("echo   本机地址： http://127.0.0.1:" + PORT);
            bat.AppendLine("echo   关闭本窗口即停止服务");
            bat.AppendLine("echo.");
            bat.AppendLine("start \"\" cmd /c \"timeout /t 2 /nobreak >nul && start http://127.0.0.1:" + PORT + "\"");
            bat.AppendLine("set \"PMS_DATA_DIR=%~dp0data\"");
            bat.AppendLine("\"%~dp0node.exe\" --no-warnings \"%~dp0app\\server.js\" --port " + PORT);
            bat.AppendLine("echo.");
            bat.AppendLine("echo   服务已停止。按任意键关闭窗口。");
            bat.AppendLine("pause >nul");
            File.WriteAllText(Path.Combine(installDir, "启动系统.bat"), bat.ToString(), Encoding.Default);

            // ---- 停止.bat ----
            StringBuilder stop = new StringBuilder();
            stop.AppendLine("@echo off");
            stop.AppendLine("cd /d \"%~dp0\"");
            stop.AppendLine("echo 正在停止服务…");
            stop.AppendLine("for /f \"tokens=5\" %%a in ('netstat -ano ^| findstr \":\" ^| findstr LISTENING ^| findstr :" + PORT + "\"') do (");
            stop.AppendLine("  taskkill /f /pid %%a >nul 2>&1");
            stop.AppendLine(")");
            stop.AppendLine("echo 已停止。");
            stop.AppendLine("timeout /t 2 >nul");
            File.WriteAllText(Path.Combine(installDir, "停止服务.bat"), stop.ToString(), Encoding.Default);

            // ---- 打开系统.vbs ----
            // 桌面图标和开始菜单的「打开系统」都指到这里。
            // 和「后台启动.vbs」的分工：
            //   后台启动.vbs —— 只起服务，不开浏览器（开机自启、IT 手工拉起用它）
            //   打开系统.vbs —— 人双击的那种：起完服务自动把浏览器打开
            File.WriteAllText(Path.Combine(installDir, "打开系统.vbs"),
                Crlf(OPEN_VBS.Replace("@PORT@", PORT.ToString()).TrimStart('\r', '\n')),
                Encoding.Default);
        }

        /// <summary>
        /// 统一成 CRLF。
        /// 模板写在源码里，检出时的换行风格取决于 git 配置；WScript 对混合换行
        /// 的容忍度不稳，宁可在写文件时规整一遍。
        /// </summary>
        static string Crlf(string s)
        {
            return s.Replace("\r\n", "\n").Replace("\n", "\r\n");
        }

        static string Vbs(string s) { return s.Replace("\"", "\"\""); }

        static void CreateShortcuts()
        {
            string wscript = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "wscript.exe");
            // 某些系统 wscript 在 System32 下不在 System 目录，兜一下
            if (!File.Exists(wscript)) wscript = Path.Combine(Environment.SystemDirectory, "wscript.exe");

            string openVbs = Path.Combine(installDir, "打开系统.vbs");
            string serveVbs = Path.Combine(installDir, "后台启动.vbs");
            string icon = AppIcon();
            string startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), APP_SHORT);

            MakeShortcut(Path.Combine(installDir, "打开系统.lnk"), wscript, "\"" + openVbs + "\"", installDir, "打开 " + APP_SHORT, icon);
            MakeShortcut(Path.Combine(installDir, "启动服务.lnk"), wscript, "\"" + serveVbs + "\"", installDir, "启动 " + APP_SHORT, icon);
            MakeUrlShortcut(Path.Combine(installDir, "打开系统.url"), "http://127.0.0.1:" + PORT);

            if (!Directory.Exists(startMenu)) Directory.CreateDirectory(startMenu);
            // 主入口放最上面：起服务 + 自动开浏览器，一个图标解决
            MakeShortcut(Path.Combine(startMenu, "打开系统.lnk"), wscript, "\"" + openVbs + "\"", installDir, "打开 " + APP_SHORT, icon);
            MakeShortcut(Path.Combine(startMenu, "启动服务.lnk"), wscript, "\"" + serveVbs + "\"", installDir, "启动 " + APP_SHORT, icon);
            MakeShortcut(Path.Combine(startMenu, "停止服务.lnk"), Path.Combine(installDir, "停止服务.bat"), "", installDir, "停止 " + APP_SHORT, icon);
            MakeUrlShortcut(Path.Combine(startMenu, "打开系统.url"), "http://127.0.0.1:" + PORT);
            MakeShortcut(Path.Combine(startMenu, "卸载.lnk"), Path.Combine(installDir, "卸载.exe"), "/uninstall", installDir, "卸载 " + APP_SHORT, null);

            if (!noDesktop)
            {
                // 桌面上只放一个图标。
                // 以前是 .lnk（只起服务，不弹网页）+ .url（只开网页）两个，
                // 用户分不清该点哪个，点了 .lnk 又没任何反应 —— 现在合成一个。
                string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                MakeShortcut(Path.Combine(desktop, APP_SHORT + ".lnk"), wscript, "\"" + openVbs + "\"", installDir, "打开 " + APP_SHORT, icon);
                OldDesktopUrlCleanup(desktop);
            }
        }

        /// <summary>
        /// 清掉旧版本留在桌面的「xxx（打开）.url」。
        /// 留着它就等于把「点错图标」这件事永久留在用户桌面上。
        /// </summary>
        static void OldDesktopUrlCleanup(string desktop)
        {
            try
            {
                string stale = Path.Combine(desktop, APP_SHORT + "（打开）.url");
                if (File.Exists(stale)) File.Delete(stale);
            }
            catch { }
        }

        /// <summary>
        /// 快捷方式用哪个图标。
        /// 以前一律用 node.exe 的图标 —— 桌面上一排绿油油的 Node 标志，
        /// 谁看都不像是「项目管理系统」。安装包里带了 app.ico 就该用上。
        /// </summary>
        static string AppIcon()
        {
            string ico = Path.Combine(installDir, "app.ico");
            if (File.Exists(ico)) return ico;
            string un = Path.Combine(installDir, "卸载.exe");
            if (File.Exists(un)) return un;
            return Path.Combine(installDir, "node.exe");
        }

        static void MakeShortcut(string lnkPath, string target, string arguments, string workDir, string desc, string icon)
        {
            try
            {
                Type t = Type.GetTypeFromProgID("WScript.Shell");
                object sh = Activator.CreateInstance(t);
                object lnk = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, sh, new object[] { lnkPath });
                Type lt = lnk.GetType();
                lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { target });
                if (arguments != null && arguments.Length > 0)
                    lt.InvokeMember("Arguments", BindingFlags.SetProperty, null, lnk, new object[] { arguments });
                lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { workDir });
                if (desc != null) lt.InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { desc });
                if (icon != null && File.Exists(icon))
                    lt.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { icon + ",0" });
                lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
            }
            catch { /* 快捷方式失败不影响主流程 */ }
        }

        static void MakeUrlShortcut(string path, string url)
        {
            try
            {
                using (StreamWriter w = new StreamWriter(path, false, Encoding.Default))
                {
                    w.WriteLine("[InternetShortcut]");
                    w.WriteLine("URL=" + url);
                }
            }
            catch { }
        }

        /// <summary>开机自启：在「启动」文件夹放一个快捷方式，不需要管理员权限</summary>
        static void SetAutoStart(bool on)
        {
            string startup = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
            string link = Path.Combine(startup, APP_SHORT + ".lnk");
            try
            {
                if (on)
                {
                    string wscript = Path.Combine(Environment.SystemDirectory, "wscript.exe");
                    string vbs = Path.Combine(installDir, "后台启动.vbs");
                    MakeShortcut(link, wscript, "\"" + vbs + "\"", installDir, "开机自动启动 " + APP_SHORT, null);
                }
                else if (File.Exists(link)) File.Delete(link);
            }
            catch { }
        }

        /// <summary>
        /// 把自己复制一份成安装目录里的「卸载.exe」。
        ///
        /// 单独拎出来，是因为 CreateShortcuts 要引用这个路径 ——
        /// 首次安装时它还不存在，快捷方式就会指向一个空路径，
        /// 开始菜单里点「卸载」毫无反应（这正是用户报过的问题之一）。
        /// </summary>
        static void CopyUninstaller()
        {
            string self = Assembly.GetExecutingAssembly().Location;
            if (string.IsNullOrEmpty(self)) return;
            string target = Path.Combine(installDir, "卸载.exe");
            if (string.Equals(self, target, StringComparison.OrdinalIgnoreCase)) return;
            for (int i = 0; i < 3; i++)
            {
                try { File.Copy(self, target, true); return; }
                catch
                {
                    // 覆盖安装时上一版卸载程序可能正开着，等它释放句柄
                    Thread.Sleep(300);
                }
            }
        }

        static void RegisterUninstall()
        {
            try
            {
                long size = 0;
                try { size = new FileInfo(Path.Combine(installDir, "卸载.exe")).Length / 1024; } catch { }

                using (RegistryKey k = Registry.CurrentUser.CreateSubKey(REG_UNINSTALL))
                {
                    k.SetValue("DisplayName", APP_NAME);
                    // 版本号不再写死在这里：以前这里固定 2.0.0，
                    // 而 package.json 是 1.1.1，「应用和功能」里显示的版本永远是错的。
                    // 现在由打包脚本按 package.json 生成 BuildInfo。
                    k.SetValue("DisplayVersion", BuildInfo.Version);
                    k.SetValue("Publisher", "本公司");
                    k.SetValue("InstallLocation", installDir);
                    k.SetValue("DisplayIcon", AppIcon());
                    // 带上 /dir=：用户若选了非默认安装位置，卸载也能找到正确的目录
                    string uninst = "\"" + Path.Combine(installDir, "卸载.exe") + "\" /uninstall /dir=\"" + installDir + "\"";
                    k.SetValue("UninstallString", uninst);
                    k.SetValue("QuietUninstallString", uninst + " /silent");
                    k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                    if (size > 0) k.SetValue("EstimatedSize", (int)size, RegistryValueKind.DWord);
                }
            }
            catch { }
        }

        static string WscriptPath()
        {
            string p = Path.Combine(Environment.SystemDirectory, "wscript.exe");
            return File.Exists(p) ? p : "wscript.exe";
        }

        static void StartServer()
        {
            try
            {
                string vbs = Path.Combine(installDir, "后台启动.vbs");
                ProcessStartInfo psi = new ProcessStartInfo(WscriptPath(), "\"" + vbs + "\"");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WorkingDirectory = installDir;
                Process.Start(psi);
            }
            catch { }
        }

        /// <summary>
        /// 这个可执行文件是否属于本安装目录。
        ///
        /// 必须带上路径分隔符再比前缀：只比 "…\ELV-PMS" 的话，
        /// 同级的 "…\ELV-PMS-测试\node.exe"、"…\ELV-PMS-old\node.exe" 都会被算进来，
        /// 装一次新版就把同事电脑上另一套实例杀掉。
        /// </summary>
        static bool IsOurExe(string exe)
        {
            if (string.IsNullOrEmpty(exe)) return false;
            string root = installDir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                          + Path.DirectorySeparatorChar;
            return exe.StartsWith(root, StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>
        /// 停掉本程序启动的服务。
        /// 按「可执行文件路径是否在安装目录下」判断，而不是按端口 ——
        /// 否则会误杀别的程序（比如同事自己起的开发服务）。
        /// </summary>
        static void StopServer()
        {
            try
            {
                foreach (Process p in Process.GetProcessesByName("node"))
                {
                    try
                    {
                        string exe = p.MainModule.FileName;
                        if (IsOurExe(exe)) p.Kill();
                    }
                    catch { /* 拿不到模块信息就跳过（权限或已退出） */ }
                }
            }
            catch { }
            // 等一下让文件句柄释放，否则删目录会失败
            for (int i = 0; i < 10; i++)
            {
                bool alive = false;
                try
                {
                    foreach (Process p in Process.GetProcessesByName("node"))
                    {
                        try
                        {
                            if (IsOurExe(p.MainModule.FileName)) { alive = true; break; }
                        }
                        catch { }
                    }
                }
                catch { }
                if (!alive) break;
                Thread.Sleep(300);
            }
        }

        /* ==================== 卸载 ==================== */
        static int RunUninstallWizard()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            string msg = "确定要卸载「" + APP_NAME + "」吗？\n\n"
                + "程序文件会被删除。\n"
                + "你的业务数据（" + Path.Combine(installDir, "data") + "）会原样保留，请自行备份。";
            if (MessageBox.Show(msg, "卸载 " + APP_SHORT, MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK)
                return 0;
            int r = RunUninstall(null);
            if (r == 0)
            {
                MessageBox.Show("卸载完成。\n\n你的数据还在：\n" + Path.Combine(installDir, "data")
                    + "\n\n以后重新安装，这些数据会自动接上。",
                    "卸载", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            else
            {
                // 以前这里不看结果、一律报「卸载完成」，用户以为删干净了，
                // 其实目录里还躺着一堆文件 —— 这是「卸载有问题」的主要来源。
                MessageBox.Show("程序已从「应用和功能」里移除，但有几个文件正被占用，这次没能删掉。\n\n"
                    + "重启电脑后，双击下面这个文件就能清干净：\n"
                    + Path.Combine(installDir, "重启后清理.bat")
                    + "\n\n你的数据仍在：\n" + Path.Combine(installDir, "data"),
                    "卸载未完全结束", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            return r;
        }

        static int RunUninstall(Action<string> log)
        {
            if (log != null) log("停止服务…");
            StopServer();
            Thread.Sleep(400);

            // 卸载前把库再存一份到 backup 里。
            // 虽然 data 目录本来就保留，但 uninstall 之后常见的下一步是
            // 「装到别的盘」「换台机器」，那时候用户会下意识把整个目录删掉。
            // backup 里有一份独立的库，是最后一道保险。
            BackupDb(log, "卸载前自动备份");

            if (log != null) log("移除开机自启…");
            SetAutoStart(false);
            try
            {
                string startup = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
                foreach (string f in Directory.GetFiles(startup, "*" + APP_SHORT + "*.lnk"))
                    try { File.Delete(f); } catch { }
            }
            catch { }

            if (log != null) log("删除快捷方式…");
            try
            {
                string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                foreach (string pat in new string[] { APP_SHORT + ".lnk", APP_SHORT + "（打开）.url" })
                {
                    string p = Path.Combine(desktop, pat);
                    if (File.Exists(p)) File.Delete(p);
                }
                string sm = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), APP_SHORT);
                if (Directory.Exists(sm)) Directory.Delete(sm, true);
            }
            catch { }

            if (log != null) log("清理注册表…");
            try { Registry.CurrentUser.DeleteSubKeyTree(REG_UNINSTALL, false); } catch { }

            if (log != null) log("删除程序文件（保留 data 与 backup）…");
            // 不能静默吞掉失败：卸载删不干净是最让人恼火的问题。
            // 把删不掉的记下来，最后报给用户。
            System.Collections.Generic.List<string> blocked = new System.Collections.Generic.List<string>();
            try
            {
                foreach (string dir in Directory.GetDirectories(installDir))
                {
                    string name = Path.GetFileName(dir);
                    if (name.Equals("data", StringComparison.OrdinalIgnoreCase)) continue;
                    if (name.Equals("backup", StringComparison.OrdinalIgnoreCase)) continue;
                    if (!TryDeleteDir(dir)) blocked.Add(name + "\\");
                }
                foreach (string f in Directory.GetFiles(installDir))
                {
                    string name = Path.GetFileName(f);
                    if (name.Equals("卸载.exe", StringComparison.OrdinalIgnoreCase)) continue;
                    if (!TryDeleteFile(f)) blocked.Add(name);
                }
            }
            catch (Exception ex) { blocked.Add("(" + ex.Message + ")"); }

            if (blocked.Count > 0)
            {
                if (log != null) log("以下项目删不掉（可能正被占用）：" + string.Join("、", blocked.ToArray()));
                // 留个批处理，重启后能删干净。
                // 提示统一交给调用方给，这里再弹一次的话，向导模式会连弹两个框。
                WriteCleanupScript(blocked);
            }

            if (log != null) log(blocked.Count > 0 ? "完成（有残留文件）" : "完成");
            // 卸载程序自己延迟删除
            ScheduleSelfDelete();
            // 2 = 已经从系统里摘掉了，但目录里还有删不掉的文件。
            // 调用方必须能区分这个状态 —— 以前不管成败都返回 0，
            // 向导就一律报「卸载完成」，用户以为删干净了。
            return blocked.Count > 0 ? 2 : 0;
        }

        /// <summary>删除失败时留一个「重启后清理.bat」，用户开机点一下就能清干净</summary>
        static void WriteCleanupScript(System.Collections.Generic.List<string> blocked)
        {
            try
            {
                StringBuilder sb = new StringBuilder();
                sb.AppendLine("@echo off");
                sb.AppendLine("title 清理未删除的文件");
                sb.AppendLine("cd /d \"%~dp0\"");
                sb.AppendLine("echo 正在清理以下内容：");
                foreach (string b in blocked) sb.AppendLine("echo   " + b);
                sb.AppendLine("echo.");
                sb.AppendLine("for /d %%i in (*) do (");
                sb.AppendLine("  if /i not \"%%i\"==\"data\" if /i not \"%%i\"==\"backup\" rd /s /q \"%%i\" 2>nul");
                sb.AppendLine(")");
                sb.AppendLine("for %%i in (*) do (");
                sb.AppendLine("  if /i not \"%%i\"==\"重启后清理.bat\" del /f /q \"%%i\" 2>nul");
                sb.AppendLine(")");
                sb.AppendLine("echo 清理完成。");
                sb.AppendLine("timeout /t 3 >nul");
                sb.AppendLine("del /f /q \"%~f0\"");
                File.WriteAllText(Path.Combine(installDir, "重启后清理.bat"), sb.ToString(), Encoding.Default);
            }
            catch { }
        }

        static bool TryDeleteDir(string path)
        {
            try { Directory.Delete(path, true); return !Directory.Exists(path); }
            catch { return false; }
        }

        static bool TryDeleteFile(string path)
        {
            try
            {
                // 清掉只读属性再删（node.exe 有时会被标记只读）
                FileAttributes a = File.GetAttributes(path);
                if ((a & FileAttributes.ReadOnly) == FileAttributes.ReadOnly)
                    File.SetAttributes(path, a & ~FileAttributes.ReadOnly);
                File.Delete(path);
                return !File.Exists(path);
            }
            catch { return false; }
        }

        /// <summary>
        /// 卸载程序自删（正在运行的 exe 不能删自己，只能交给外部进程）。
        ///
        /// 老实现两个毛病：
        ///   1. 用 ping -n 3 只等 2 秒。卸完还要弹 MessageBox 告诉用户结果，
        ///      那会儿进程还活着、文件还占着，del 必然失败 —— 于是每次卸载
        ///      都会在目录里剩一个卸载.exe，看起来就是「没删干净」。
        ///   2. 末尾直接 rmdir 安装目录。data / backup 是刻意保留的，
        ///      这个 rmdir 永远失败，纯属噪音。
        /// 现在改成：循环重试最多 15 次（每次 2 秒），删掉就收工。
        /// </summary>
        static void ScheduleSelfDelete()
        {
            try
            {
                string self = Assembly.GetExecutingAssembly().Location;
                if (!Path.GetFileName(self).Equals("卸载.exe", StringComparison.OrdinalIgnoreCase)) return;

                StringBuilder sb = new StringBuilder();
                sb.AppendLine("@echo off");
                sb.AppendLine("setlocal");
                sb.AppendLine("for /l %%i in (1,1,15) do (");
                sb.AppendLine("  if not exist \"" + self + "\" goto done");
                sb.AppendLine("  ping 127.0.0.1 -n 2 >nul");
                sb.AppendLine("  del /f /q \"" + self + "\" >nul 2>&1");
                sb.AppendLine(")");
                sb.AppendLine(":done");
                // 只有在 data / backup 也没了的情况下才删得掉，删不掉是正常的
                sb.AppendLine("rmdir \"" + installDir + "\" >nul 2>&1");
                sb.AppendLine("del /f /q \"%~f0\" >nul 2>&1");

                string bat = Path.Combine(Path.GetTempPath(), "elv-pms-selfdel.bat");
                File.WriteAllText(bat, sb.ToString(), Encoding.Default);

                ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c \"" + bat + "\"");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                Process.Start(psi);
            }
            catch { }
        }

        /* ==================== 界面 ==================== */
        public class SetupForm : Form
        {
            public int ExitCode = 0;
            TextBox dirBox;
            CheckBox desktopChk, autoChk;
            Button nextBtn, cancelBtn;
            Panel page1, page2, page3;
            ProgressBar bar;
            Label statusLabel, doneLabel;
            TextBox logBox;

            public SetupForm()
            {
                Text = APP_NAME + " 安装程序";
                FormBorderStyle = FormBorderStyle.FixedDialog;
                MaximizeBox = false; MinimizeBox = false;
                StartPosition = FormStartPosition.CenterScreen;
                ClientSize = new Size(560, 380);
                Font = new Font("Microsoft YaHei UI", 9F);
                BackColor = Color.White;

                BuildPage1(); BuildPage2(); BuildPage3();
                Controls.Add(page3); Controls.Add(page2); Controls.Add(page1);
                ShowPage(1);
            }

            void ShowPage(int n)
            {
                page1.Visible = n == 1; page2.Visible = n == 2; page3.Visible = n == 3;
            }

            Label Head(string text, int top)
            {
                Label l = new Label();
                l.Text = text; l.Font = new Font("Microsoft YaHei UI", 15F, FontStyle.Bold);
                l.ForeColor = Color.FromArgb(15, 23, 42);
                l.AutoSize = true; l.Location = new Point(28, top);
                return l;
            }
            Label Sub(string text, int top, int left, int width)
            {
                Label l = new Label();
                l.Text = text; l.ForeColor = Color.FromArgb(100, 116, 139);
                l.Location = new Point(left, top); l.Size = new Size(width, 40);
                return l;
            }

            void BuildPage1()
            {
                page1 = new Panel(); page1.Dock = DockStyle.Fill; page1.BackColor = Color.White;
                page1.Controls.Add(Head("安装 " + APP_SHORT, 26));
                page1.Controls.Add(Sub("把运行环境和程序一起装好，不需要单独安装 Node.js。\n装完服务会在后台运行，同事用局域网地址就能访问。", 62, 28, 500));

                Label l1 = new Label();
                l1.Text = "安装位置"; l1.Location = new Point(28, 122); l1.AutoSize = true;
                l1.ForeColor = Color.FromArgb(51, 65, 85);
                page1.Controls.Add(l1);

                dirBox = new TextBox();
                dirBox.Location = new Point(28, 144); dirBox.Size = new Size(410, 26);
                dirBox.Text = DefaultDir;
                page1.Controls.Add(dirBox);

                Button browse = new Button();
                browse.Text = "浏览…"; browse.Location = new Point(446, 143); browse.Size = new Size(86, 27);
                browse.Click += delegate
                {
                    using (FolderBrowserDialog fb = new FolderBrowserDialog())
                    {
                        fb.Description = "选择安装位置";
                        if (Directory.Exists(dirBox.Text)) fb.SelectedPath = dirBox.Text;
                        if (fb.ShowDialog() == DialogResult.OK) dirBox.Text = fb.SelectedPath;
                    }
                };
                page1.Controls.Add(browse);

                desktopChk = new CheckBox();
                desktopChk.Text = "创建桌面快捷方式"; desktopChk.Checked = true;
                desktopChk.Location = new Point(28, 190); desktopChk.AutoSize = true;
                page1.Controls.Add(desktopChk);

                autoChk = new CheckBox();
                autoChk.Text = "开机自动启动（推荐，同事随时能访问）"; autoChk.Checked = true;
                autoChk.Location = new Point(28, 216); autoChk.AutoSize = true;
                page1.Controls.Add(autoChk);

                Label tip = new Label();
                tip.Text = "数据会存在 " + Path.Combine(installDir, "data") + " 目录，卸载时会保留。";
                tip.ForeColor = Color.FromArgb(148, 163, 184);
                tip.Location = new Point(28, 250); tip.Size = new Size(500, 40);
                page1.Controls.Add(tip);

                nextBtn = new Button();
                nextBtn.Text = "开始安装"; nextBtn.Size = new Size(100, 32);
                nextBtn.Location = new Point(340, 326);
                nextBtn.BackColor = Color.FromArgb(59, 130, 246); nextBtn.ForeColor = Color.White;
                nextBtn.FlatStyle = FlatStyle.Flat; nextBtn.FlatAppearance.BorderSize = 0;
                nextBtn.Click += delegate { StartInstall(); };
                page1.Controls.Add(nextBtn);

                cancelBtn = new Button();
                cancelBtn.Text = "取消"; cancelBtn.Size = new Size(88, 32);
                cancelBtn.Location = new Point(448, 326);
                cancelBtn.FlatStyle = FlatStyle.Flat;
                cancelBtn.Click += delegate { Close(); };
                page1.Controls.Add(cancelBtn);
            }

            void BuildPage2()
            {
                page2 = new Panel(); page2.Dock = DockStyle.Fill; page2.BackColor = Color.White; page2.Visible = false;
                page2.Controls.Add(Head("正在安装…", 26));
                statusLabel = new Label();
                statusLabel.Text = "准备中"; statusLabel.ForeColor = Color.FromArgb(100, 116, 139);
                statusLabel.Location = new Point(28, 70); statusLabel.AutoSize = true;
                page2.Controls.Add(statusLabel);

                bar = new ProgressBar();
                bar.Location = new Point(28, 96); bar.Size = new Size(504, 12);
                bar.Style = ProgressBarStyle.Marquee;
                page2.Controls.Add(bar);

                logBox = new TextBox();
                logBox.Multiline = true; logBox.ReadOnly = true; logBox.ScrollBars = ScrollBars.Vertical;
                logBox.Location = new Point(28, 122); logBox.Size = new Size(504, 236);
                logBox.BackColor = Color.FromArgb(248, 250, 252); logBox.BorderStyle = BorderStyle.FixedSingle;
                page2.Controls.Add(logBox);
            }

            void BuildPage3()
            {
                page3 = new Panel(); page3.Dock = DockStyle.Fill; page3.BackColor = Color.White; page3.Visible = false;
                page3.Controls.Add(Head("安装完成", 26));
                doneLabel = new Label();
                doneLabel.Location = new Point(28, 70); doneLabel.Size = new Size(504, 130);
                doneLabel.ForeColor = Color.FromArgb(51, 65, 85);
                page3.Controls.Add(doneLabel);

                Button open = new Button();
                open.Text = "打开系统"; open.Size = new Size(110, 34);
                open.Location = new Point(28, 320);
                open.BackColor = Color.FromArgb(59, 130, 246); open.ForeColor = Color.White;
                open.FlatStyle = FlatStyle.Flat; open.FlatAppearance.BorderSize = 0;
                open.Click += delegate
                {
                    try
                    {
                        // 走和桌面图标同一条链路：服务没起就起，起来了再开浏览器。
                        // 直接 Process.Start(url) 的话，服务还没就绪时用户看到的是空白页，
                        // 第一印象就成了「装完打不开」。
                        string vbs = Path.Combine(installDir, "打开系统.vbs");
                        if (File.Exists(vbs))
                            Process.Start(WscriptPath(), "\"" + vbs + "\"");
                        else
                            Process.Start("http://127.0.0.1:" + PORT);
                    }
                    catch { }
                };
                page3.Controls.Add(open);

                Button fin = new Button();
                fin.Text = "关闭"; fin.Size = new Size(88, 34);
                fin.Location = new Point(444, 320);
                fin.FlatStyle = FlatStyle.Flat;
                fin.Click += delegate { Close(); };
                page3.Controls.Add(fin);
            }

            void AppendLog(string s)
            {
                if (logBox.InvokeRequired)
                {
                    logBox.Invoke(new Action<string>(AppendLog), s);
                    return;
                }
                logBox.AppendText(s + "\r\n");
                statusLabel.Text = s;
            }

            void StartInstall()
            {
                installDir = dirBox.Text.Trim();
                noDesktop = !desktopChk.Checked;
                noAutostart = !autoChk.Checked;

                if (installDir.Length == 0) { MessageBox.Show("请选择安装位置"); return; }

                ShowPage(2);
                ThreadPool.QueueUserWorkItem(delegate
                {
                    int rc = 1;
                    try
                    {
                        rc = RunInstall(AppendLog);
                    }
                    catch (Exception ex)
                    {
                        AppendLog("失败：" + ex.Message);
                        rc = 1;
                    }
                    int code = rc;
                    BeginInvoke(new Action(delegate
                    {
                        if (code == 0)
                        {
                            bar.Style = ProgressBarStyle.Continuous;
                            bar.Value = 100;
                            doneLabel.Text =
                                "服务已经装好并在后台运行了。\n\n"
                                + "本机访问：  http://127.0.0.1:" + PORT + "\n"
                                + "同事访问：  用你的局域网 IP + :" + PORT + "（在「系统设置」里能看到所有可用地址）\n\n"
                                + "程序目录：  " + installDir + "\n"
                                + "数据目录：  " + Path.Combine(installDir, "data") + "\n\n"
                                + "以后开机自动启动，桌面也有快捷方式。要卸载就点开始菜单里的「卸载」。";
                            ShowPage(3);
                        }
                        else
                        {
                            MessageBox.Show("安装失败，请看下面的日志。", APP_NAME, MessageBoxButtons.OK, MessageBoxIcon.Error);
                            ShowPage(1);
                        }
                    }));
                });
            }
        }
    }
}
