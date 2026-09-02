// Easy-Med installer — обычный оконный установщик.
//
// ЧТО ЭТО И ПОЧЕМУ ОНО ПОЯВИЛОСЬ. Клинику ставили сторонним easymedSetup.exe,
// который раскладывал приложение ПЛОСКО в одну папку. Обновление устроено как
// «распаковать рядом и переставить указатель current», поэтому установка без
// versions\<v> и current не может принять обновление НИКОГДА: переставлять
// нечего. Филиал владельца 2026-09-02 скачивал и распаковывал каждый релиз по
// кругу и оставался на 0.6.2, показывая «доступно обновление».
//
// Этот установщик делает ровно одно: раскладывает то, что уже умеет
// обновляться. Внутри — готовый пакет клиники (make-clinic-package.ps1),
// проверенный по подписи ДО упаковки сюда.
//
// ПОЧЕМУ ОКНА, А НЕ КОНСОЛЬ. Ставит систему администратор клиники, а не
// инженер. Требование владельца дословно: «we need a classic game like setup...
// so user dont types shit into a terminal». Четыре шага, кнопки «Далее» и
// «Назад», выбор папки мышью — и ни одной строки, которую надо набрать.
//
// Написан на C# по той же причине, что и лаунчер: csc.exe есть на любой
// Windows, и .exe пересобирается где угодно без установки инструментов.
//
// ЧЕГО ОН НЕ ДЕЛАЕТ, намеренно:
//   • не создаёт current — junction не переживает копирование между машинами,
//     поэтому его строит лаунчер на месте (см. EasyMed.cs);
//   • не трогает data\ — там лицензия, привязка филиала и база;
//   • не ставит службу и не просит прав администратора: установка, которой
//     владеет administrator, не сможет обновлять сама себя из-под обычного
//     пользователя — той самой ошибки мы и избегаем.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

static class EasyMedSetup
{
    const string PayloadName = "payload.zip";
    const string AppTitle = "Установка Easy-Med";

    [STAThread]
    static int Main(string[] args)
    {
        // Тихая установка по пути в аргументе. Нужна не «на всякий случай»:
        // без неё установщик нельзя проверить автоматически, а установщик,
        // который никто не проверял, — это ровно то, с чего началась история.
        if (args.Length > 0 && !args[0].StartsWith("/"))
        {
            try
            {
                string dest = Path.GetFullPath(args[0]);
                string why;
                if (Forbidden(dest, out why)) { Console.Error.WriteLine(why); return 2; }
                Directory.CreateDirectory(dest);
                Extract(dest, null);
                EnsureDataFolder(dest);
                return File.Exists(Path.Combine(dest, "EasyMed.exe")) ? 0 : 3;
            }
            catch (Exception e) { Console.Error.WriteLine(e.Message); return 4; }
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new Wizard());
        return 0;
    }

    // ── Правила, общие для окна и тихой установки ────────────────────────────

    internal static string DefaultTarget()
    {
        string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        if (string.IsNullOrEmpty(desktop)) desktop = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return Path.Combine(desktop, "EasyMed");
    }

    // Папки, куда ставить нельзя. Не вкусовщина: каждая принадлежит
    // администратору или системе, и установка туда ломает ровно то, ради чего
    // этот установщик написан, — способность обновляться самой.
    internal static bool Forbidden(string full, out string why)
    {
        why = null;
        string[] bad =
        {
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            Environment.GetFolderPath(Environment.SpecialFolder.System),
        };
        foreach (string b in bad)
        {
            if (string.IsNullOrEmpty(b)) continue;
            if (full.StartsWith(b, StringComparison.OrdinalIgnoreCase))
            {
                why = "В эту папку пишет только администратор — тогда система не сможет обновляться сама.\n\nВыберите другую папку, например на Рабочем столе.";
                return true;
            }
        }
        try
        {
            if (Path.GetPathRoot(full).Equals(full, StringComparison.OrdinalIgnoreCase))
            {
                why = "Нельзя ставить в корень диска — выберите отдельную папку.";
                return true;
            }
        }
        catch { why = "Путь указан неверно."; return true; }
        return false;
    }

    internal static void EnsureDataFolder(string root)
    {
        string data = Path.Combine(root, "data");
        if (!Directory.Exists(data)) Directory.CreateDirectory(data);
    }

