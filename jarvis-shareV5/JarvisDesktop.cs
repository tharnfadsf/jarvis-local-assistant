using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Management;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        bool created;
        using (Mutex mutex = new Mutex(true, "Local\\JARVIS.Desktop.Singleton", out created))
        {
            if (!created) return;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            bool background = Array.Exists(Environment.GetCommandLineArgs(), delegate(string arg) { return String.Equals(arg, "--background", StringComparison.OrdinalIgnoreCase); });
            Application.Run(new JarvisTrayHost(background));
        }
    }
}

internal sealed class JarvisTrayHost : ApplicationContext
{
    private readonly string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    private readonly string appData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "JARVIS");
    private readonly string logDir;
    private readonly string logFile;
    private readonly string edgeProfile;
    private readonly string portFile;
    private readonly string startupDisabledFlag;
    private readonly string startupLink = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "JARVIS.lnk");
    private readonly NotifyIcon tray;
    private readonly ToolStripMenuItem startupItem;
    private readonly System.Windows.Forms.Timer healthTimer;
    private readonly System.Windows.Forms.Timer pttRefreshTimer;
    // UI-independent bridge watchdog: a System.Threading.Timer of the same
    // cadence as healthTimer, so a stalled or hung UI thread can never stop
    // bridge recovery - the observed failure mode is a silent bridge death
    // that nothing notices for many minutes. A guarded heartbeat line dates
    // this host's own freezes in the log.
    private readonly System.Threading.Timer recoveryWatchdog;
    private int watchdogBusy;
    private int watchdogTicks;
    private Process bridge;
    private PttHotkey pttHotkey;

    private PttChannel pttChannel;
    private string nodePath;
    private string edgePath;
    private string instanceId;
    private int port;
    private bool exiting;

    internal JarvisTrayHost(bool backgroundLaunch)
    {
        logDir = Path.Combine(appData, "logs");
        logFile = Path.Combine(logDir, "desktop.log");
        edgeProfile = Path.Combine(appData, "EdgeProfile");
        portFile = Path.Combine(appData, "bridge-port.txt");
        startupDisabledFlag = Path.Combine(appData, "startup-disabled.flag");
        Directory.CreateDirectory(logDir);
        Directory.CreateDirectory(edgeProfile);
        nodePath = FindNode();
        edgePath = FindEdge();
        using (SHA256 sha = SHA256.Create())
            instanceId = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(root.ToLowerInvariant()))).Replace("-", "").Substring(0, 20);

        ContextMenuStrip menu = new ContextMenuStrip();
        ToolStripMenuItem open = new ToolStripMenuItem("Open J.A.R.V.I.S.");
        open.Click += delegate { RestoreWindow(); };
        startupItem = new ToolStripMenuItem("Launch when I sign in");
        startupItem.CheckOnClick = true;
        startupItem.Checked = File.Exists(startupLink);
        startupItem.Click += delegate { SetStartup(startupItem.Checked); };
        ToolStripMenuItem quit = new ToolStripMenuItem("Quit J.A.R.V.I.S.");
        quit.Click += delegate { ExitApplication(); };
        menu.Items.Add(open);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(startupItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(quit);

        string iconPath = Path.Combine(root, "jarvis.ico");
        Icon icon = File.Exists(iconPath) ? new Icon(iconPath) : SystemIcons.Application;
        tray = new NotifyIcon();
        tray.Icon = icon;
        tray.Text = "J.A.R.V.I.S. is starting";
        tray.ContextMenuStrip = menu;
        tray.Visible = true;
        tray.DoubleClick += delegate { RestoreWindow(); };

        healthTimer = new System.Windows.Forms.Timer();
        healthTimer.Interval = 5000;
        healthTimer.Tick += delegate { CheckAndRecoverBridge(); };

        // Re-register the system-wide keyboard hook every five minutes. The
        // refresh runs on the UI thread, which owns the message loop the hook
        // needs; doing it from the bridge watchdog thread would install a hook
        // on a thread that never dispatches its events.
        pttRefreshTimer = new System.Windows.Forms.Timer();
        // The initial hook is installed before Application.Run starts pumping
        // messages. On this host that hook can be inert until it is reinstalled
        // on the UI thread, so the first tick is deliberately quick. After
        // that, refresh often enough that a hook Windows silently removes
        // (LowLevelHooksTimeout) can never leave push-to-talk dead for minutes.
        pttRefreshTimer.Interval = 750;
        pttRefreshTimer.Tick += delegate
        {
            try { if (pttHotkey != null) pttHotkey.Refresh(); } catch { }
            try { pttRefreshTimer.Interval = 30000; } catch { }
        };

        if (nodePath == null)
        {
            Log("Node.js was not found. Install Node.js or run JARVIS from the Codex desktop runtime.");
            MessageBox.Show("JARVIS needs Node.js to run its local computer-control bridge. Install Node.js, then restart JARVIS.", "J.A.R.V.I.S. startup error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            ExitApplication();
            return;
        }
        if (edgePath == null)
        {
            Log("Microsoft Edge was not found.");
            MessageBox.Show("Microsoft Edge is needed to display the dedicated JARVIS app window.", "J.A.R.V.I.S. startup error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            ExitApplication();
            return;
        }
        if (!StartBridge())
        {
            MessageBox.Show("JARVIS could not start its local bridge. See the local logs in %LOCALAPPDATA%\\JARVIS\\logs.", "J.A.R.V.I.S. startup error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            ExitApplication();
            return;
        }
        if (File.Exists(startupLink)) EnsureBackgroundShortcut();
        else if (!File.Exists(startupDisabledFlag)) SetStartup(true);
        OpenAppWindow();
        InstallMinimizeToTray();
        if (backgroundLaunch) HideAfterStartup();
        healthTimer.Start();
        pttRefreshTimer.Start();
        // Same cadence, off the UI thread: recovery survives a stalled UI.
        recoveryWatchdog = new System.Threading.Timer(delegate { CheckAndRecoverBridge(); }, null, 5000, 5000);
        Log("Desktop tray host started.");
    }

    private static string FindNode()
    {
        try
        {
            string path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string part in path.Split(Path.PathSeparator))
            {
                string candidate = Path.Combine(part.Trim('"'), "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
        }
        catch { }
        string[] fixedPaths = {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe")
        };
        foreach (string candidate in fixedPaths) if (File.Exists(candidate)) return candidate;
        try
        {
            string runtime = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cache", "codex-runtimes");
            if (Directory.Exists(runtime))
                foreach (string candidate in Directory.GetFiles(runtime, "node.exe", SearchOption.AllDirectories)) return candidate;
        }
        catch { }
        return null;
    }

    private static string FindEdge()
    {
        string[] paths = {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe")
        };
        foreach (string path in paths) if (File.Exists(path)) return path;
        return null;
    }

    private void Log(string message)
    {
        try { File.AppendAllText(logFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss ") + message + Environment.NewLine, Encoding.UTF8); }
        catch { }
    }

    private int GetFreePort()
    {
        TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start(); int result = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop(); return result;
    }

    private bool IsPortAvailable(int candidate)
    {
        TcpListener listener = null;
        try { listener = new TcpListener(IPAddress.Loopback, candidate); listener.Start(); return true; }
        catch { return false; }
        finally { if (listener != null) listener.Stop(); }
    }

    private int GetStablePort()
    {
        int saved;
        if (File.Exists(portFile) && Int32.TryParse(File.ReadAllText(portFile).Trim(), out saved) && saved > 1024 && saved < 65536)
        {
            if (IsPortAvailable(saved)) return saved;
            if (StopOrphanBridge(saved)) return saved;
        }
        return GetFreePort();
    }

    private bool StopOrphanBridge(int savedPort)
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + savedPort + "/api/health");
            request.Timeout = 1200; request.Proxy = null;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream()))
            {
                string json = reader.ReadToEnd();
                if (!json.Contains("\"instance\":\"" + instanceId + "\"")) return false;
                Match match = Regex.Match(json, "\\\"pid\\\"\\s*:\\s*(\\d+)");
                int pid;
                if (!match.Success || !Int32.TryParse(match.Groups[1].Value, out pid) || pid == Process.GetCurrentProcess().Id) return false;
                Process.GetProcessById(pid).Kill();
            }
            for (int wait = 0; wait < 20; wait++) { if (IsPortAvailable(savedPort)) return true; Thread.Sleep(150); }
        }
        catch { }
        return false;
    }

    private bool IsBridgeHealthy()
    {
        if (bridge == null || bridge.HasExited || port == 0) return false;
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/health");
            request.Timeout = 1800; request.Proxy = null;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream()))
            {
                string json = reader.ReadToEnd();
                return response.StatusCode == HttpStatusCode.OK && json.Contains("\"online\":true") && json.Contains("\"instance\":\"" + instanceId + "\"") && Regex.IsMatch(json, "\\\"pid\\\"\\s*:\\s*" + bridge.Id + "(?:\\D|$)");
            }
        }
        catch { return false; }
    }

    private bool StartBridge()
    {
        if (bridge != null && !bridge.HasExited && IsBridgeHealthy()) return true;
        StopBridge();
        port = GetStablePort();
        for (int attempt = 1; attempt <= 3; attempt++)
        {
            ProcessStartInfo info = new ProcessStartInfo(nodePath, "server.js");
            info.WorkingDirectory = root;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.EnvironmentVariables["JARVIS_PORT"] = port.ToString();
            info.EnvironmentVariables["JARVIS_INSTANCE"] = instanceId;
            // The bridge watches this PID and exits when the host is gone, so a
            // force-killed host can never leave an orphan backend behind.
            info.EnvironmentVariables["JARVIS_PARENT_PID"] = Process.GetCurrentProcess().Id.ToString();
            try
            {
                bridge = new Process(); bridge.StartInfo = info;
                bridge.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) Log("bridge: " + e.Data); };
                bridge.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) Log("bridge error: " + e.Data); };

                bridge.Start(); bridge.BeginOutputReadLine(); bridge.BeginErrorReadLine();

                for (int retry = 0; retry < 25; retry++)
                {
                    Thread.Sleep(300);
                    if (IsBridgeHealthy()) { File.WriteAllText(portFile, port.ToString()); tray.Text = "J.A.R.V.I.S. is running"; Log("Bridge healthy at 127.0.0.1:" + port + " (PID " + bridge.Id + ")."); EnsurePttHotkey(); return true; }
                    if (bridge.HasExited) break;
                }
                Log("Bridge startup attempt " + attempt + " failed.");
            }
            catch (Exception error) { Log("Bridge startup error: " + error.Message); }
            StopBridge();
            port = GetFreePort();
        }
        tray.Text = "J.A.R.V.I.S. bridge is offline";
        return false;
    }

    // PUSH-TO-TALK GLOBAL HOTKEY (2026-10-21). The key handler lives in the
    // page, so it only ever saw key events while the JARVIS window had focus.
    // This installs a system-wide keyboard hook and forwards the press and
    // release of the configured key to the bridge, where the page picks them
    // up - so push-to-talk works from any application.
    // MINIMIZE TO TRAY (2026-10-21). A minimized Edge window counts as
    // occluded: the browser throttles the page's timers and suspends the audio
    // context, so the microphone and push-to-talk stop working while the
    // window sits in the taskbar. Converting a minimize into a hide keeps the
    // page alive - the window leaves the taskbar and the tray icon brings it
    // back, exactly like the in-app minimize-to-tray button.
    private delegate void WinEventDelegate(IntPtr hWin, uint eventType, IntPtr hwnd, int idObject, int idChild, uint dwEventTime, uint dwMSEC);
    [DllImport("user32.dll")] private static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr hmodWinEventProc, WinEventDelegate lpfnWinEventProc, uint idProcess, uint idThread, uint dwFlags);
    [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hWinEvent);

    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hWnd, int command);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [StructLayout(LayoutKind.Sequential)]
    private struct WindowPoint { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct WindowRect { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    private struct WindowPlacement { public int Length; public int Flags; public int ShowCmd; public WindowPoint MinPosition; public WindowPoint MaxPosition; public WindowRect NormalPosition; }
    [DllImport("user32.dll")] private static extern bool GetWindowPlacement(IntPtr hWnd, ref WindowPlacement placement);
    [DllImport("user32.dll")] private static extern bool SetWindowPlacement(IntPtr hWnd, ref WindowPlacement placement);
    private WinEventDelegate winEventProc;
    private IntPtr winEventHook = IntPtr.Zero;

    private void InstallMinimizeToTray()
    {
        try
        {
            winEventProc = delegate(IntPtr hWin, uint eventType, IntPtr hwnd, int idObject, int idChild, uint dwEventTime, uint dwMSEC)
            {
                if (eventType != 0x0016) return;            // EVENT_SYSTEM_MINIMIZESTART
                IntPtr jarvis = JarvisWindow.FindWindow();
                if (jarvis == IntPtr.Zero || hwnd != jarvis) return;
                // AUTO-MINIMIZE REMOVED (2026-10-22). The user asked for this
                // to stop: the window vanished from the taskbar the moment it
                // was minimized, which read as "JARVIS keeps minimizing
                // itself". Edge is already launched with background throttling
                // disabled, so the microphone and push-to-talk keep working
                // with the window sitting minimized in the taskbar.
                Log("JARVIS window was minimized - leaving it in the taskbar (auto-hide to tray is off).");
            };
            // EVENT_SYSTEM_MINIMIZESTART, out-of-context, skip this process.
            winEventHook = SetWinEventHook(0x0016, 0x0016, IntPtr.Zero, winEventProc, 0, 0, 0x0002);
        }
        catch (Exception error) { Log("Minimize-to-tray hook could not be installed: " + error.Message); }
    }

    // A minimized Edge window counts as occluded: the browser throttles the
    // page's timers and suspends the audio context, so the microphone and
    // push-to-talk stop working while the window sits in the taskbar. Move a
    // minimized JARVIS window to the tray instead - the page stays alive and
    // audible, and the tray icon brings the window back.
    private void KeepWindowInTray()
    {
        try
        {
            foreach (IntPtr jarvis in JarvisWindow.FindAllWindows())
            {
                // A hidden window is already in the tray; only a visible but
                // minimized one has to be moved there.
                if (!IsIconic(jarvis) || !IsWindowVisible(jarvis)) continue;
                Log("JARVIS window was minimized - moving it to the tray so the microphone and push-to-talk keep working.");
                // SetWindowPlacement with SW_HIDE hides a minimized window directly.
                // A restore-then-hide pair is posted to the window's own thread,
                // which is slow to answer while the window is minimized.
                WindowPlacement placement = new WindowPlacement();
                placement.Length = Marshal.SizeOf(typeof(WindowPlacement));
                if (GetWindowPlacement(jarvis, ref placement))
                {
                    placement.ShowCmd = 0;   // SW_HIDE
                    SetWindowPlacement(jarvis, ref placement);
                }
            }
        }
        catch { }
    }

    private void EnsurePttHotkey()
    {
        try
        {
            // Idempotent: the hook is a process-wide keyboard hook, and
            // reinstalling it on every bridge health check published a
            // spurious "release" that cut a live recording short. It is only
            // (re)installed when it is actually missing.
            if (pttHotkey != null) return;
            if (pttChannel == null) { pttChannel = new PttChannel(52215, Log); }
            pttChannel.KeyChanged = delegate(string key) { try { if (pttHotkey != null) pttHotkey.SetKey(key); } catch { } };
            pttHotkey = new PttHotkey(pttChannel, Log);
            pttHotkey.SetKey(pttChannel.KeyName);
            pttHotkey.Start();
        }
        catch (Exception error) { Log("Could not start the global push-to-talk hook: " + error.Message); }
    }

    private void StopBridge()
    {
        if (bridge != null)
        {
            try { if (!bridge.HasExited) { bridge.Kill(); bridge.WaitForExit(3000); Log("Owned bridge process stopped."); } }
            catch (Exception error) { Log("Could not stop bridge cleanly: " + error.Message); }
            bridge.Dispose(); bridge = null;
        }
    }

    private string AppUrl { get { return "http://127.0.0.1:" + port + "/" + (pttChannel != null && pttChannel.Port > 0 ? "?pttport=" + pttChannel.Port : ""); } }

    private void OpenAppWindow()
    {
        if (!IsBridgeHealthy()) { Log("App window not opened because the bridge health check failed."); return; }
        // ONE JARVIS WINDOW ONLY. Two pages would both hold the microphone and
        // both answer, and the user would see a second JARVIS tab appear out of
        // nowhere. An existing window is brought forward instead of opening a
        // new one, and any window left over from an earlier run is closed
        // before the new one is opened.
        if (JarvisWindow.RestoreAny()) { Log("Reused the running JARVIS window instead of opening a second one."); return; }
        JarvisWindow.CloseAll();
        string args = "--app=\"" + AppUrl + "\" --user-data-dir=\"" + edgeProfile + "\" --no-first-run --no-default-browser-check --disable-session-crashed-bubble --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows";
        try
        {
            ProcessStartInfo info = new ProcessStartInfo(edgePath, args); info.UseShellExecute = true;
            Process.Start(info); Log("Opened standalone JARVIS Edge app window.");
            ScheduleDuplicatePrune();
        }
        catch (Exception error) { Log("Could not open app window: " + error.Message); tray.Text = "J.A.R.V.I.S. window failed"; }
    }

    // Edge can still surface a second window (a restored session, or a click on
    // the taskbar icon). Keep exactly one: the newest survives, the rest close.
    private void ScheduleDuplicatePrune()
    {
        try
        {
            System.Windows.Forms.Timer prune = new System.Windows.Forms.Timer();
            prune.Interval = 3000;
            int attempts = 0;
            prune.Tick += delegate
            {
                attempts++;
                try
                {
                    List<IntPtr> windows = JarvisWindow.FindAllWindows();
                    if (windows.Count > 1)
                    {
                        for (int i = 0; i < windows.Count - 1; i++) JarvisWindow.Close(windows[i]);
                        Log("Closed a duplicate JARVIS window - only one may run.");
                    }
                    if (attempts >= 4 || windows.Count <= 1) { prune.Stop(); prune.Dispose(); }
                }
                catch { prune.Stop(); prune.Dispose(); }
            };
            prune.Start();
        }
        catch { }
    }

    private void RestoreWindow()
    {
        if (!JarvisWindow.Restore()) OpenAppWindow();
    }

    private void HideAfterStartup()
    {
        int attempts = 0;
        System.Windows.Forms.Timer hideTimer = new System.Windows.Forms.Timer();
        hideTimer.Interval = 1000;
        hideTimer.Tick += delegate
        {
            attempts++;
            if (JarvisWindow.Hide() || attempts >= 30)
            {
                hideTimer.Stop();
                hideTimer.Dispose();
                if (attempts >= 30) Log("Could not find the JARVIS window to hide after background startup.");
                else Log("JARVIS window hidden after sign-in startup.");
            }
        };
        hideTimer.Start();
    }

    private void CheckAndRecoverBridge()
    {
        if (exiting) return;
        // KeepWindowInTray() is no longer called: auto-hiding the window was
        // the "JARVIS keeps minimizing itself" behaviour the user asked us to
        // stop. The launch flags disable Edge's background throttling, so a
        // minimized window still keeps the microphone and the global hotkey.
        // Both the UI timer and the off-thread watchdog run this; the Interlocked
        // guard keeps them from overlapping, and every stage is shielded so one
        // thrown exception can never stop the recovery chain.
        if (Interlocked.CompareExchange(ref watchdogBusy, 1, 0) != 0) return;
        try
        {
            int tick = Interlocked.Increment(ref watchdogTicks);
            try { if (tick % 12 == 0) Log("Desktop host heartbeat - check tick " + tick + "."); } catch { }
            bool healthy;
            try { healthy = IsBridgeHealthy(); } catch { healthy = false; }
            if (healthy) return;
            Log("Bridge health check failed; recovering the owned process.");
            bool started;
            try { started = StartBridge(); }
            catch (Exception error) { try { Log("Watchdog recovery error: " + error.Message); } catch { } started = false; }
            try { tray.Text = started ? "J.A.R.V.I.S. is running" : "J.A.R.V.I.S. bridge is offline"; } catch { }
        }
        finally { Interlocked.Exchange(ref watchdogBusy, 0); }
    }

    private void SetStartup(bool enabled)
    {
        try
        {
            if (enabled)
            {
                if (File.Exists(startupDisabledFlag)) File.Delete(startupDisabledFlag);
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                dynamic shell = Activator.CreateInstance(shellType);
                dynamic shortcut = shell.CreateShortcut(startupLink);
                shortcut.TargetPath = Path.Combine(root, "JARVIS.exe");
                shortcut.Arguments = "--background";
                shortcut.WorkingDirectory = root;
                shortcut.Description = "Start J.A.R.V.I.S. in the system tray when you sign in.";
                shortcut.Save();
            }
            else
            {
                if (File.Exists(startupLink)) File.Delete(startupLink);
                File.WriteAllText(startupDisabledFlag, "disabled");
            }
            startupItem.Checked = enabled;
            Log("Launch at Windows sign-in set to " + enabled + ".");
        }
        catch (Exception error) { startupItem.Checked = !enabled; Log("Could not update startup setting: " + error.Message); MessageBox.Show("Could not change the Windows startup setting: " + error.Message, "J.A.R.V.I.S.", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
    }

    private void EnsureBackgroundShortcut()
    {
        try
        {
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            dynamic shell = Activator.CreateInstance(shellType);
            dynamic shortcut = shell.CreateShortcut(startupLink);
            string target = Convert.ToString(shortcut.TargetPath);
            string arguments = Convert.ToString(shortcut.Arguments);
            if (!String.Equals(target, Path.Combine(root, "JARVIS.exe"), StringComparison.OrdinalIgnoreCase) || !String.Equals(arguments, "--background", StringComparison.OrdinalIgnoreCase))
            {
                shortcut.TargetPath = Path.Combine(root, "JARVIS.exe");
                shortcut.Arguments = "--background";
                shortcut.WorkingDirectory = root;
                shortcut.Description = "Start J.A.R.V.I.S. hidden in the notification area at sign-in.";
                shortcut.Save();
            }
            startupItem.Checked = true;
        }
        catch (Exception error) { Log("Could not update background startup shortcut: " + error.Message); }
    }

    private void ExitApplication()
    {
        if (exiting) return;
        exiting = true;
        try { healthTimer.Stop(); } catch { }
        try { pttRefreshTimer.Stop(); pttRefreshTimer.Dispose(); } catch { }
        try { recoveryWatchdog.Dispose(); } catch { }
        try { if (pttHotkey != null) { pttHotkey.Dispose(); pttHotkey = null; } } catch { }
        try { if (pttChannel != null) { pttChannel.Dispose(); pttChannel = null; } } catch { }
        try { if (winEventHook != IntPtr.Zero) { UnhookWinEvent(winEventHook); winEventHook = IntPtr.Zero; } } catch { }
        StopEdgeProcesses();
        StopBridge();

        tray.Visible = false; tray.Dispose();
        Log("Desktop tray host exited.");
        ExitThread();
    }

    private void StopEdgeProcesses()
    {
        try
        {
            using (ManagementObjectSearcher searcher = new ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='msedge.exe'"))
            using (ManagementObjectCollection processes = searcher.Get())
            {
                foreach (ManagementObject item in processes)
                {
                    string command = Convert.ToString(item["CommandLine"]);
                    if (command != null && command.IndexOf(edgeProfile, StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        int id = Convert.ToInt32(item["ProcessId"]);
                        try { Process.GetProcessById(id).Kill(); } catch { }
                    }
                }
            }
        }
        catch (Exception error) { Log("Could not close all dedicated JARVIS Edge processes: " + error.Message); }
    }
}

internal static class JarvisWindow
{
    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hWnd, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    private static IntPtr Find()
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            StringBuilder title = new StringBuilder(256); GetWindowText(h, title, title.Capacity);
            if (title.ToString().StartsWith("J.A.R.V.I.S.", StringComparison.OrdinalIgnoreCase)) { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
    internal static IntPtr FindWindow() { return Find(); }
    // Every JARVIS window (an old launch can leave one behind).
    internal static List<IntPtr> FindAllWindows()
    {
        List<IntPtr> found = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            StringBuilder title = new StringBuilder(256); GetWindowText(h, title, title.Capacity);
            if (title.ToString().StartsWith("J.A.R.V.I.S.", StringComparison.OrdinalIgnoreCase)) found.Add(h);
            return true;
        }, IntPtr.Zero);
        return found;
    }
    // Bring an existing JARVIS window forward instead of opening a second one.
    internal static bool RestoreAny()
    {
        foreach (IntPtr h in FindAllWindows())
        {
            ShowWindowAsync(h, 9);
            SetForegroundWindow(h);
            return true;
        }
        return false;
    }
    internal static void Close(IntPtr window)
    {
        try { PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero); } catch { }   // WM_CLOSE
    }
    internal static void CloseAll()
    {
        foreach (IntPtr window in FindAllWindows()) Close(window);
    }
    internal static bool Hide() { IntPtr h = Find(); return h != IntPtr.Zero && ShowWindowAsync(h, 0); }
    internal static bool Restore() { IntPtr h = Find(); if (h == IntPtr.Zero) return false; ShowWindowAsync(h, 9); return SetForegroundWindow(h); }
}

// =====================================================================
// PUSH-TO-TALK CHANNEL (2026-10-21)
//
// The push-to-talk key has to reach the JARVIS page even when the window is
// minimized or another application has focus. Two things are needed:
//
//   1. A system-wide keyboard hook, so the key is seen at all. The page's own
//      key handler only ever saw key events while the window had focus.
//   2. A delivery path that survives a minimized window. Edge throttles a
//      minimized window's timers heavily, so a polled event can arrive long
//      after the key was released - the recording is then already over. A
//      server-sent stream pushes the event the moment the key is pressed.
//
// The channel is served by this host on its own port, NOT by server.js: that
// file is being rewritten by another work stream, and a rollback there must
// never be able to break push-to-talk. The page learns the port from the
// window URL and publishes its shortcut back to the host.
// =====================================================================
internal sealed class PttChannel : IDisposable
{
    private readonly HttpListener listener = new HttpListener();
    private readonly Action<string> log;
    private readonly List<HttpListenerResponse> clients = new List<HttpListenerResponse>();
    private readonly List<HttpListenerResponse> primaryClients = new List<HttpListenerResponse>();
    // IDENTITY (2026-10-22). A page reload - or the event stream's own
    // reconnect - opens a SECOND connection from the SAME page while the old
    // one is still open. Without an identity that looked exactly like a second
    // JARVIS window, so the live connection was told to stand down: the only
    // real JARVIS window went idle, released the microphone, and global
    // push-to-talk died with it. The page now sends a stable client id, so a
    // reconnect REPLACES the old connection instead of being superseded.
    private readonly Dictionary<HttpListenerResponse, string> clientIdentities = new Dictionary<HttpListenerResponse, string>();
    private readonly object gate = new object();
    // The low-level keyboard hook runs the Publish call on its own callback
    // thread. A synchronous HTTP write there can block long enough for Windows
    // to remove the hook (LowLevelHooksTimeout), which silently killed global
    // push-to-talk after a while. Events are queued instead; a background
    // writer does every byte of I/O.
    // A queued press or release. The target list is captured while the state
    // is updated so a page that connects a moment later can never receive an
    // event that was published before it existed.
    private sealed class PttDelivery
    {
        internal string Action;
        internal string Payload;
        internal List<HttpListenerResponse> Targets;
    }
    private readonly Queue<PttDelivery> outbox = new Queue<PttDelivery>();
    private readonly AutoResetEvent outboxSignal = new AutoResetEvent(false);
    private Thread worker;
    private Thread writer;
    private volatile bool running = true;
    private string keyName = "F9";
    private uint keyVk = 0x78;
    // The hook owns its own key copy. Without this callback the hook would
    // keep listening for the default F9 forever, so a shortcut the user
    // picks in Voice Settings never reaches the global hook.
    internal Action<string> KeyChanged;

    internal int Port { get; private set; }
    internal string KeyName { get { return keyName; } }

    internal PttChannel(int preferredPort, Action<string> log)
    {
        this.log = log;
        Port = 0;
        for (int port = preferredPort; port < preferredPort + 20; port++)
        {
            try
            {
                listener.Prefixes.Add("http://127.0.0.1:" + port + "/");
                listener.Start();
                Port = port;
                break;
            }
            catch { listener.Prefixes.Clear(); }
        }
        if (Port == 0) { log("Push-to-talk channel could not be started (no free port)."); return; }
        worker = new Thread(WorkerLoop);
        worker.IsBackground = true;
        worker.Start();
        writer = new Thread(WriterLoop);
        writer.IsBackground = true;
        writer.Start();
        StartDuplicateWatch();
        log("Push-to-talk channel listening on 127.0.0.1:" + Port + ".");
    }

    private void WorkerLoop()
    {
        while (running)
        {
            HttpListenerContext context;
            try { context = listener.GetContext(); }
            catch { break; }
            try { Handle(context); }
            catch (Exception error) { log("Push-to-talk channel error: " + error.Message); }
        }
    }

    // ONE ACTIVE PAGE. The dedicated JARVIS app window (the one the host
    // launched) is the primary; any other page - the URL opened in the user's
    // own browser, or a restored session - is secondary and stands down. Two
    // pages would both hold the microphone and both answer.
    // The check is delayed so a page reload - which closes the old connection
    // a moment after the new one opens - is never mistaken for a duplicate.
    private void StartDuplicateWatch()
    {
        Thread watcher = new Thread(delegate ()
        {
            while (running)
            {
                try
                {
                    Thread.Sleep(1500);
                    List<HttpListenerResponse> snapshot;
                    lock (gate) snapshot = new List<HttpListenerResponse>(clients);
                    // Heartbeats never hold the lock: a slow client must not
                    // block Publish (the keyboard hook) or the entire host.
                    List<HttpListenerResponse> dead = new List<HttpListenerResponse>();
                    foreach (HttpListenerResponse client in snapshot)
                        if (!WriteWithTimeout(client, "", 1000)) dead.Add(client);
                    List<HttpListenerResponse> stale = new List<HttpListenerResponse>();
                    lock (gate)
                    {
                        foreach (HttpListenerResponse gone in dead)
                        {
                            clients.Remove(gone);
                            primaryClients.Remove(gone);
                            clientIdentities.Remove(gone);
                        }
                        HttpListenerResponse primary = null;
                        foreach (HttpListenerResponse client in clients) if (primaryClients.Contains(client)) { primary = client; break; }
                        if (primary != null)
                        {
                            // The app window wins: every other page stands down.
                            foreach (HttpListenerResponse client in clients) if (client != primary) stale.Add(client);
                        }
                        else if (clients.Count > 1)
                        {
                            for (int i = 0; i < clients.Count - 1; i++) stale.Add(clients[i]);
                        }
                        foreach (HttpListenerResponse client in stale)
                        {
                            clients.Remove(client);
                            primaryClients.Remove(client);
                            clientIdentities.Remove(client);
                        }
                    }
                    foreach (HttpListenerResponse client in stale)
                    {
                        log("A second JARVIS page was open - the extra one was told to stand down.");
                        WriteWithTimeout(client, "data: {\"event\":\"superseded\"}\n\n", 1000);
                    }
                }
                catch { }
            }
        });
        watcher.IsBackground = true;
        watcher.Start();
    }

    private static void Cors(HttpListenerResponse response)
    {
        response.Headers["Access-Control-Allow-Origin"] = "*";
        response.Headers["Access-Control-Allow-Headers"] = "Content-Type";
        response.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    }

    private void Handle(HttpListenerContext context)
    {
        HttpListenerRequest request = context.Request;
        HttpListenerResponse response = context.Response;
        Cors(response);
        if (request.HttpMethod == "OPTIONS") { response.StatusCode = 204; response.Close(); return; }
        if (request.HttpMethod == "GET" && request.Url.AbsolutePath == "/ptt/stream")
        {
            response.StatusCode = 200;
            response.ContentType = "text/event-stream; charset=utf-8";
            response.Headers["Cache-Control"] = "no-store";
            response.SendChunked = true;
            response.KeepAlive = true;
            // The dedicated app window (the one the host launched) is the
            // primary; any other page - the URL opened in the user's own
            // browser - is secondary and stands down.
            bool primary = request.Url.Query.Contains("app=1");
            // A reconnect from the page that is already connected replaces
            // that connection here and now - it is never a duplicate, so it
            // can never be superseded a moment later by the duplicate watch.
            string clientId = "";
            try
            {
                Match clientMatch = Regex.Match(request.Url.Query, @"(?:^|[?&])client=([A-Za-z0-9._-]+)");
                if (clientMatch.Success) clientId = Uri.UnescapeDataString(clientMatch.Groups[1].Value);
            }
            catch { clientId = ""; }
            lock (gate)
            {
                if (clientId.Length > 0)
                {
                    List<HttpListenerResponse> replaced = new List<HttpListenerResponse>();
                    foreach (KeyValuePair<HttpListenerResponse, string> known in clientIdentities)
                        if (known.Value == clientId && known.Key != response) replaced.Add(known.Key);
                    foreach (HttpListenerResponse old in replaced)
                    {
                        clients.Remove(old);
                        primaryClients.Remove(old);
                        clientIdentities.Remove(old);
                        try { old.Abort(); } catch { }
                        log("The same JARVIS page reconnected - its old stream was replaced, not superseded.");
                    }
                }
                clients.Add(response);
                if (primary) primaryClients.Add(response);
                if (clientId.Length > 0) clientIdentities[response] = clientId;
            }
            log("Push-to-talk stream opened by the JARVIS page (" + (primary ? "app window" : "extra page") + ").");
            // The handshake carries the state, never a pending action: a
            // window that opens now must not inherit a press from an earlier
            // session and switch push-to-talk on by itself.
            Write(response, "data: " + Snapshot() + "\n\n");
            return;                                  // the response stays open
        }
        if (request.HttpMethod == "GET" && request.Url.AbsolutePath == "/ptt/port")
        {
            byte[] body = Encoding.UTF8.GetBytes(State());
            response.StatusCode = 200;
            response.ContentType = "application/json; charset=utf-8";
            response.ContentLength64 = body.Length;
            response.OutputStream.Write(body, 0, body.Length);
            response.Close();
            return;
        }
        if (request.HttpMethod == "POST" && request.Url.AbsolutePath == "/ptt/key")
        {
            string body;
            using (StreamReader reader = new StreamReader(request.InputStream, Encoding.UTF8)) body = reader.ReadToEnd();
            Match match = Regex.Match(body, "\\\"key\\\"\\s*:\\s*\\\"([^\\\"]*)\\\"");
            if (match.Success)
            {
                string key = match.Groups[1].Value.Trim().ToUpperInvariant();
                log("Push-to-talk key published by the page: " + key + ".");
                if (key.Length > 0 && key != keyName)
                {
                    keyName = key;
                    keyVk = VkForKey(key);
                    log("Push-to-talk key is now " + key + ".");
                }
                // Forward it to the hook: without this the global hook keeps
                // watching the default F9 forever, so the shortcut the user
                // picked in Voice Settings never reaches it.
                if (KeyChanged != null) { try { KeyChanged(keyName); } catch { } }
            }
            response.StatusCode = 204;
            response.Close();
            return;
        }
        response.StatusCode = 404;
        response.Close();
    }

    // The state carries the moment the last REAL event happened, not the
    // moment it is served: a replayed snapshot has to look old, otherwise a
    // page that connects later would treat an old press as a fresh one and
    // open a recording that nobody asked for.
    private string State()
    {
        return "{\"id\":" + eventId + ",\"action\":\"" + (lastAction) + "\",\"code\":\"" + keyName + "\",\"at\":" + lastEventAt + "}";
    }

    // The handshake snapshot: the current state without a pending action, so
    // a client that connects now never inherits a press from an earlier
    // session.
    private string Snapshot()
    {
        return "{\"id\":" + eventId + ",\"action\":\"\",\"code\":\"" + keyName + "\",\"at\":" + lastEventAt + "}";
    }

    private int eventId = 0;
    private string lastAction = "";
    private long lastEventAt = 0;

    internal void Publish(string action)
    {
        lock (gate)
        {
            eventId++;
            lastAction = action;
            lastEventAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            // This method runs on the low-level keyboard hook's callback
            // thread. It must do NO I/O of any kind: even a slow log append can
            // push the callback past LowLevelHooksTimeout, after which Windows
            // silently removes the hook. Queue everything for the writer.
            outbox.Enqueue(new PttDelivery { Action = action, Payload = State(), Targets = new List<HttpListenerResponse>(clients) });
        }
        try { outboxSignal.Set(); } catch { }
    }

    // Drains the queue off the hook thread. The order of press/release is
    // preserved, and a client that stops reading is dropped instead of being
    // allowed to block the hook.
    private void WriterLoop()
    {
        while (running)
        {
            try { outboxSignal.WaitOne(1000); }
            catch { break; }
            while (running)
            {
                PttDelivery delivery;
                lock (gate)
                {
                    if (outbox.Count == 0) break;
                    delivery = outbox.Dequeue();
                }
                log("Push-to-talk " + delivery.Action + " pushed to " + delivery.Targets.Count + " listener(s).");
                List<HttpListenerResponse> dead = new List<HttpListenerResponse>();
                foreach (HttpListenerResponse client in delivery.Targets)
                    if (!WriteWithTimeout(client, "data: " + delivery.Payload + "\n\n", 1500)) dead.Add(client);
                if (dead.Count > 0)
                {
                    lock (gate)
                    {
                        foreach (HttpListenerResponse gone in dead)
                        {
                            clients.Remove(gone);
                            primaryClients.Remove(gone);
                            clientIdentities.Remove(gone);
                        }
                    }
                }
            }
        }
    }

    // A stalled SSE reader must never hold the publisher forever. Abort the
    // response on timeout; the page's EventSource reconnects by design.
    private static bool WriteWithTimeout(HttpListenerResponse response, string text, int timeoutMs)
    {
        try
        {
            Task<bool> task = Task.Run(() => Write(response, text));
            if (!task.Wait(timeoutMs))
            {
                try { response.Abort(); } catch { }
                return false;
            }
            return task.Result;
        }
        catch { return false; }
    }

    private static bool Write(HttpListenerResponse response, string text)
    {
        try
        {
            byte[] bytes = Encoding.UTF8.GetBytes(text);
            response.OutputStream.Write(bytes, 0, bytes.Length);
            response.OutputStream.Flush();
            return true;
        }
        catch { return false; }
    }

    // The page stores the shortcut the way the browser reports it: "F9",
    // "KEYB", "DIGIT1", "NUMPAD3".
    internal static uint VkForKey(string code)
    {
        if (string.IsNullOrEmpty(code)) return 0x78;
        if (code.StartsWith("KEY") && code.Length == 4) return char.ToUpperInvariant(code[3]);
        if (code.StartsWith("DIGIT") && code.Length == 6) return (uint)(code[5] - '0');
        if (code.StartsWith("NUMPAD") && code.Length == 7) return (uint)(0x60 + (code[6] - '0'));
        if (code.Length >= 2 && code[0] == 'F')
        {
            int number;
            if (int.TryParse(code.Substring(1), out number) && number >= 1 && number <= 12) return (uint)(0x6F + number);
        }
        return 0x78;
    }

    public void Dispose()
    {
        running = false;
        try { outboxSignal.Set(); } catch { }
        try { listener.Stop(); } catch { }
        try { listener.Close(); } catch { }
        try { if (writer != null) writer.Join(1000); } catch { }
        try { outboxSignal.Dispose(); } catch { }
    }
}

// =====================================================================
// PUSH-TO-TALK GLOBAL HOTKEY (2026-10-21)
//
// The push-to-talk key is handled inside the JARVIS page, so it only worked
// while the JARVIS window had keyboard focus. This low-level keyboard hook
// sees the key everywhere and forwards the press and release to the page
// through the PttChannel above. The key itself is never swallowed: the
// page's own handler stays the fallback, and the start/end calls are
// idempotent so both paths can fire without a double recording.
// =====================================================================
internal sealed class PttHotkey : IDisposable
{
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_SYSKEYDOWN = 0x0104, WM_SYSKEYUP = 0x0105;

    private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll")]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
    private static extern IntPtr GetModuleHandle(string moduleName);
    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);
    private readonly PttChannel channel;
    private readonly Action<string> log;
    private HookProc proc;
    private IntPtr hookId = IntPtr.Zero;
    private volatile bool running = true;
    private string keyName = "F9";
    private uint keyVk = 0x78;
    private bool keyIsDown = false;

    internal PttHotkey(PttChannel channel, Action<string> log)
    {
        this.channel = channel;
        this.log = log;
    }

    internal void Start()
    {
        proc = HookCallback;
        hookId = SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(null), 0);
        // A key that is ALREADY physically down when the hook is installed must
        // not be treated as a new press: the first auto-repeat key-down would
        // otherwise publish a "press" nobody asked for and switch push-to-talk
        // on by itself. Sync the state from Windows instead. Only the high bit
        // means "currently down"; the low bit is a since-last-query latch and
        // is still set by any earlier F9 press, which used to mark keyIsDown
        // true and swallow the first press after every restart.
        try { keyIsDown = (GetAsyncKeyState((int)keyVk) & 0x8000) != 0; } catch { }
        if (hookId == IntPtr.Zero)
        {
            log("Global push-to-talk hook could not be installed (Win32 error " + Marshal.GetLastWin32Error() + "). The in-window key still works.");
            return;
        }
        log("Global push-to-talk hook active.");
    }

    private IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            int message = wParam.ToInt32();
            if (message == WM_KEYDOWN || message == WM_KEYUP || message == WM_SYSKEYDOWN || message == WM_SYSKEYUP)
            {
                try
                {
                    KBDLLHOOKSTRUCT data = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                    if (data.vkCode == keyVk)
                    {
                        // Auto-repeat sends a stream of key-downs while the key
                        // is held. Only the first down and the real up are
                        // events, so the page sees one press and one release.
                        // The release is published even when the press was
                        // missed - the hook can be installed while the key is
                        // already down. A dangling press would be replayed to
                        // the next window that opens and would switch
                        // push-to-talk on by itself.
                        bool down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
                        if (down)
                        {
                            if (!keyIsDown) { keyIsDown = true; channel.Publish("press"); }
                        }
                        else
                        {
                            keyIsDown = false;
                            channel.Publish("release");
                        }
                    }
                }
                catch { }
            }
        }
        return CallNextHookEx(hookId, nCode, wParam, lParam);
    }

    // The page owns the shortcut setting and publishes it to the channel.
    internal void SetKey(string key)
    {
        if (string.IsNullOrEmpty(key)) return;
        string normalized = key.Trim().ToUpperInvariant();
        if (normalized == keyName) return;
        keyName = normalized;
        keyVk = PttChannel.VkForKey(normalized);
        log("Global push-to-talk key is now " + keyName + ".");
    }

    // Windows can silently drop a low-level hook (for example if a callback
    // ever exceeded LowLevelHooksTimeout). Re-registering on a timer restores
    // push-to-talk without asking the user to restart JARVIS. The new hook is
    // installed before the old one is removed, so a key press in between is
    // still seen exactly once (keyIsDown collapses duplicates).
    internal void Refresh()
    {
        if (!running) return;
        HookProc nextProc = HookCallback;
        IntPtr nextHook = SetWindowsHookEx(WH_KEYBOARD_LL, nextProc, GetModuleHandle(null), 0);
        if (nextHook == IntPtr.Zero)
        {
            log("Global push-to-talk hook refresh failed (Win32 error " + Marshal.GetLastWin32Error() + ").");
            return;
        }
        IntPtr previous = hookId;
        HookProc previousProc = proc;
        hookId = nextHook;
        proc = nextProc;
        // Drop a stale keyIsDown left by a missed key-up; keep it only while
        // the key is genuinely held, so a refresh cannot swallow the next press.
        try { keyIsDown = (GetAsyncKeyState((int)keyVk) & 0x8000) != 0; } catch { }
        if (previous != IntPtr.Zero) { try { UnhookWindowsHookEx(previous); } catch { } }
        GC.KeepAlive(previousProc);
        log("Global push-to-talk hook refreshed.");
    }

    public void Dispose()
    {
        running = false;
        // A key that is still down when the host stops must not leave a
        // dangling press behind: the next window that opens would inherit it
        // and open a recording nobody asked for.
        if (keyIsDown)
        {
            keyIsDown = false;
            try { channel.Publish("release"); } catch { }
        }
        if (hookId != IntPtr.Zero)
        {
            try { UnhookWindowsHookEx(hookId); } catch { }
            hookId = IntPtr.Zero;
        }
    }
}
