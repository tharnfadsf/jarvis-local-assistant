using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Management;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
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
    private Process bridge;
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
        if (backgroundLaunch) HideAfterStartup();
        healthTimer.Start();
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
            try
            {
                bridge = new Process(); bridge.StartInfo = info;
                bridge.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) Log("bridge: " + e.Data); };
                bridge.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) Log("bridge error: " + e.Data); };
                bridge.Start(); bridge.BeginOutputReadLine(); bridge.BeginErrorReadLine();
                for (int retry = 0; retry < 25; retry++)
                {
                    Thread.Sleep(300);
                    if (IsBridgeHealthy()) { File.WriteAllText(portFile, port.ToString()); tray.Text = "J.A.R.V.I.S. is running"; Log("Bridge healthy at 127.0.0.1:" + port + " (PID " + bridge.Id + ")."); return true; }
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

    private void StopBridge()
    {
        if (bridge != null)
        {
            try { if (!bridge.HasExited) { bridge.Kill(); bridge.WaitForExit(3000); Log("Owned bridge process stopped."); } }
            catch (Exception error) { Log("Could not stop bridge cleanly: " + error.Message); }
            bridge.Dispose(); bridge = null;
        }
    }

    private string AppUrl { get { return "http://127.0.0.1:" + port + "/"; } }

    private void OpenAppWindow()
    {
        if (!IsBridgeHealthy()) { Log("App window not opened because the bridge health check failed."); return; }
        string args = "--app=\"" + AppUrl + "\" --user-data-dir=\"" + edgeProfile + "\" --no-first-run --no-default-browser-check --disable-session-crashed-bubble --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows";
        try
        {
            ProcessStartInfo info = new ProcessStartInfo(edgePath, args); info.UseShellExecute = true;
            Process.Start(info); Log("Opened standalone JARVIS Edge app window.");
        }
        catch (Exception error) { Log("Could not open app window: " + error.Message); tray.Text = "J.A.R.V.I.S. window failed"; }
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
        if (!IsBridgeHealthy())
        {
            Log("Bridge health check failed; recovering the owned process.");
            if (StartBridge()) tray.Text = "J.A.R.V.I.S. is running";
            else tray.Text = "J.A.R.V.I.S. bridge is offline";
        }
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
    internal static bool Hide() { IntPtr h = Find(); return h != IntPtr.Zero && ShowWindowAsync(h, 0); }
    internal static bool Restore() { IntPtr h = Find(); if (h == IntPtr.Zero) return false; ShowWindowAsync(h, 9); return SetForegroundWindow(h); }
}
