// Easy-Med launcher.
//
// A clinic receptionist should double-click one thing. This starts the server,
// waits until it is genuinely answering, opens the browser at the local address,
// and keeps the window as the on/off switch: closing it stops the system.
//
// Written in C# because csc.exe ships with Windows — the .exe can be rebuilt on
// any clinic PC with nothing installed. Adapted line-for-line from the sibling
// product's launcher (symptex/launcher/Symptex.cs), which already paid for the
// hard lessons below in the field; deviations are marked EASYMED.
using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class EasyMed
{
    const int DefaultPort = 8000;

    static string AppRoot()
    {
        // The exe sits in the application folder. Everything is relative to it, so
        // the folder can be moved or renamed without breaking the launcher.
        return Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName);
    }

    static string FindNode()
    {
        // A bundled runtime wins, so a clinic can be handed a self-contained folder
        // with no system-wide Node install.
        string local = Path.Combine(AppRoot(), "runtime", "node.exe");
        if (File.Exists(local)) return local;

        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string dir in path.Split(';'))
        {
            if (dir.Length == 0) continue;
            try
            {
                string candidate = Path.Combine(dir.Trim(), "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch { /* an unreadable PATH entry is not fatal */ }
        }

        foreach (string guess in new[] {
            @"C:\Program Files\nodejs\node.exe",
            @"C:\Program Files (x86)\nodejs\node.exe" })
        {
            if (File.Exists(guess)) return guess;
        }
        return null;
    }

    // EASYMED — the versioned layout. The app lives in versions\<v>\ and runs
    // through a junction named `current`, so an update is "unpack beside, repoint,
    // restart". A junction does not survive being copy-pasted between machines
    // (it arrives as a plain folder or not at all), so the launcher rebuilds it:
    // if `current` is missing or broken and versions\ has candidates, point at the
    // newest. Junctions need no administrator rights.
    static string EnsureCurrent(string root)
    {
        string current = Path.Combine(root, "current");
        string entry = Path.Combine(current, "server", "index.js");
        if (File.Exists(entry)) return entry;

        string versions = Path.Combine(root, "versions");
        if (!Directory.Exists(versions)) return null;

        string best = null;
        long bestKey = -1;
        foreach (string d in Directory.GetDirectories(versions))
        {
            // Numeric-per-segment, so 0.10.0 beats 0.9.0 — the same rule the
            // updater uses. A string sort gets this wrong.
            string name = Path.GetFileName(d);
            string[] parts = name.Split('.');
            long key = 0;
            bool ok = parts.Length > 0;
            foreach (string p in parts)
            {
                int seg;
                if (!int.TryParse(p, out seg)) { ok = false; break; }
                key = key * 100000 + seg;
            }
            if (ok && key > bestKey && File.Exists(Path.Combine(d, "server", "index.js")))
            {
                bestKey = key; best = d;
            }
        }
        if (best == null) return null;

        try
        {
            // A stale `current` (broken junction, or a real folder left by a bad
            // copy) must go before mklink can succeed. rmdir removes a junction
            // WITHOUT touching its target; on a real folder the copy-paste made,
            // the versions\ copy is the authority anyway.
            if (Directory.Exists(current) || File.Exists(current))
            {
                var psiRm = new ProcessStartInfo("cmd.exe", "/c rmdir /s /q \"" + current + "\"")
                { UseShellExecute = false, CreateNoWindow = true };
                using (var p = Process.Start(psiRm)) p.WaitForExit(10000);
            }
            var psi = new ProcessStartInfo("cmd.exe", "/c mklink /J \"" + current + "\" \"" + best + "\"")
            { UseShellExecute = false, CreateNoWindow = true };
            using (var p = Process.Start(psi)) p.WaitForExit(10000);
        }
        catch { return null; }

        return File.Exists(entry) ? entry : null;
    }

    // ── Killing the server when this window closes ──────────────────────────────
    //
    // AppDomain.ProcessExit does NOT fire when a console window is closed with the
    // X button, and CancelKeyPress only catches Ctrl+C — so a plainly-spawned node
    // survives, holding the port, invisible. A Job Object is the reliable answer:
    // Windows terminates everything in the job the moment this process goes away.

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attrs, string name);

    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    const int ExtendedLimitInformation = 9;
    const uint KillOnJobClose = 0x2000;

    // Held for the lifetime of the process on purpose: closing this handle is what
    // triggers the kill, so it must not be collected early.
    static IntPtr _job = IntPtr.Zero;

    static bool TieChildToThisProcess(Process child)
    {
        try
        {
            _job = CreateJobObject(IntPtr.Zero, null);
            if (_job == IntPtr.Zero) return false;

            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = KillOnJobClose;

            int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr buf = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(info, buf, false);
                if (!SetInformationJobObject(_job, ExtendedLimitInformation, buf, (uint)size)) return false;
            }
            finally { Marshal.FreeHGlobal(buf); }

            return AssignProcessToJobObject(_job, child.Handle);
        }
        catch { return false; }
    }

    delegate bool ConsoleCtrlDelegate(uint ctrlType);

    [DllImport("kernel32.dll")]
    static extern bool SetConsoleCtrlHandler(ConsoleCtrlDelegate handler, bool add);

    static ConsoleCtrlDelegate _ctrlHandler;   // kept alive; a collected delegate crashes the callback
    static Process _server;

    // EASYMED — the port can be pinned per install with a plain port.txt beside
    // the exe: one number, nothing else. A file a clinic technician can edit in
    // Notepad beats an environment variable they cannot find.
    static int PortFromFile()
    {
        try
        {
            string p = Path.Combine(AppRoot(), "port.txt");
            if (!File.Exists(p)) return 0;
            int v;
            if (int.TryParse(File.ReadAllText(p).Trim(), out v) && v >= 1 && v <= 65535) return v;
        }
        catch { }
        return 0;
    }

    static bool PortAnswering(int port)
    {
        try
        {
            using (var c = new TcpClient())
            {
                var r = c.BeginConnect("127.0.0.1", port, null, null);
                if (!r.AsyncWaitHandle.WaitOne(TimeSpan.FromMilliseconds(400))) return false;
                c.EndConnect(r);
                return true;
            }
        }
        catch { return false; }
    }

    // Windows blocks incoming connections by default. Without a rule the server
    // runs perfectly and every other PC in the clinic simply cannot connect —
    // which looks like a broken network, not a firewall.
    static string RunNetsh(string args)
    {
        try
        {
            var psi = new ProcessStartInfo("netsh", args)
            {
                UseShellExecute = false, RedirectStandardOutput = true,
                RedirectStandardError = true, CreateNoWindow = true,
            };
            using (var p = Process.Start(psi))
            {
                string outp = p.StandardOutput.ReadToEnd();
                p.WaitForExit(4000);
                return outp ?? "";
            }
        }
        catch { return ""; }
    }

    static void WarnIfFirewallWillBlock(int port)
    {
        string state = RunNetsh("advfirewall show currentprofile state");
        bool firewallOn = state.IndexOf("ON", StringComparison.OrdinalIgnoreCase) >= 0
                       && state.IndexOf("OFF", StringComparison.OrdinalIgnoreCase) < 0;
        if (!firewallOn) return;

        string rule = RunNetsh("advfirewall firewall show rule name=\"EasyMed (clinic network)\"");
        if (rule.IndexOf(port.ToString(), StringComparison.Ordinal) >= 0) return;

        Console.WriteLine();
        Console.WriteLine("  ВНИМАНИЕ: другие компьютеры клиники сейчас НЕ подключатся.");
        Console.WriteLine("  Брандмауэр Windows закрывает порт " + port + ".");
        Console.WriteLine();
        Console.WriteLine("  Один раз выполните команду от имени администратора:");
        Console.WriteLine("      netsh advfirewall firewall add rule name=\"EasyMed (clinic network)\" dir=in action=allow protocol=TCP localport=" + port);
        Console.WriteLine();
        Console.WriteLine("  На этом компьютере система работает и без этого.");
    }

    // ── Reclaiming the port from an orphan ──────────────────────────────────────
    static int PortOwnerPid(int port)
    {
        try
        {
            var psi = new ProcessStartInfo("netstat", "-ano -p TCP")
            {
                UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true,
            };
            using (var p = Process.Start(psi))
            {
                string outp = p.StandardOutput.ReadToEnd();
                p.WaitForExit(5000);
                foreach (string line in outp.Split('\n'))
                {
                    if (!line.Contains("LISTENING")) continue;
                    if (!line.Contains(":" + port + " ")) continue;
                    string[] parts = line.Trim().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                    int pid;
                    if (parts.Length >= 5 && int.TryParse(parts[parts.Length - 1], out pid)) return pid;
                }
            }
        }
        catch { }
        return -1;
    }

    static bool TryReclaimPort(int port)
    {
        int pid = PortOwnerPid(port);
        if (pid <= 0) return false;

        Process owner;
        try { owner = Process.GetProcessById(pid); }
        catch { return false; }

        if (!owner.ProcessName.Equals("node", StringComparison.OrdinalIgnoreCase))
        {
            Console.WriteLine();
            Console.WriteLine("  Порт " + port + " занят программой «" + owner.ProcessName + "» — это не Easy-Med.");
            Console.WriteLine("  Завершите её вручную или запустите Easy-Med на другом порту:");
            Console.WriteLine("      EasyMed.exe " + (port + 1));
            return false;
        }

        Console.WriteLine();
        Console.WriteLine("  Найдена работающая копия Easy-Med без окна (процесс " + pid + ").");
        Console.WriteLine("  Так бывает, если сервер запускали из терминала и закрыли его.");
        Console.Write("  Остановить её и запустить заново? [y/N]: ");
        string answer;
        if (Console.IsInputRedirected)
        {
            answer = (Console.In.ReadLine() ?? "").Trim();
        }
        else
        {
            var key = Console.ReadKey(true);
            Console.WriteLine(key.KeyChar);
            answer = key.KeyChar.ToString();
        }
        if (!answer.Equals("y", StringComparison.OrdinalIgnoreCase)) return false;

        try
        {
            owner.Kill();
            owner.WaitForExit(5000);
        }
        catch (Exception e)
        {
            Console.WriteLine("  Не удалось остановить: " + e.Message);
            return false;
        }

        for (int i = 0; i < 20; i++)
        {
            if (!PortAnswering(port)) { Console.WriteLine("  Остановлена, порт свободен."); return true; }
            Thread.Sleep(250);
        }
        Console.WriteLine("  Порт всё ещё занят — попробуйте ещё раз через несколько секунд.");
        return false;
    }

    static void Fail(string title, params string[] lines)
    {
        Console.WriteLine();
        Console.WriteLine("  " + title);
        Console.WriteLine("  " + new string('-', 50));
        foreach (string l in lines) Console.WriteLine("  " + l);
        Console.WriteLine();
        Console.WriteLine("  Нажмите любую клавишу, чтобы закрыть окно...");
        try { Console.ReadKey(true); } catch { Thread.Sleep(15000); }
    }

    static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        Console.Title = "Easy-Med";

        string root = AppRoot();
        string entry = EnsureCurrent(root);

        if (entry == null)
        {
            Fail("Easy-Med не найден в этой папке.",
                 "Нет папки versions\\<версия>\\server — запускайте EasyMed.exe",
                 "из папки с системой (той, куда её распаковали целиком).");
            return 1;
        }

        string node = FindNode();
        if (node == null)
        {
            Fail("Не найден Node.js.",
                 "Положите node.exe в папку runtime\\ рядом с EasyMed.exe",
                 "(полный комплект клиники уже содержит его),",
                 "либо установите Node.js: https://nodejs.org (версия LTS)");
            return 1;
        }

        // Precedence: argument > environment > port.txt > default.
        int port = DefaultPort;
        int candidate = PortFromFile();
        if (candidate > 0) port = candidate;
        string fromEnv = Environment.GetEnvironmentVariable("EASYMED_PORT");
        if (!string.IsNullOrEmpty(fromEnv) && int.TryParse(fromEnv, out candidate) && candidate > 0 && candidate <= 65535) port = candidate;
        if (args.Length > 0 && int.TryParse(args[0], out candidate) && candidate > 0 && candidate <= 65535) port = candidate;

        if (PortAnswering(port) && !TryReclaimPort(port))
        {
            Fail("Easy-Med уже работает.",
                 "Откройте http://localhost:" + port + " в браузере,",
                 "или закройте другое окно Easy-Med и попробуйте снова.");
            return 1;
        }

        var psi = new ProcessStartInfo
        {
            FileName = node,
            Arguments = "\"" + entry + "\"",
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = false,
        };
        // EASYMED — data lives beside the exe, outside the versioned tree, so an
        // update can replace the application without touching the clinic's records.
        psi.EnvironmentVariables["EASYMED_DATA_DIR"] = Path.Combine(root, "data");
        psi.EnvironmentVariables["PORT"] = port.ToString();

        Process server;
        try { server = Process.Start(psi); }
        catch (Exception e)
        {
            Fail("Не удалось запустить Easy-Med.", e.Message);
            return 1;
        }

        bool up = false;
        for (int i = 0; i < 60 && !server.HasExited; i++)
        {
            if (PortAnswering(port)) { up = true; break; }
            Thread.Sleep(500);
        }

        if (!up)
        {
            if (server.HasExited)
            {
                Console.WriteLine();
                Console.WriteLine("  Easy-Med остановился при запуске — смотрите сообщение выше.");
                Console.WriteLine();
                Console.WriteLine("  Нажмите любую клавишу, чтобы закрыть окно...");
                try { Console.ReadKey(true); } catch { Thread.Sleep(15000); }
                return server.ExitCode;
            }
            Console.WriteLine();
            Console.WriteLine("  Система запускается дольше обычного.");
            Console.WriteLine("  Откройте вручную: http://localhost:" + port);
        }
        else
        {
            try
            {
                Process.Start(new ProcessStartInfo("http://localhost:" + port) { UseShellExecute = true });
            }
            catch { Console.WriteLine("  Откройте в браузере: http://localhost:" + port); }
        }

        WarnIfFirewallWillBlock(port);

        _server = server;
        if (!TieChildToThisProcess(server))
        {
            Console.WriteLine();
            Console.WriteLine("  Примечание: не удалось связать процессы.");
            Console.WriteLine("  Если после закрытия окна система останется запущенной,");
            Console.WriteLine("  завершите процесс node.exe в диспетчере задач.");
        }

        _ctrlHandler = _ => { Stop(_server); return false; };
        SetConsoleCtrlHandler(_ctrlHandler, true);
        AppDomain.CurrentDomain.ProcessExit += (s, e) => Stop(_server);
        Console.CancelKeyPress += (s, e) => Stop(_server);

        server.WaitForExit();
        int exitCode = server.ExitCode;
        // Exit code 75 is the restart-after-update convention: the entry path goes
        // through `current`, so a restart lands on whatever version it now names.
        while (exitCode == 75)
        {
            Console.WriteLine();
            Console.WriteLine("  Обновление применено, перезапуск...");
            try { _server = Process.Start(psi); }
            catch (Exception e) { Fail("Не удалось перезапустить после обновления.", e.Message); return 1; }
            TieChildToThisProcess(_server);
            _server.WaitForExit();
            exitCode = _server.ExitCode;
        }
        return exitCode;
    }

    static void Stop(Process p)
    {
        try { if (p != null && !p.HasExited) p.Kill(); } catch { }
    }
}