    // Распаковка ВРУЧНУЮ, а не ZipFile.ExtractToDirectory: тот падает целиком,
    // если файл уже существует, — а установка поверх существующей папки здесь
    // штатный сценарий (так чинят криво поставленную клинику, не теряя записей).
    internal static int Extract(string root, Action<int, int> onProgress)
    {
        int n = 0;
        using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(PayloadName))
        {
            if (s == null) throw new Exception("внутри установщика нет пакета (payload.zip)");
            using (var zip = new ZipArchive(s, ZipArchiveMode.Read))
            {
                int total = zip.Entries.Count;
                foreach (ZipArchiveEntry e in zip.Entries)
                {
                    string rel = e.FullName.Replace('/', Path.DirectorySeparatorChar);
                    string dest = Path.GetFullPath(Path.Combine(root, rel));

                    // Zip Slip: запись, чей путь выводит за пределы папки
                    // установки, не распаковывается. Пакет свой, но проверка
                    // стоит здесь потому, что стоить она должна везде.
                    if (!dest.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                        throw new Exception("в пакете запись с недопустимым путём: " + e.FullName);

                    if (string.IsNullOrEmpty(e.Name))
                    {
                        Directory.CreateDirectory(dest);
                    }
                    else
                    {
                        // data\ клиники не трогаем НИ ПРИ КАКИХ УСЛОВИЯХ: там
                        // лицензия, привязка филиала и вся база.
                        bool inData = rel.StartsWith("data" + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
                        if (!(inData && File.Exists(dest)))
                        {
                            Directory.CreateDirectory(Path.GetDirectoryName(dest));
                            e.ExtractToFile(dest, true);
                        }
                    }
                    n++;
                    if (onProgress != null) onProgress(n, total);
                }
            }
        }
        return n;
    }

    internal static void MakeDesktopShortcut(string installDir)
    {
        string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        if (string.IsNullOrEmpty(desktop)) return;
        string lnk = Path.Combine(desktop, "Easy-Med.lnk");
        string exe = Path.Combine(installDir, "EasyMed.exe");

        // Через WScript.Shell по позднему связыванию: тянуть COM-ссылку на
        // Windows Script Host ради одного ярлыка не стоит, а отсутствие ярлыка
        // не повод рушить установку.
        Type t = Type.GetTypeFromProgID("WScript.Shell");
        if (t == null) return;
        object shell = Activator.CreateInstance(t);
        object sc = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnk });
        Type st = sc.GetType();
        st.InvokeMember("TargetPath", BindingFlags.SetProperty, null, sc, new object[] { exe });
        st.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, sc, new object[] { installDir });
        st.InvokeMember("Description", BindingFlags.SetProperty, null, sc, new object[] { "Easy-Med" });
        st.InvokeMember("Save", BindingFlags.InvokeMethod, null, sc, null);
    }
}

// ── Окно ─────────────────────────────────────────────────────────────────────
//
// Четыре шага, как в обычной программе установки: приветствие → куда ставить →
// установка → готово. Кнопки внизу справа, «Назад» слева от «Далее».
sealed class Wizard : Form
{
    readonly Panel _body = new Panel();
    readonly Button _back = new Button();
    readonly Button _next = new Button();
    readonly Button _cancel = new Button();
    readonly Label _heading = new Label();
    readonly Label _sub = new Label();

    TextBox _path;
    CheckBox _shortcut;
    CheckBox _runNow;
    ProgressBar _bar;
    Label _status;
    Label _keepData;

    int _step;              // 0 приветствие · 1 папка · 2 установка · 3 готово
    string _target;
    string _error;

    static readonly Font HeadFont = new Font("Segoe UI", 13F, FontStyle.Bold);
    static readonly Font BodyFont = new Font("Segoe UI", 9.75F);

