// Easy-Med installer.
//
// ЧТО ЭТО И ПОЧЕМУ ОНО ПОЯВИЛОСЬ. Клинику ставили сторонним easymedSetup.exe,
// который раскладывал приложение ПЛОСКО в одну папку. Обновление устроено как
// «распаковать рядом и переставить указатель current», поэтому установка без
// versions\<v> и current не может принять обновление НИКОГДА: переставлять
// нечего. Филиал владельца 2026-09-02 скачивал и распаковывал каждый релиз по
// кругу и оставался на 0.6.2, а на экране стояло «доступно обновление».
//
// Этот установщик делает ровно одно: раскладывает то, что уже умеет
// обновляться. Внутри — готовый пакет клиники (make-clinic-package.ps1),
// проверенный по подписи ДО упаковки сюда.
//
// Написан на C# по той же причине, что и лаунчер: csc.exe есть на любой
// Windows, и .exe можно пересобрать где угодно без установки инструментов.
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
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;

static class EasyMedSetup
{
    const string PayloadName = "payload.zip";

    // Куда ставим по умолчанию. Рабочий стол, а не Program Files: в Program
    // Files пишет только администратор, и обновление, запущенное клиникой из-под
    // обычного пользователя, не смогло бы туда ничего распаковать.
    static string DefaultTarget()
    {
        string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        if (string.IsNullOrEmpty(desktop)) desktop = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return Path.Combine(desktop, "EasyMed");
    }

    // Папки, куда ставить нельзя. Не вкусовщина: каждая из них принадлежит
    // администратору или системе, и установка туда ломает ровно то, ради чего
    // этот установщик написан, — способность обновляться самой.
    static bool Forbidden(string full, out string why)
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
                why = "В эту папку пишет только администратор, и тогда система не сможет обновляться сама.";
                return true;
            }
        }
        if (Path.GetPathRoot(full).Equals(full, StringComparison.OrdinalIgnoreCase))
        {
            why = "Нельзя ставить в корень диска — выберите отдельную папку.";
            return true;
        }
        return false;
    }

    static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        Console.Title = "Установка Easy-Med";

        try
        {
            string target = args.Length > 0 ? args[0] : null;

            Console.WriteLine("=== Установка Easy-Med ===");
            Console.WriteLine();

            if (target == null)
            {
                string def = DefaultTarget();
                Console.WriteLine("Куда установить Easy-Med?");
                Console.WriteLine("По умолчанию: " + def);
                Console.Write("Нажмите Enter или введите другой путь: ");
                string typed = Console.ReadLine();
                target = string.IsNullOrWhiteSpace(typed) ? def : typed.Trim().Trim('"');
            }

            string full = Path.GetFullPath(target);
            string why;
            if (Forbidden(full, out why))
            {
                Console.WriteLine();
                Console.WriteLine("Сюда установить нельзя: " + why);
                return Done(2);
            }

            // Обновление поверх существующей установки — обычное дело: так
            // чинят криво поставленную клинику, не теряя записей. data\ здесь
            // единственное, что нельзя трогать.
            bool hasData = Directory.Exists(Path.Combine(full, "data"));
            Console.WriteLine();
            Console.WriteLine("Папка: " + full);
            if (hasData)
            {
                Console.WriteLine("В этой папке уже есть data\\ — лицензия, привязка филиала и база.");
                Console.WriteLine("Они СОХРАНЯЮТСЯ: программа обновится, данные останутся на месте.");
            }
            Console.Write("Продолжить? (д/н): ");
            string ok = (Console.ReadLine() ?? "").Trim().ToLowerInvariant();
            if (ok != "д" && ok != "da" && ok != "y" && ok != "yes" && ok != "")
            {
                Console.WriteLine("Установка отменена.");
                return Done(1);
            }

            Directory.CreateDirectory(full);

            Console.WriteLine();
            Console.WriteLine("Распаковка…");
            int written = Extract(full);
            Console.WriteLine("Готово: файлов записано " + written + ".");

            // data\ создаём, только если её не было: пустая папка нужна, чтобы
            // первый запуск знал, куда класть базу.
            string data = Path.Combine(full, "data");
            if (!Directory.Exists(data)) Directory.CreateDirectory(data);

            string launcher = Path.Combine(full, "EasyMed.exe");
            if (!File.Exists(launcher))
            {
                Console.WriteLine();
                Console.WriteLine("ОШИБКА: EasyMed.exe не появился — установка неполная. Сообщите в Easy-Med.");
                return Done(3);
            }

            Console.WriteLine();
            Console.WriteLine("Установлено.");
            Console.WriteLine("Запускать систему: " + launcher);
            Console.Write("Запустить сейчас? (д/н): ");
            string run = (Console.ReadLine() ?? "").Trim().ToLowerInvariant();
            if (run == "д" || run == "da" || run == "y" || run == "yes" || run == "")
            {
                try
                {
                    Process.Start(new ProcessStartInfo(launcher) { WorkingDirectory = full, UseShellExecute = true });
                }
                catch (Exception e)
                {
                    Console.WriteLine("Не удалось запустить автоматически: " + e.Message);
                    Console.WriteLine("Запустите EasyMed.exe из папки вручную.");
                }
            }
            return Done(0);
        }
        catch (Exception e)
        {
            Console.WriteLine();
            Console.WriteLine("Установка не завершилась: " + e.Message);
            return Done(4);
        }
    }

    // Распаковка ВРУЧНУЮ, а не ZipFile.ExtractToDirectory: тот падает целиком,
    // если хоть один файл уже существует, — а установка поверх существующей
    // папки здесь штатный сценарий, ради которого всё и затевалось.
    static int Extract(string root)
    {
        int n = 0;
        using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(PayloadName))
        {
            if (s == null) throw new Exception("внутри установщика нет пакета (payload.zip)");
            using (var zip = new ZipArchive(s, ZipArchiveMode.Read))
            {
                foreach (ZipArchiveEntry e in zip.Entries)
                {
                    string rel = e.FullName.Replace('/', Path.DirectorySeparatorChar);
                    string dest = Path.GetFullPath(Path.Combine(root, rel));

                    // Zip Slip: запись, чей путь выводит за пределы папки
                    // установки, не распаковывается. Пакет свой, но проверка
                    // стоит здесь потому, что стоить она должна везде.
                    if (!dest.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                        throw new Exception("в пакете запись с недопустимым путём: " + e.FullName);

                    if (rel.EndsWith(Path.DirectorySeparatorChar.ToString()) || e.Length == 0 && string.IsNullOrEmpty(e.Name))
                    {
                        Directory.CreateDirectory(dest);
                        continue;
                    }

                    // data\ клиники не трогаем НИ ПРИ КАКИХ УСЛОВИЯХ: там
                    // лицензия, привязка филиала и вся база.
                    if (rel.StartsWith("data" + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
                        && File.Exists(dest)) continue;

                    Directory.CreateDirectory(Path.GetDirectoryName(dest));
                    e.ExtractToFile(dest, true);
                    n++;
                    if (n % 200 == 0) { Console.Write('.'); }
                }
            }
        }
        if (n >= 200) Console.WriteLine();
        return n;
    }

    // Окно не должно захлопываться: человек, ставящий систему, обязан успеть
    // прочитать, чем всё кончилось. Особенно когда кончилось плохо.
    static int Done(int code)
    {
        Console.WriteLine();
        Console.Write("Нажмите Enter, чтобы закрыть окно…");
        try { Console.ReadLine(); } catch { /* нет консоли — и не надо */ }
        return code;
    }
}
