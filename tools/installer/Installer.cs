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
            if (log != null) log("正在解压程序文件（约 30 秒）…");
            ExtractPayload(log);
            if (log != null) log("正在创建启动器…");
            WriteLaunchers();
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
                    foreach (ZipArchiveEntry e in zip.Entries)
                    {
                        string rel = e.FullName.Replace('/', Path.DirectorySeparatorChar);
                        string target = Path.Combine(installDir, rel);
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
        }

        static string Vbs(string s) { return s.Replace("\"", "\"\""); }

        static void CreateShortcuts()
        {
            string wscript = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "wscript.exe");
            // 某些系统 wscript 在 System32 下不在 System 目录，兜一下
            if (!File.Exists(wscript)) wscript = Path.Combine(Environment.SystemDirectory, "wscript.exe");

            string vbs = Path.Combine(installDir, "后台启动.vbs");
            string icon = Path.Combine(installDir, "node.exe");
            string startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), APP_SHORT);

            // 启动服务
            MakeShortcut(Path.Combine(installDir, "启动服务.lnk"), wscript, "\"" + vbs + "\"", installDir, "启动 " + APP_SHORT, icon);
            // 打开网页
            MakeUrlShortcut(Path.Combine(installDir, "打开系统.url"), "http://127.0.0.1:" + PORT);

            if (!Directory.Exists(startMenu)) Directory.CreateDirectory(startMenu);
            MakeShortcut(Path.Combine(startMenu, "启动服务.lnk"), wscript, "\"" + vbs + "\"", installDir, "启动 " + APP_SHORT, icon);
            MakeShortcut(Path.Combine(startMenu, "停止服务.lnk"), Path.Combine(installDir, "停止服务.bat"), "", installDir, "停止 " + APP_SHORT, icon);
            MakeUrlShortcut(Path.Combine(startMenu, "打开系统.url"), "http://127.0.0.1:" + PORT);
            MakeShortcut(Path.Combine(startMenu, "卸载.lnk"), Path.Combine(installDir, "卸载.exe"), "/uninstall", installDir, "卸载 " + APP_SHORT, null);

            if (!noDesktop)
            {
                string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                MakeShortcut(Path.Combine(desktop, APP_SHORT + ".lnk"), wscript, "\"" + vbs + "\"", installDir, "启动 " + APP_SHORT, icon);
                MakeUrlShortcut(Path.Combine(desktop, APP_SHORT + "（打开）.url"), "http://127.0.0.1:" + PORT);
            }
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

        static void RegisterUninstall()
        {
            try
            {
                // 把自己复制一份作为卸载程序
                string self = Assembly.GetExecutingAssembly().Location;
                string target = Path.Combine(installDir, "卸载.exe");
                if (!string.Equals(self, target, StringComparison.OrdinalIgnoreCase))
                {
                    try { File.Copy(self, target, true); } catch { }
                }
                long size = 0;
                try { size = new FileInfo(target).Length / 1024; } catch { }

                using (RegistryKey k = Registry.CurrentUser.CreateSubKey(REG_UNINSTALL))
                {
                    k.SetValue("DisplayName", APP_NAME);
                    k.SetValue("DisplayVersion", "2.0.0");
                    k.SetValue("Publisher", "本公司");
                    k.SetValue("InstallLocation", installDir);
                    k.SetValue("DisplayIcon", Path.Combine(installDir, "node.exe"));
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
                        if (exe != null && exe.StartsWith(installDir, StringComparison.OrdinalIgnoreCase))
                            p.Kill();
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
                            string exe = p.MainModule.FileName;
                            if (exe != null && exe.StartsWith(installDir, StringComparison.OrdinalIgnoreCase)) { alive = true; break; }
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
            MessageBox.Show(r == 0 ? "卸载完成。\n\n数据目录已保留：" + Path.Combine(installDir, "data") : "卸载过程中出现问题。",
                "卸载", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return r;
        }

        static int RunUninstall(Action<string> log)
        {
            if (log != null) log("停止服务…");
            StopServer();
            Thread.Sleep(400);

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
                if (log != null) log("以下项目删不掉（可能正在被占用）：" + string.Join("、", blocked.ToArray()));
                if (!silent && Environment.UserInteractive)
                {
                    MessageBox.Show(
                        "这些文件没能删掉：\n\n" + string.Join("\n", blocked.ToArray())
                        + "\n\n常见原因是服务还在运行。可以重启电脑后再删一次，"
                        + "或者手动删除目录：\n" + installDir,
                        "卸载", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
                // 留个批处理，重启后能删干净
                WriteCleanupScript(blocked);
            }

            if (log != null) log("完成");
            // 卸载程序自己延迟删除
            ScheduleSelfDelete();
            return 0;
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

        static void ScheduleSelfDelete()
        {
            try
            {
                string self = Assembly.GetExecutingAssembly().Location;
                if (!Path.GetFileName(self).Equals("卸载.exe", StringComparison.OrdinalIgnoreCase)) return;
                ProcessStartInfo psi = new ProcessStartInfo("cmd.exe",
                    "/c ping 127.0.0.1 -n 3 >nul & del /f /q \"" + self + "\" & rmdir \"" + installDir + "\" 2>nul");
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
                    try { Process.Start("http://127.0.0.1:" + PORT); } catch { }
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