    public Wizard()
    {
        Text = "Установка Easy-Med";
        Font = BodyFont;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(560, 400);
        BackColor = Color.White;

        var header = new Panel { Dock = DockStyle.Top, Height = 74, BackColor = Color.White };
        _heading.Font = HeadFont;
        _heading.AutoSize = false;
        _heading.SetBounds(24, 16, 510, 26);
        _sub.ForeColor = Color.FromArgb(90, 90, 90);
        _sub.AutoSize = false;
        _sub.SetBounds(24, 44, 510, 20);
        header.Controls.Add(_heading);
        header.Controls.Add(_sub);

        var line = new Panel { Dock = DockStyle.Top, Height = 1, BackColor = Color.FromArgb(220, 220, 220) };

        _body.Dock = DockStyle.Fill;
        _body.Padding = new Padding(24, 12, 24, 12);

        var foot = new Panel { Dock = DockStyle.Bottom, Height = 58, BackColor = Color.FromArgb(247, 247, 247) };
        var footLine = new Panel { Dock = DockStyle.Top, Height = 1, BackColor = Color.FromArgb(220, 220, 220) };
        foreach (var b in new[] { _back, _next, _cancel })
        {
            b.Size = new Size(104, 30);
            b.FlatStyle = FlatStyle.System;
        }
        _back.Text = "Назад";
        _next.Text = "Далее";
        _cancel.Text = "Отмена";
        _back.Location = new Point(228, 14);
        _next.Location = new Point(338, 14);
        _cancel.Location = new Point(444, 14);
        _back.Click += (s, e) => Go(_step - 1);
        _next.Click += (s, e) => OnNext();
        _cancel.Click += (s, e) => Close();
        foot.Controls.Add(_back);
        foot.Controls.Add(_next);
        foot.Controls.Add(_cancel);
        foot.Controls.Add(footLine);

        Controls.Add(_body);
        Controls.Add(foot);
        Controls.Add(line);
        Controls.Add(header);

        AcceptButton = _next;
        Go(0);
    }

    void Go(int step)
    {
        _step = step;
        _body.Controls.Clear();
        _back.Enabled = step == 1;
        _cancel.Enabled = step != 2;
        _next.Enabled = true;
        _next.Text = step == 3 ? "Готово" : "Далее";

        if (step == 0) PageWelcome();
        else if (step == 1) PageFolder();
        else if (step == 2) PageInstall();
        else PageDone();
    }

    void PageWelcome()
    {
        _heading.Text = "Easy-Med";
        _sub.Text = "Установка системы для клиники";

        var l = new Label
        {
            AutoSize = false,
            Bounds = new Rectangle(24, 20, 505, 190),
            Text =
                "Эта программа установит Easy-Med на компьютер.\r\n\r\n" +
                "Ничего заранее устанавливать не нужно: всё необходимое уже внутри.\r\n\r\n" +
                "После установки система будет обновляться сама — новые версии " +
                "приходят от Easy-Med и устанавливаются без вашего участия.\r\n\r\n" +
                "Нажмите «Далее», чтобы продолжить.",
        };
        _body.Controls.Add(l);
    }

    void PageFolder()
    {
        _heading.Text = "Куда установить";
        _sub.Text = "Выберите папку для Easy-Med";

        var l = new Label { AutoSize = false, Bounds = new Rectangle(24, 16, 505, 20), Text = "Папка установки:" };
        _path = new TextBox { Bounds = new Rectangle(24, 40, 400, 26), Text = _target ?? EasyMedSetup.DefaultTarget() };
        var browse = new Button { Text = "Обзор…", Bounds = new Rectangle(432, 39, 97, 28), FlatStyle = FlatStyle.System };
        browse.Click += (s, e) =>
        {
            using (var d = new FolderBrowserDialog())
            {
                d.Description = "Выберите папку, куда установить Easy-Med";
                if (d.ShowDialog(this) == DialogResult.OK)
                    _path.Text = Path.Combine(d.SelectedPath, "EasyMed");
            }
        };

        _keepData = new Label
        {
            AutoSize = false,
            Bounds = new Rectangle(24, 76, 505, 40),
            ForeColor = Color.FromArgb(150, 90, 0),
            Text = "",
        };
        _path.TextChanged += (s, e) => RefreshKeepData();

        _shortcut = new CheckBox { Text = "Создать ярлык на рабочем столе", Bounds = new Rectangle(24, 130, 400, 24), Checked = true };

        var note = new Label
        {
            AutoSize = false,
            Bounds = new Rectangle(24, 168, 505, 60),
            ForeColor = Color.FromArgb(110, 110, 110),
            Text = "Не устанавливайте в Program Files: в эту папку пишет только администратор, "
                 + "и тогда система не сможет обновляться сама.",
        };

        _body.Controls.Add(l);
        _body.Controls.Add(_path);
        _body.Controls.Add(browse);
        _body.Controls.Add(_keepData);
        _body.Controls.Add(_shortcut);
        _body.Controls.Add(note);
        RefreshKeepData();
    }

    // Установка поверх существующей папки — обычное дело: так чинят криво
    // поставленную клинику. Человек обязан видеть заранее, что записи уцелеют.
    void RefreshKeepData()
    {
        try
        {
            string p = Path.GetFullPath(_path.Text.Trim().Trim('"'));
            _keepData.Text = Directory.Exists(Path.Combine(p, "data"))
                ? "В этой папке уже есть клиника. Её данные — лицензия, филиал и база — сохранятся."
                : "";
        }
        catch { _keepData.Text = ""; }
    }

