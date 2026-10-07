using System.Diagnostics;
using System.Net.Http.Json;
using System.Text.Json;
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
    private readonly WebView2 _workbenchView = new() { Dock = DockStyle.Fill, Visible = false };
    private readonly TableLayoutPanel _startupPanel = new();
    private readonly Label _startupMessage = new();
    private readonly Button _startupRetry = new();
    private readonly Label _lastAction = new();
    private readonly Panel _noticePanel = new();
    private readonly ToolStripStatusLabel _serviceStatus = new() { Spring = true, TextAlign = ContentAlignment.MiddleLeft };
    private readonly ToolStripMenuItem _stopMenu = new("停止本机服务");
    private bool _workbenchInitializing;
    private bool _workbenchNavigationPending;
    private bool _connectionProblemShown;
    private bool _workbenchReady;
    private bool _workbenchLoadFailed;
    private bool _refreshing;
    private bool _retrying;
    private Process? _serverProcess;
    private bool _closing;
    private bool _userRequestedStop;
    private bool _recoveringService;
    private int _recoveryAttempts;
    private string? _healthProblem;
    private readonly string _root;
    private readonly string _baseUrl;

    private static readonly Color Bg = Color.FromArgb(245, 245, 242);
    private static readonly Color TextColor = Color.FromArgb(33, 42, 41);
    private static readonly Color Muted = Color.FromArgb(116, 125, 120);
    private static readonly Color Accent = Color.FromArgb(35, 102, 91);
    private static readonly Color Bad = Color.FromArgb(191, 73, 73);
    public MainForm()
    {
        _root = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        var port = Environment.GetEnvironmentVariable("MULTICA_PORT") ?? "8765";
        _baseUrl = $"http://127.0.0.1:{port}";
        this.Text = "Multica 创作工作台 · 2026.10.08.2";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(960, 640);
        ClientSize = new Size(1380, 880);
        BackColor = Bg;
        ForeColor = TextColor;
        Font = new Font("Microsoft YaHei UI", 10F);
        FormBorderStyle = FormBorderStyle.Sizable;
        DoubleBuffered = true;
        BuildUi();
        _timer.Tick += async (_, _) =>
        {
            if (_refreshing || _closing || _retrying) return;
            _refreshing = true;
            try
            {
                if (!await IsHealthyAsync()) await RecoverExitedServiceAsync();
                await RefreshStatusAsync();
            }
            finally { _refreshing = false; }
        };
        Shown += async (_, _) => await RetryWorkbenchAsync();
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
        // The creative workbench is the main window, not a second window behind a legacy dashboard.
        _workbenchView.CreationProperties = new CoreWebView2CreationProperties
        {
            UserDataFolder = Path.Combine(_root, "runtime", "webview-profile")
        };
        _workbenchView.NavigationCompleted += (_, e) =>
        {
            if (_closing || (!_workbenchNavigationPending && !_workbenchReady)) return;
            _workbenchNavigationPending = false;
            if (!e.IsSuccess || e.HttpStatusCode >= 400)
            {
                _workbenchLoadFailed = true;
                _workbenchReady = false;
                _workbenchView.Visible = false;
                _startupPanel.Visible = true;
                _startupPanel.BringToFront();
                SetAction($"工作区加载失败（{e.WebErrorStatus}，HTTP {e.HttpStatusCode}）。请重试连接。", true);
                _startupRetry.Enabled = true;
                return;
            }
            _workbenchReady = true;
            _workbenchLoadFailed = false;
            _startupPanel.Visible = false;
            _workbenchView.Visible = true;
            _workbenchView.Focus();
            SetAction("创作工作台已就绪。");
        };
        Controls.Add(_workbenchView);

        _startupPanel.Dock = DockStyle.Fill;
        _startupPanel.ColumnCount = 3;
        _startupPanel.RowCount = 3;
        _startupPanel.BackColor = Bg;
        _startupPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        _startupPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 560));
        _startupPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        _startupPanel.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
        _startupPanel.RowStyles.Add(new RowStyle(SizeType.Absolute, 230));
        _startupPanel.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
        var loading = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, Padding = new Padding(24) };
        loading.Controls.Add(new Label { Text = "Multica 创作工作台", AutoSize = true, Font = new Font("Microsoft YaHei UI", 24, FontStyle.Bold), ForeColor = Accent, Margin = new Padding(0, 0, 0, 16) });
        _startupMessage.Text = "正在连接本机服务，准备你的创作空间…";
        _startupMessage.AutoSize = false;
        _startupMessage.Size = new Size(510, 70);
        loading.Controls.Add(_startupMessage);
        _startupRetry.Text = "重试连接";
        _startupRetry.Size = new Size(140, 40);
        _startupRetry.Enabled = false;
        _startupRetry.Click += async (_, _) => await RetryWorkbenchAsync();
        loading.Controls.Add(_startupRetry);
        _startupPanel.Controls.Add(loading, 1, 1);
        Controls.Add(_startupPanel);
        _startupPanel.BringToFront();

        _noticePanel.Dock = DockStyle.Bottom;
        _noticePanel.Height = 54;
        _noticePanel.BackColor = Color.FromArgb(255, 243, 236);
        _noticePanel.Padding = new Padding(16, 8, 16, 8);
        _noticePanel.Visible = false;
        _lastAction.Dock = DockStyle.Fill;
        _lastAction.TextAlign = ContentAlignment.MiddleLeft;
        _noticePanel.Controls.Add(_lastAction);
        Controls.Add(_noticePanel);

        var status = new StatusStrip { BackColor = Bg, SizingGrip = true };
        _serviceStatus.Text = "正在连接本机服务…";
        status.Items.Add(_serviceStatus);
        var diagnostics = new ToolStripDropDownButton("本机诊断");
        diagnostics.DropDownItems.Add("重试连接", null, async (_, _) => await RetryWorkbenchAsync());
        diagnostics.DropDownItems.Add("打开安装目录", null, (_, _) => OpenRoot());
        _stopMenu.Click += async (_, _) => await StopServiceAsync();
        diagnostics.DropDownItems.Add(_stopMenu);
        status.Items.Add(diagnostics);
        Controls.Add(status);
    }

    private async Task RetryWorkbenchAsync()
    {
        if (_retrying || _closing) return;
        _retrying = true;
        _startupRetry.Enabled = false;
        _workbenchLoadFailed = false;
        _recoveryAttempts = 0;
        try
        {
            SetAction("正在连接本机创作工作台…");
            await StartServiceAsync();
            await RefreshStatusAsync();
        }
        finally
        {
            _retrying = false;
            if (!_workbenchReady) _startupRetry.Enabled = true;
        }
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
        var health = await ReadBridgeHealthAsync();
        if (_closing || IsDisposed) return;
        _healthProblem = health.Problem;
        _serviceStatus.Text = health.Compatible ? "本机服务已连接 · 2026.10.08.2" : "本机服务未连接";
        _stopMenu.Enabled = health.Compatible && _serverProcess is { HasExited: false };
        if (health.Compatible)
        {
            if (_connectionProblemShown)
            {
                _connectionProblemShown = false;
                SetAction("本机服务连接已恢复。");
            }
            // Periodic health checks must not reload the page or discard unsaved creative drafts.
            if (!_workbenchReady && !_workbenchInitializing && !_workbenchNavigationPending && !_workbenchLoadFailed)
                await InitializeWorkbenchAsync();
        }
        else
        {
            _connectionProblemShown = true;
            SetAction(health.Problem ?? "本机服务尚未连接。请重试连接或检查安装目录。", true);
        }
    }

    private void SetAction(string text, bool bad = false)
    {
        if (IsDisposed || _closing) return;
        _lastAction.Text = text;
        _lastAction.ForeColor = bad ? Bad : Muted;
        _noticePanel.Visible = bad;
        if (_startupPanel.Visible)
        {
            _startupMessage.Text = text;
            _startupMessage.ForeColor = bad ? Bad : TextColor;
        }
    }

    private async Task InitializeWorkbenchAsync()
    {
        if (_workbenchInitializing || _workbenchNavigationPending || _workbenchReady || _closing) return;
        _workbenchInitializing = true;
        try
        {
            await _workbenchView.EnsureCoreWebView2Async();
            if (_closing || IsDisposed) return;
            _workbenchNavigationPending = true;
            _workbenchView.CoreWebView2.Navigate(_baseUrl + "/control");
        }
        catch (Exception ex)
        {
            _workbenchNavigationPending = false;
            _workbenchLoadFailed = true;
            SetAction("工作区启动失败，请检查 Microsoft Edge WebView2 Runtime，然后重试：" + ex.Message, true);
            _startupRetry.Enabled = true;
        }
        finally { _workbenchInitializing = false; }
    }
    private void OpenRoot() => OpenFolder(_root, "安装目录");
    private void OpenFolder(string path, string label) { try { Directory.CreateDirectory(path); Process.Start(new ProcessStartInfo("explorer.exe", $"\"{path}\"") { UseShellExecute = true }); SetAction("已打开" + label + "。"); } catch (Exception ex) { SetAction("打开" + label + "失败：" + ex.Message, true); } }
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
        _serviceStatus.Text = "本机服务已停止";
        _stopMenu.Enabled = false;
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
