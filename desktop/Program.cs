using System.Diagnostics;
using System.Net.Http.Json;
using System.Text.Json;
using System.Drawing.Drawing2D;
using Microsoft.Web.WebView2.WinForms;

namespace Multica.Desktop;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}

internal sealed class MainForm : Form
{
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(4) };
    private readonly System.Windows.Forms.Timer _timer = new() { Interval = 3000 };
    private readonly Label _serviceValue = new();
    private readonly Label _browserValue = new();
    private readonly Label _queueValue = new();
    private readonly Label _detailValue = new();
    private readonly Label _lastAction = new();
    private readonly Panel _serviceDot = new();
    private readonly Panel _browserDot = new();
    private readonly Panel _queueDot = new();
    private readonly Button _openWorkbench = new();
    private readonly Button _continueBatch = new();
    private readonly Button _browserButton = new();
    private readonly Button _stopButton = new();
    private Form? _workbenchWindow;
    private Process? _serverProcess;
    private bool _closing;
    private bool _userRequestedStop;
    private bool _recoveringService;
    private int _recoveryAttempts;
    private bool? _lastLoggedIn;
    private string? _healthProblem;
    private readonly string _root;
    private readonly string _baseUrl;

    private static readonly Color Bg = Color.FromArgb(245, 245, 242);
    private static readonly Color Panel = Color.White;
    private static readonly Color Panel2 = Color.FromArgb(238, 239, 234);
    private static readonly Color Line = Color.FromArgb(226, 230, 225);
    private static readonly Color TextColor = Color.FromArgb(33, 42, 41);
    private static readonly Color Muted = Color.FromArgb(116, 125, 120);
    private static readonly Color Accent = Color.FromArgb(35, 102, 91);
    private static readonly Color Good = Color.FromArgb(39, 143, 103);
    private static readonly Color Warn = Color.FromArgb(190, 129, 37);
    private static readonly Color Bad = Color.FromArgb(191, 73, 73);
    public MainForm()
    {
        _root = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        var port = Environment.GetEnvironmentVariable("MULTICA_PORT") ?? "8765";
        _baseUrl = $"http://127.0.0.1:{port}";
        this.Text = "Multica 本地抽卡工作台";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(980, 660);
        ClientSize = new Size(1120, 720);
        BackColor = Bg;
        ForeColor = TextColor;
        Font = new Font("Microsoft YaHei UI", 10F);
        FormBorderStyle = FormBorderStyle.Sizable;
        DoubleBuffered = true;
        BuildUi();
        _timer.Tick += async (_, _) =>
        {
            if (!await IsHealthyAsync()) await RecoverExitedServiceAsync();
            await RefreshStatusAsync();
        };
        Shown += async (_, _) =>
        {
            SetAction("正在启动本地工作台…");
            await StartServiceAsync();
            await RefreshStatusAsync();
        };
        FormClosing += async (_, e) =>
        {
            if (_closing) return;
            if (_serverProcess is not { HasExited: false })
            {
                _closing = true;
                _timer.Stop();
                return;
            }

            e.Cancel = true;
            var activity = await ReadActiveWorkAsync();
            if (activity is null)
            {
                SetAction("无法确认任务是否已结束；为避免中断生成，请先恢复本地服务连接。", true);
                return;
            }
            if (activity.Value)
            {
                SetAction("仍有任务运行或待人工核查。请先在工作台处理任务，再关闭软件。", true);
                return;
            }

            _closing = true;
            _timer.Stop();
            StopOwnedServer();
            BeginInvoke(Close);
        };
    }

    private void BuildUi()
    {
        SuspendLayout();
        var shell = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, BackColor = Bg };
        shell.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 248));
        shell.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        Controls.Add(shell);

        var side = new Panel { Dock = DockStyle.Fill, Padding = new Padding(22, 26, 18, 20), BackColor = Color.White };
        side.Paint += (_, e) => { using var pen = new Pen(Line); e.Graphics.DrawLine(pen, side.Width - 1, 0, side.Width - 1, side.Height); };
        shell.Controls.Add(side, 0, 0);
        var brand = new Label { Text = "M", AutoSize = false, Size = new Size(42, 42), Location = new Point(22, 24), BackColor = Accent, ForeColor = Color.White, Font = new Font("Segoe UI", 21, FontStyle.Bold), TextAlign = ContentAlignment.MiddleCenter };
        side.Controls.Add(brand);
        var title = NewLabel("Multica", 20, FontStyle.Bold, TextColor); title.Location = new Point(76, 24); title.AutoSize = true; side.Controls.Add(title);
        var subtitle = NewLabel("本地抽卡工作台", 9.5F, FontStyle.Regular, Muted); subtitle.Location = new Point(77, 55); subtitle.AutoSize = true; side.Controls.Add(subtitle);
        var version = NewLabel("WINDOWS 桌面版  ·  1.0", 8.5F, FontStyle.Bold, Muted); version.Location = new Point(24, 91); version.AutoSize = true; side.Controls.Add(version);

        var navCaption = NewLabel("工作空间", 9, FontStyle.Bold, Muted); navCaption.Location = new Point(24, 139); navCaption.AutoSize = true; side.Controls.Add(navCaption);
        var nav = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, Location = new Point(15, 163), Size = new Size(214, 252), BackColor = Color.Transparent, Margin = Padding.Empty };
        side.Controls.Add(nav);
        nav.Controls.Add(MakeNavButton("▦   工作台总览", OpenWorkbench, true));
        nav.Controls.Add(MakeNavButton("◉   登录浏览器", () => _ = StartBrowser()));
        nav.Controls.Add(MakeNavButton("▣   打开成品目录", OpenOutput));
        nav.Controls.Add(MakeNavButton("⌂   打开安装目录", OpenRoot));
        nav.Controls.Add(MakeNavButton("Ⅱ   停止本地服务", () => _ = StopServiceAsync()));

        var safety = new Panel { Location = new Point(20, 445), Size = new Size(196, 110), BackColor = Color.FromArgb(245, 245, 242), Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom };
        var safetyTitle = NewLabel("操作始终由你掌控", 9.5F, FontStyle.Bold, TextColor); safetyTitle.Location = new Point(12, 12); safetyTitle.AutoSize = true; safety.Controls.Add(safetyTitle);
        var safetyText = NewLabel("登录与付费提交需要你在工作台内明确确认。\n本程序不会读取或显示账户凭据。", 8.5F, FontStyle.Regular, Muted); safetyText.Location = new Point(12, 36); safetyText.Size = new Size(170, 54); safetyText.AutoSize = false; safety.Controls.Add(safetyText);
        side.Controls.Add(safety);
        var copyright = NewLabel("MULTICA  LOCAL STUDIO", 8, FontStyle.Bold, Muted); copyright.AutoSize = true; copyright.Location = new Point(23, 625); copyright.Anchor = AnchorStyles.Left | AnchorStyles.Bottom; side.Controls.Add(copyright);

        var body = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 5, BackColor = Bg, Padding = new Padding(34, 27, 34, 26) };
        body.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        body.RowStyles.Add(new RowStyle(SizeType.Absolute, 93));
        body.RowStyles.Add(new RowStyle(SizeType.Absolute, 142));
        body.RowStyles.Add(new RowStyle(SizeType.Absolute, 214));
        body.RowStyles.Add(new RowStyle(SizeType.Absolute, 164));
        body.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        shell.Controls.Add(body, 1, 0);

        var header = new Panel { Dock = DockStyle.Fill, BackColor = Color.Transparent };
        var eyebrow = NewLabel("LOCAL CONTROL CENTER", 8.5F, FontStyle.Bold, Accent); eyebrow.Location = new Point(0, 0); eyebrow.AutoSize = true; header.Controls.Add(eyebrow);
        var heading = NewLabel("工作台总览", 25, FontStyle.Bold, TextColor); heading.Location = new Point(0, 22); heading.AutoSize = true; header.Controls.Add(heading);
        var description = NewLabel("查看本机服务、浏览器与近期作业状态。", 10, FontStyle.Regular, Muted); description.Location = new Point(2, 59); description.AutoSize = true; header.Controls.Add(description);
        _detailValue.Text = "正在检查本机状态…"; _detailValue.ForeColor = Muted; _detailValue.AutoSize = false; _detailValue.TextAlign = ContentAlignment.MiddleRight; _detailValue.Dock = DockStyle.Right; _detailValue.Width = 360; header.Controls.Add(_detailValue);
        body.Controls.Add(header, 0, 0);

        var statusGrid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 1, BackColor = Color.Transparent, Padding = new Padding(0, 2, 0, 12) };
        for (var i = 0; i < 3; i++) statusGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.333F));
        statusGrid.Controls.Add(MakeStatusCard("本地服务", "正在检查", "桥接服务运行状态", _serviceValue, _serviceDot), 0, 0);
        statusGrid.Controls.Add(MakeStatusCard("可见浏览器", "未启动", "登录由你本人完成", _browserValue, _browserDot), 1, 0);
        statusGrid.Controls.Add(MakeStatusCard("任务队列", "等待读取", "本机已记录作业", _queueValue, _queueDot), 2, 0);
        body.Controls.Add(statusGrid, 0, 1);

        var actionCard = MakeCard(); actionCard.Dock = DockStyle.Fill; actionCard.Padding = new Padding(24, 19, 24, 18);
        var actionEyebrow = NewLabel("QUICK ACCESS", 8.5F, FontStyle.Bold, Accent); actionEyebrow.Location = new Point(24, 18); actionEyebrow.AutoSize = true; actionCard.Controls.Add(actionEyebrow);
        var actionTitle = NewLabel("继续你的创作", 17, FontStyle.Bold, TextColor); actionTitle.Location = new Point(24, 41); actionTitle.AutoSize = true; actionCard.Controls.Add(actionTitle);
        var actionSub = NewLabel("打开工作台管理批次与回执；需要登录时，再启动可见浏览器。", 9.5F, FontStyle.Regular, Muted); actionSub.Location = new Point(26, 72); actionSub.AutoSize = true; actionCard.Controls.Add(actionSub);
        _openWorkbench.Text = "打开任务队列   ›"; StyleButton(_openWorkbench, true); _openWorkbench.Location = new Point(24, 111); _openWorkbench.Size = new Size(184, 42); _openWorkbench.Click += (_, _) => OpenWorkbench(); actionCard.Controls.Add(_openWorkbench);
        _continueBatch.Text = "继续最近批次"; StyleButton(_continueBatch, false); _continueBatch.Location = new Point(218, 111); _continueBatch.Size = new Size(170, 42); _continueBatch.Click += (_, _) => OpenLatestBatch(); actionCard.Controls.Add(_continueBatch);
        _browserButton.Text = "打开登录浏览器"; StyleButton(_browserButton, false); _browserButton.Location = new Point(398, 111); _browserButton.Size = new Size(160, 42); _browserButton.Click += async (_, _) => await StartBrowser(); actionCard.Controls.Add(_browserButton);
        _stopButton.Text = "停止服务"; StyleButton(_stopButton, false); _stopButton.Location = new Point(568, 111); _stopButton.Size = new Size(120, 42); _stopButton.Click += StopButtonClick; actionCard.Controls.Add(_stopButton);
        var note = NewLabel("继续批次会先打开最近记录；真正提交仍需你勾选费用确认。", 8.5F, FontStyle.Regular, Muted); note.Location = new Point(25, 166); note.AutoSize = true; actionCard.Controls.Add(note);
        body.Controls.Add(actionCard, 0, 2);

        var logCard = MakeCard(); logCard.Dock = DockStyle.Fill; logCard.Padding = new Padding(22, 18, 22, 16);
        var logTitle = NewLabel("最近活动", 13, FontStyle.Bold, TextColor); logTitle.Location = new Point(22, 17); logTitle.AutoSize = true; logCard.Controls.Add(logTitle);
        var logHint = NewLabel("本程序的最近一次本地操作", 8.5F, FontStyle.Regular, Muted); logHint.Location = new Point(23, 43); logHint.AutoSize = true; logCard.Controls.Add(logHint);
        var separator = new Panel { BackColor = Line, Location = new Point(22, 68), Height = 1, Anchor = AnchorStyles.Left | AnchorStyles.Top | AnchorStyles.Right }; separator.Width = 750; logCard.Controls.Add(separator);
        _lastAction.Text = "等待操作"; _lastAction.ForeColor = Muted; _lastAction.AutoSize = false; _lastAction.Location = new Point(23, 82); _lastAction.Size = new Size(750, 32); _lastAction.Anchor = AnchorStyles.Left | AnchorStyles.Top | AnchorStyles.Right; logCard.Controls.Add(_lastAction);
        var path = NewLabel("任务、回执和成品保存在本机；关闭窗口不会自动清理。", 8.5F, FontStyle.Regular, Muted); path.Location = new Point(23, 122); path.AutoSize = true; logCard.Controls.Add(path);
        body.Controls.Add(logCard, 0, 3);
        ResumeLayout(true);
    }

    private static Label NewLabel(string text, float size, FontStyle style, Color color) => new() { Text = text, Font = new Font("Microsoft YaHei UI", size, style), ForeColor = color, BackColor = Color.Transparent };
    private static Panel MakeCard() => new() { BackColor = Panel, BorderStyle = BorderStyle.FixedSingle, Margin = new Padding(0, 0, 12, 0) };

    private Panel MakeStatusCard(string title, string value, string caption, Label valueLabel, Panel dot)
    {
        var card = MakeCard(); card.Dock = DockStyle.Fill; card.Margin = new Padding(0, 0, 12, 0); card.Padding = new Padding(18);
        var label = NewLabel(title, 9, FontStyle.Bold, Muted); label.Location = new Point(18, 14); label.AutoSize = true; card.Controls.Add(label);
        dot.Size = new Size(8, 8); dot.Location = new Point(19, 48); dot.BackColor = Warn; card.Controls.Add(dot);
        valueLabel.Text = value; valueLabel.Font = new Font("Microsoft YaHei UI", 13, FontStyle.Bold); valueLabel.ForeColor = TextColor; valueLabel.AutoSize = false; valueLabel.Location = new Point(34, 39); valueLabel.Size = new Size(230, 27); card.Controls.Add(valueLabel);
        var sub = NewLabel(caption, 8.5F, FontStyle.Regular, Muted); sub.Location = new Point(18, 76); sub.AutoSize = true; card.Controls.Add(sub);
        return card;
    }

    private Button MakeNavButton(string text, Action action, bool selected = false)
    {
        var b = new Button { Text = text, Width = 214, Height = 41, TextAlign = ContentAlignment.MiddleLeft, FlatStyle = FlatStyle.Flat, BackColor = selected ? Color.FromArgb(237, 243, 251) : Color.Transparent, ForeColor = selected ? Accent : TextColor, Font = new Font("Microsoft YaHei UI", 9.5F, selected ? FontStyle.Bold : FontStyle.Regular), Margin = new Padding(0, 3, 0, 3), Padding = new Padding(12, 0, 0, 0), Cursor = Cursors.Hand };
        b.FlatAppearance.BorderSize = 0; b.FlatAppearance.MouseOverBackColor = Color.FromArgb(238, 239, 234); b.Click += (_, _) => action(); return b;
    }

    private static void StyleButton(Button button, bool primary)
    {
        button.FlatStyle = FlatStyle.Flat; button.FlatAppearance.BorderSize = primary ? 0 : 1; button.FlatAppearance.BorderColor = Line; button.FlatAppearance.MouseOverBackColor = primary ? Color.FromArgb(28, 65, 49) : Color.FromArgb(238, 239, 234); button.BackColor = primary ? Accent : Color.White; button.ForeColor = primary ? Color.White : TextColor; button.Font = new Font("Microsoft YaHei UI", 9, FontStyle.Bold); button.Cursor = Cursors.Hand;
    }
    private async Task StartServiceAsync()
    {
        _userRequestedStop = false;
        var existingHealth = await ReadBridgeHealthAsync();
        if (existingHealth.Compatible) { SetAction("\u672c\u5730\u670d\u52a1\u5df2\u7ecf\u5728\u8fd0\u884c\uff1b\u5f53\u524d\u8fde\u63a5\u5230\u672c\u5b89\u88c5\u7684\u6865\u63a5\u3002"); _timer.Start(); return; }
        if (existingHealth.Responding) { SetAction(existingHealth.Problem ?? "\u672c\u5730\u7aef\u53e3\u88ab\u4e0d\u517c\u5bb9\u7684\u6865\u63a5\u5360\u7528\uff1b\u8bf7\u5173\u95ed\u8be5\u6865\u63a5\u540e\u91cd\u8bd5\u3002", true); _timer.Start(); return; }
        if (_serverProcess is { HasExited: false }) { SetAction("\u6865\u63a5\u8fdb\u7a0b\u4ecd\u5728\u8fd0\u884c\uff0c\u6682\u4e0d\u91cd\u590d\u542f\u52a8\u3002", true); return; }
        var python = FindPython();
        var node = FindNode();
        var script = Path.Combine(_root, "mj-automation", "scripts", "server.py");
        var playwrightPackage = Path.Combine(_root, "runtime", "node_modules", "playwright", "package.json");
        if (python is null || node is null || !File.Exists(playwrightPackage) || !File.Exists(script))
        {
            var missing = new List<string>();
            if (python is null) missing.Add("\u5185\u7f6e Python \u53ca\u6865\u63a5\u4f9d\u8d56 FastAPI / Uvicorn / Pydantic");
            if (node is null) missing.Add("\u5185\u7f6e Node.js");
            if (!File.Exists(playwrightPackage)) missing.Add("Playwright ");
            if (!File.Exists(script)) missing.Add("\u6865\u63a5\u670d\u52a1\u6587\u4ef6");
            SetAction("\u5b89\u88c5\u4e0d\u5b8c\u6574\uff0c\u7f3a\u5c11\uff1a" + string.Join("\u3001", missing) + "\u3002\u8bf7\u91cd\u65b0\u5b89\u88c5\u6216\u4fee\u590d\u8f6f\u4ef6\u3002", true);
            return;
        }
        var scripts = Path.Combine(_root, "mj-automation", "scripts");
        var run = Path.Combine(_root, "mj-automation", "run");
        var output = Path.Combine(_root, "mj-automation", "output");
        var jobs = Path.Combine(run, "jobs"); var receipts = Path.Combine(_root, "mj-automation", "receipts"); var archive = Path.Combine(_root, "mj-automation", "archive");
        foreach (var d in new[] { run, output, jobs, receipts, archive, Path.Combine(_root, "runtime", "browser-profile") }) Directory.CreateDirectory(d);
        var psi = new ProcessStartInfo(python, "server.py") { WorkingDirectory = scripts, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        psi.Environment["MJ_BRIDGE_PORT"] = Environment.GetEnvironmentVariable("MULTICA_PORT") ?? "8765";
        psi.Environment["MJ_OUTPUT_DIR"] = output; psi.Environment["MJ_JOBS_DIR"] = jobs; psi.Environment["MJ_RECEIPTS_DIR"] = receipts; psi.Environment["MJ_ARCHIVE_DIR"] = archive;
        psi.Environment["MJ_RUN_DIR"] = run; psi.Environment["MJ_BATCHES_DIR"] = Path.Combine(run, "batches"); psi.Environment["MJ_BATCH_SLOT_ROOT"] = Path.Combine(run, "batch-slots");
        psi.Environment["MXAI_PROFILE"] = Path.Combine(_root, "runtime", "browser-profile"); psi.Environment["MXAI_NODE_MODULES"] = Path.Combine(_root, "runtime", "node_modules"); psi.Environment["MXAI_ADAPTER_PATH"] = Path.Combine(scripts, "mxai_adapter.js"); psi.Environment["MXAI_NODE_EXE"] = node; psi.Environment["MJ_PYTHON"] = python; psi.Environment["MULTICA_INSTALL_ROOT"] = _root;
        var runtimePath = Path.Combine(_root, "runtime", "node");
        psi.Environment["PATH"] = runtimePath + Path.PathSeparator + (psi.Environment.TryGetValue("PATH", out var inheritedPath) ? inheritedPath : Environment.GetEnvironmentVariable("PATH"));
        try { _serverProcess = Process.Start(psi); } catch (Exception) { SetAction("\u672c\u5730\u670d\u52a1\u542f\u52a8\u5931\u8d25\u3002\u8bf7\u68c0\u67e5\u5185\u7f6e\u8fd0\u884c\u73af\u5883\u548c\u7aef\u53e3\u5360\u7528\u3002", true); return; }
        if (_serverProcess is not null)
        {
            // Drain both redirected streams to prevent a full pipe from deadlocking the bridge.
            _serverProcess.OutputDataReceived += (_, _) => { };
            _serverProcess.ErrorDataReceived += (_, _) => { };
            _serverProcess.BeginOutputReadLine();
            _serverProcess.BeginErrorReadLine();
        }
        for (var i = 0; i < 40; i++)
        {
            await Task.Delay(500);
            if (await IsHealthyAsync()) { SetAction("\u672c\u5730\u670d\u52a1\u5df2\u542f\u52a8\uff0c\u53ef\u4ee5\u6253\u5f00\u4e2d\u6587\u5de5\u4f5c\u53f0\u3002"); _timer.Start(); return; }
            if (_serverProcess is { HasExited: true }) break;
        }
        _timer.Start();
        SetAction(_serverProcess is { HasExited: true } ? "\u6865\u63a5\u8fdb\u7a0b\u542f\u52a8\u540e\u7acb\u5373\u9000\u51fa\uff1b\u7cfb\u7edf\u4f1a\u6709\u9650\u6b21\u6570\u5c1d\u8bd5\u6062\u590d\u3002" : "\u672c\u5730\u670d\u52a1\u542f\u52a8\u8d85\u65f6\uff1b\u7cfb\u7edf\u4f1a\u6709\u9650\u6b21\u6570\u5c1d\u8bd5\u6062\u590d\u3002", true);
    }

    private string? FindPython()
    {
        var candidates = new[] { Path.Combine(_root, "runtime", "python", "Scripts", "python.exe"), Path.Combine(_root, "runtime", "python", "python.exe") };
        foreach (var candidate in candidates)
        {
            if (!File.Exists(candidate)) continue;
            try
            {
                var probe = new ProcessStartInfo(candidate, "-c \"import fastapi, uvicorn, pydantic\"")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                using var process = Process.Start(probe);
                if (process is null) continue;
                if (process.WaitForExit(5000) && process.ExitCode == 0) return candidate;
                if (!process.HasExited) process.Kill(true);
            }
            catch (Exception) { }
        }
        return null;
    }

    private string? FindNode()
    {
        var bundled = Path.Combine(_root, "runtime", "node", "node.exe");
        return File.Exists(bundled) ? bundled : null;
    }

    private async Task<(bool Responding, bool Compatible, string? Problem)> ReadBridgeHealthAsync()
    {
        try
        {
            using var response = await _http.GetAsync(_baseUrl + "/health");
            if (!response.IsSuccessStatusCode) return (true, false, "\u672c\u5730\u7aef\u53e3\u54cd\u5e94\u5f02\u5e38\uff0c\u8bf7\u67e5\u770b\u6865\u63a5\u670d\u52a1\u72b6\u6001\u3002");
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            var root = document.RootElement;
            var bridgeId = root.TryGetProperty("bridgeId", out var id) ? id.GetString() : null;
            var installRoot = root.TryGetProperty("installRoot", out var path) ? path.GetString() : null;
            var dependenciesReady = root.TryGetProperty("runtime", out var runtime)
                && runtime.TryGetProperty("ready", out var ready) && ready.ValueKind == JsonValueKind.True;
            if (bridgeId != "multica-local-draw-bridge") return (true, false, "\u672c\u5730\u7aef\u53e3\u88ab\u5176\u4ed6\u7a0b\u5e8f\u5360\u7528\uff0c\u5de5\u4f5c\u53f0\u4e0d\u4f1a\u8fde\u63a5\u672a\u8ba4\u8bc1\u7684\u670d\u52a1\u3002\u8bf7\u5173\u95ed\u5360\u7528\u7a0b\u5e8f\u540e\u91cd\u8bd5\u3002");
            if (string.IsNullOrWhiteSpace(installRoot) || !Path.GetFullPath(installRoot).Equals(Path.GetFullPath(_root), StringComparison.OrdinalIgnoreCase)) return (true, false, "\u6865\u63a5\u5c5e\u4e8e\u53e6\u4e00\u4e2a\u5b89\u88c5\u76ee\u5f55\uff0c\u8bf7\u4ece\u5f53\u524d\u5b89\u88c5\u7684\u684c\u9762\u8f6f\u4ef6\u91cd\u8bd5\u3002");
            if (!dependenciesReady) return (true, false, "\u6865\u63a5\u5df2\u54cd\u5e94\uff0c\u4f46\u5305\u5185\u8fd0\u884c\u4f9d\u8d56\u7f3a\u5931\uff1b\u8bf7\u4fee\u590d\u5b89\u88c5\u3002");
            return (true, true, null);
        }
        catch { return (false, false, null); }
    }

    private async Task<bool> IsHealthyAsync()
    {
        var health = await ReadBridgeHealthAsync();
        _healthProblem = health.Problem;
        return health.Compatible;
    }

    private async Task RefreshStatusAsync()
    {
        try
        {
            var state = await _http.GetFromJsonAsync<JsonElement>(_baseUrl + "/control/state");
            var bridgeHealth = await ReadBridgeHealthAsync();
            _healthProblem = bridgeHealth.Problem;
            var health = bridgeHealth.Compatible && state.TryGetProperty("health", out var h) && h.TryGetProperty("ok", out var ok) && ok.GetBoolean();
            var browser = state.TryGetProperty("browser", out var br) && br.TryGetProperty("running", out var running) && running.GetBoolean();
            var logged = br.ValueKind == JsonValueKind.Object && br.TryGetProperty("loggedIn", out var li) && li.GetBoolean();
            var jobs = state.TryGetProperty("jobs", out var j) && j.TryGetProperty("items", out var items) ? items.GetArrayLength() : 0;
            var receipts = state.TryGetProperty("receipts", out var r) && r.TryGetProperty("items", out var ri) ? ri.GetArrayLength() : 0;
            SetStatus(_serviceValue, _serviceDot, health ? "已连接" : "不可用", health ? Good : Bad);
            SetStatus(_browserValue, _browserDot, !browser ? "未启动" : logged ? "已登录" : "已启动，未登录", !browser ? Warn : logged ? Good : Warn);
            SetStatus(_queueValue, _queueDot, jobs == 0 ? "暂无作业" : $"{jobs} 个作业", jobs == 0 ? Muted : Good);
            _detailValue.Text = $"作业 {jobs} · 回执 {receipts} · 每 3 秒更新";
            if (_lastLoggedIn is null || _lastLoggedIn.Value != logged)
            {
                SetAction(logged ? "已自动检测到共享浏览器已登录。" : browser ? "检测到浏览器尚未登录，请在可见窗口完成登录。" : "可见浏览器未启动。");
                _lastLoggedIn = logged;
            }
            _openWorkbench.Enabled = health; _browserButton.Enabled = health;
            var ownedProcessRunning = _serverProcess is { HasExited: false };
            _stopButton.Enabled = health ? ownedProcessRunning : !_recoveringService;
            _stopButton.Text = health ? (ownedProcessRunning ? "停止服务" : "服务由其他程序运行") : (_recoveringService ? "正在恢复…" : "启动服务");
        }
        catch { SetStatus(_serviceValue, _serviceDot, "不可用", Bad); _detailValue.Text = "无法读取本机状态"; _openWorkbench.Enabled = false; _browserButton.Enabled = false; }
    }

    private static void SetStatus(Label value, Panel dot, string text, Color color) { value.Text = text; value.ForeColor = color == Bad ? Bad : color == Muted ? Muted : color == Warn ? Warn : TextColor; dot.BackColor = color; }
    private void SetAction(string text, bool bad = false) { if (IsDisposed) return; _lastAction.Text = $"{DateTime.Now:HH:mm:ss}  {text}"; _lastAction.ForeColor = bad ? Bad : Muted; }
    private void OpenWorkbench() { OpenWorkbenchUrl(_baseUrl + "/control"); }
    private void OpenLatestBatch() { OpenWorkbenchUrl(_baseUrl + "/control?focus=latest"); }
    private void OpenWorkbenchUrl(string url)
    {
        try
        {
            if (_workbenchWindow is { IsDisposed: false })
            {
                _workbenchWindow.WindowState = FormWindowState.Normal;
                _workbenchWindow.Activate();
                if (url.EndsWith("?focus=latest", StringComparison.Ordinal))
                {
                    var existingView = _workbenchWindow.Controls.OfType<WebView2>().FirstOrDefault();
                    if (existingView is not null) _ = FocusLatestBatchAsync(existingView, url);
                }
                return;
            }
            var view = new WebView2 { Dock = DockStyle.Fill, CreationProperties = new CoreWebView2CreationProperties { UserDataFolder = Path.Combine(_root, "runtime", "webview-profile") } };
            var window = new Form { Text = "Multica 任务工作台", StartPosition = FormStartPosition.CenterScreen, Width = 1440, Height = 940, MinimumSize = new Size(1050, 700), BackColor = Bg };
            window.Controls.Add(view);
            window.FormClosed += (_, _) => { _workbenchWindow = null; view.Dispose(); };
            _workbenchWindow = window;
            window.Show(this);
            _ = InitializeWorkbenchAsync(view, url);
            SetAction("已在 Multica 窗口内打开任务工作台。");
        }
        catch (Exception ex) { SetAction("内置工作台启动失败，请确认 Microsoft Edge WebView2 Runtime 已安装：" + ex.Message, true); }
    }
    private async Task FocusLatestBatchAsync(WebView2 view, string url)
    {
        try
        {
            if (view.CoreWebView2 is null) await InitializeWorkbenchAsync(view, url);
            else await view.CoreWebView2.ExecuteScriptAsync("window.MulticaWorkbench?.openLatestBatch();");
        }
        catch (Exception ex) { SetAction("最近批次打开失败：" + ex.Message, true); }
    }
    private async Task InitializeWorkbenchAsync(WebView2 view, string url)
    {
        try { await view.EnsureCoreWebView2Async(); view.CoreWebView2.Navigate(url); }
        catch (Exception ex) { SetAction("内置工作台加载失败，请确认本地桥接仍在运行：" + ex.Message, true); }
    }
    private void OpenOutput() => OpenFolder(Path.Combine(_root, "mj-automation", "output"), "成品目录");
    private void OpenRoot() => OpenFolder(_root, "安装目录");
    private void OpenFolder(string path, string label) { try { Directory.CreateDirectory(path); Process.Start(new ProcessStartInfo("explorer.exe", $"\"{path}\"") { UseShellExecute = true }); SetAction("已打开" + label + "。"); } catch (Exception ex) { SetAction("打开" + label + "失败：" + ex.Message, true); } }
    private async Task StartBrowser() { try { var response = await _http.PostAsync(_baseUrl + "/control/browser/start", null); var msg = await response.Content.ReadAsStringAsync(); SetAction(response.IsSuccessStatusCode ? "可见登录浏览器已打开，登录状态会自动刷新。" : "打开浏览器失败：" + msg, !response.IsSuccessStatusCode); await RefreshStatusAsync(); } catch (Exception ex) { SetAction("打开浏览器失败：" + ex.Message, true); } }
    private void StopButtonClick(object? sender, EventArgs e)
    {
        if (!_stopButton.Enabled) return;
        if (_stopButton.Text == "\u542f\u52a8\u670d\u52a1") { _recoveryAttempts = 0; _ = StartServiceAsync(); }
        else _ = StopServiceAsync();
    }

    private async Task<bool?> ReadActiveWorkAsync()
    {
        try
        {
            using var response = await _http.GetAsync(_baseUrl + "/control/state");
            if (!response.IsSuccessStatusCode) return null;
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            var root = document.RootElement;
            if (!root.TryGetProperty("batchScheduler", out var scheduler)
                || scheduler.ValueKind != JsonValueKind.Object
                || !scheduler.TryGetProperty("active", out var active)
                || active.ValueKind != JsonValueKind.Array
                || !scheduler.TryGetProperty("manualReview", out var manualReview)
                || manualReview.ValueKind != JsonValueKind.Array
                || !root.TryGetProperty("jobs", out var jobs)
                || jobs.ValueKind != JsonValueKind.Object
                || !jobs.TryGetProperty("items", out var items)
                || items.ValueKind != JsonValueKind.Array
                || !root.TryGetProperty("batches", out var batches)
                || batches.ValueKind != JsonValueKind.Array) return null;

            if (active.GetArrayLength() > 0 || manualReview.GetArrayLength() > 0) return true;
            if (items.EnumerateArray().Any(item => item.TryGetProperty("status", out var status)
                && status.ValueKind == JsonValueKind.String
                && string.Equals(status.GetString(), "running", StringComparison.OrdinalIgnoreCase))) return true;
            if (batches.EnumerateArray().Any(batch => batch.TryGetProperty("status", out var status)
                && status.ValueKind == JsonValueKind.String
                && string.Equals(status.GetString(), "running", StringComparison.OrdinalIgnoreCase))) return true;
            return false;
        }
        catch { return null; }
    }
    private async Task StopServiceAsync()
    {
        if (_serverProcess is not { HasExited: false })
        {
            SetAction("当前本地服务不是由此窗口启动，暂不停止。", true);
            return;
        }
        var active = await ReadActiveWorkAsync();
        if (active is null)
        {
            SetAction("无法确认任务是否已结束；为避免中断生成，服务保持运行。", true);
            return;
        }
        if (active.Value)
        {
            SetAction("仍有任务运行或待人工核查；请先在工作台处理任务。", true);
            return;
        }
        _userRequestedStop = true;
        StopOwnedServer();
        _timer.Stop();
        SetAction("\u5df2\u505c\u6b62\u672c\u7a0b\u5e8f\u542f\u52a8\u7684\u672c\u5730\u6865\u63a5\uff1b\u4efb\u52a1\u72b6\u6001\u4e0e\u6210\u54c1\u5747\u4fdd\u7559\u3002");
        SetStatus(_serviceValue, _serviceDot, "\u5df2\u505c\u6b62", Warn);
    }
    private async Task RecoverExitedServiceAsync()
    {
        if (_closing || _userRequestedStop || _recoveringService) return;
        if (_serverProcess is { HasExited: false }) return;
        if (_recoveryAttempts >= 3)
        {
            _timer.Stop();
            SetAction("\u6865\u63a5\u8fde\u7eed\u6062\u590d\u5931\u8d25 3 \u6b21\uff0c\u5df2\u505c\u6b62\u81ea\u52a8\u5c1d\u8bd5\uff1b\u8bf7\u68c0\u67e5\u5b89\u88c5\u73af\u5883\u6216\u70b9\u51fb\u542f\u52a8\u670d\u52a1\u3002", true);
            return;
        }

        _recoveringService = true;
        _recoveryAttempts++;
        SetAction($"\u6865\u63a5\u8fdb\u7a0b\u5df2\u9000\u51fa\uff0c\u6b63\u5728\u7b2c {_recoveryAttempts}/3 \u6b21\u6062\u590d\uff1b\u4e0d\u4f1a\u91cd\u63d0\u751f\u6210\u4efb\u52a1\u3002");
        try { await StartServiceAsync(); }
        finally { _recoveringService = false; }
    }

    private void StopOwnedServer() { try { if (_serverProcess is { HasExited: false }) _serverProcess.Kill(entireProcessTree: true); } catch { } finally { _serverProcess = null; } }
}