    void PageInstall()
    {
        _heading.Text = "Установка";
        _sub.Text = "Подождите, идёт распаковка файлов";

        _bar = new ProgressBar { Bounds = new Rectangle(24, 60, 505, 22), Style = ProgressBarStyle.Continuous, Maximum = 100 };
        _status = new Label { AutoSize = false, Bounds = new Rectangle(24, 92, 505, 40), Text = "Подготовка…" };
        _body.Controls.Add(_bar);
        _body.Controls.Add(_status);

        _next.Enabled = false;
        _back.Enabled = false;

        var th = new Thread(() =>
        {
            try
            {
                Directory.CreateDirectory(_target);
                EasyMedSetup.Extract(_target, (done, total) =>
                {
                    int pct = total > 0 ? (int)(100L * done / total) : 0;
                    try
                    {
                        BeginInvoke((Action)(() =>
                        {
                            _bar.Value = Math.Min(100, pct);
                            _status.Text = "Распаковано файлов: " + done + " из " + total;
                        }));
                    }
                    catch { /* окно уже закрыли */ }
                });
                EasyMedSetup.EnsureDataFolder(_target);

                if (!File.Exists(Path.Combine(_target, "EasyMed.exe")))
                    throw new Exception("EasyMed.exe не появился — установка неполная.");

                if (_shortcut != null && _shortcut.Checked)
                {
                    // Ярлык — удобство, а не установка. Не получилось — не повод
                    // объявлять неудачей то, что на самом деле удалось.
                    try { EasyMedSetup.MakeDesktopShortcut(_target); } catch { }
                }
                _error = null;
            }
            catch (Exception e) { _error = e.Message; }

            try { BeginInvoke((Action)(() => Go(3))); } catch { }
        });
        th.IsBackground = true;
        th.Start();
    }

    void PageDone()
    {
        bool ok = _error == null;
        _heading.Text = ok ? "Установка завершена" : "Установка не завершилась";
        _sub.Text = ok ? "Easy-Med готов к работе" : "Ничего не установлено";
        _back.Enabled = false;
        _cancel.Enabled = false;

        if (ok)
        {
            var l = new Label
            {
                AutoSize = false,
                Bounds = new Rectangle(24, 16, 505, 90),
                Text = "Easy-Med установлен в папку:\r\n" + _target + "\r\n\r\n"
                     + "При первом запуске система попросит код активации.",
            };
            _runNow = new CheckBox { Text = "Запустить Easy-Med сейчас", Bounds = new Rectangle(24, 116, 400, 24), Checked = true };
            _body.Controls.Add(l);
            _body.Controls.Add(_runNow);
        }
        else
        {
            var l = new Label
            {
                AutoSize = false,
                Bounds = new Rectangle(24, 16, 505, 140),
                ForeColor = Color.FromArgb(170, 30, 30),
                Text = "Причина: " + _error + "\r\n\r\nСообщите об этом в Easy-Med.",
            };
            _body.Controls.Add(l);
        }
    }

    void OnNext()
    {
        if (_step == 0) { Go(1); return; }

        if (_step == 1)
        {
            string typed = (_path.Text ?? "").Trim().Trim('"');
            if (typed.Length == 0) { Warn("Укажите папку для установки."); return; }
            string full;
            try { full = Path.GetFullPath(typed); }
            catch { Warn("Путь указан неверно."); return; }

            string why;
            if (EasyMedSetup.Forbidden(full, out why)) { Warn(why); return; }

            _target = full;
            Go(2);
            return;
        }

        if (_step == 3)
        {
            if (_error == null && _runNow != null && _runNow.Checked)
            {
                try
                {
                    Process.Start(new ProcessStartInfo(Path.Combine(_target, "EasyMed.exe"))
                    {
                        WorkingDirectory = _target,
                        UseShellExecute = true,
                    });
                }
                catch (Exception e)
                {
                    MessageBox.Show(this, "Не удалось запустить автоматически: " + e.Message
                        + "\n\nЗапустите EasyMed.exe из папки установки.",
                        "Установка Easy-Med", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
            }
            Close();
        }
    }

    void Warn(string text)
    {
        MessageBox.Show(this, text, "Установка Easy-Med", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }
}
