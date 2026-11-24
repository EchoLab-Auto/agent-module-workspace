//! 只读 git 采集（带硬超时）。
//!
//! 从 Core 内置模块原样搬出：行为、超时、明细配额、porcelain 解析都未改。
//! 唯一的变化是类型来自 [`crate::wire`]。

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::wire::{WorkspaceChangedEntry, WorkspaceGitInfo};

/// 单次**本地** `git` 调用的硬超时（`rev-parse` / `status` / `log` 这类）。
pub const GIT_TIMEOUT: Duration = Duration::from_secs(5);

/// 单次 `git fetch` 的硬超时。
///
/// 45s 而不是 [`GIT_TIMEOUT`]：fetch 真的会连远端，弱网或大仓库（首次拉几万
/// 个对象）下 5s 必然误判。仍然要有上限——没有上限时一个挂住的对端会把
/// 面板的「获取远端」永远转下去，而用户看不到任何进度。
pub const GIT_FETCH_TIMEOUT: Duration = Duration::from_secs(45);
/// 每类变更明细的条数上限（已暂存 / 已修改 / 未跟踪**各算**）。
pub const CHANGED_FILES_CAP: usize = 30;

/// Outcome of one bounded `git` invocation.
enum GitOutcome {
    Ok(String),
    /// Command ran, exited non-zero (message = stderr).
    Failed(String),
    /// Spawn / timeout / pipe error (user-facing).
    Unavailable(String),
}

/// Run `git -C <dir> <args…>` with the default [`GIT_TIMEOUT`].
fn run_git(dir: &str, args: &[&str]) -> GitOutcome {
    run_git_with_timeout(dir, args, GIT_TIMEOUT)
}

/// Run `git -C <dir> <args…>` with a hard timeout. Stdout/stderr are drained
/// on dedicated threads so a verbose command cannot deadlock on a full pipe.
///
/// 超时可传入而不是写死：本地采集（`rev-parse` / `status`）几十毫秒，5s 足够
/// 且卡住要立刻放弃；而 `git fetch` 真的会连远端——同一个 5s 会把弱网下的
/// 正常 fetch 误判成超时。两者共用一个实现（同样的排空与 kill 语义），只差
/// 时间窗。
fn run_git_with_timeout(dir: &str, args: &[&str], timeout: Duration) -> GitOutcome {
    let mut child = match Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_OPTIONAL_LOCKS", "0")
        .spawn()
    {
        Ok(child) => child,
        Err(error) => return GitOutcome::Unavailable(format!("无法执行 git: {error}")),
    };
    let mut stdout = match child.stdout.take() {
        Some(pipe) => pipe,
        None => return GitOutcome::Unavailable("无法读取 git 输出".into()),
    };
    let mut stderr = match child.stderr.take() {
        Some(pipe) => pipe,
        None => return GitOutcome::Unavailable("无法读取 git 输出".into()),
    };
    let out_reader = std::thread::spawn(move || {
        use std::io::Read as _;
        let mut buf = String::new();
        let _ = stdout.read_to_string(&mut buf);
        buf
    });
    let err_reader = std::thread::spawn(move || {
        use std::io::Read as _;
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf);
        buf
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = out_reader.join();
                    let _ = err_reader.join();
                    return GitOutcome::Unavailable(format!(
                        "git 命令超时（>{}s）",
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => return GitOutcome::Unavailable(format!("等待 git 失败: {error}")),
        }
    };
    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    match status {
        Some(status) if status.success() => GitOutcome::Ok(stdout),
        Some(_) => GitOutcome::Failed(stderr.trim().to_string()),
        None => GitOutcome::Unavailable("git 未返回状态".into()),
    }
}

/// `FETCH_HEAD` 的修改时间（unix 秒）。文件不存在 / 读不到 → `None`。
///
/// 只读元数据，不看内容（内容里可能有远端 URL 与凭据形态的东西）。
fn fetch_head_mtime_secs(path: &std::path::Path) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs() as i64)
}

/// 对一个目录执行 `git fetch`（**写**操作：连远端、更新 `.git/FETCH_HEAD`）。
///
/// 返回人读结果：成功为空串，失败为原因。
///
/// ## 为什么用 `fetch --all --prune` 之外的保守组合
///
/// 固定 `--all` + `--prune` 会**删除**远端已删的追踪分支——那是用户的仓库
/// 拓扑，不该由面板的一个刷新按钮替他们决定。这里只 fetch **当前分支的上游**
/// （`@{upstream}` 存在时）或默认远端（`git fetch` 不带参数），并把 `--prune`
/// 留给用户自己在终端决定。
///
/// `--quiet`：fetch 的进度输出走 stderr，几十行 "Receiving objects" 会被
/// [`run_git_with_timeout`] 原样塞进失败原因里（它对非零退出码取 stderr），
/// 而成功时我们又不看它。静默更干净。
pub fn fetch_dir(directory: &str) -> String {
    match run_git_with_timeout(
        directory,
        &["fetch", "--quiet"],
        GIT_FETCH_TIMEOUT,
    ) {
        GitOutcome::Ok(_) => String::new(),
        // 没有配远端（纯本地仓库）是**常态**而不是错误：说清楚，别让用户
        // 以为 fetch 坏了。
        GitOutcome::Failed(stderr) => summarize_fetch_failure(&stderr),
        GitOutcome::Unavailable(message) => message,
    }
}

/// 把 `git fetch` 的 stderr 收敛成一句人读原因。
///
/// 原始 stderr 在两处会很长：SSH 的横幅 + 重试链、镜像站的重定向说明。
/// 面板的悬停提示只放得下一两句，所以取第一条非空行；真正的细节仍在
/// `git fetch` 的终端里可复现（这是"面板给人指向"而不是"面板替代终端"）。
fn summarize_fetch_failure(stderr: &str) -> String {
    let first = stderr
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("git fetch 失败（git 未给出原因）");
    if first.contains("no remote") || first.contains("does not appear to be a git repository") {
        format!("没有可获取的远端：{first}")
    } else {
        first.to_string()
    }
}

/// Collect the read-only git status of one directory (blocking; wrap in
/// `spawn_blocking` on async paths).
pub fn collect_dir_git(directory: &str) -> WorkspaceGitInfo {
    let mut info = WorkspaceGitInfo {
        directory: directory.to_string(),
        ..Default::default()
    };
    if !std::path::Path::new(directory).is_dir() {
        info.error = Some("目录不存在".into());
        return info;
    }
    match run_git(directory, &["rev-parse", "--is-inside-work-tree"]) {
        GitOutcome::Ok(out) if out.trim() == "true" => info.is_repo = true,
        GitOutcome::Ok(_) => {
            info.error = Some("不是 git 仓库".into());
            return info;
        }
        GitOutcome::Failed(stderr) => {
            // 探测失败 = 不是仓库（git 对非仓库目录退出非零）；stderr 仅留调试日志。
            tracing::debug!(directory = %directory, %stderr, "git repo probe failed");
            info.error = Some("不是 git 仓库".into());
            return info;
        }
        GitOutcome::Unavailable(message) => {
            info.error = Some(message);
            return info;
        }
    }

    // 分支名（detached HEAD 时 git 返回 "HEAD"）。
    if let GitOutcome::Ok(out) = run_git(directory, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        let branch = out.trim();
        if !branch.is_empty() {
            info.branch = Some(branch.to_string());
        }
    }
    // 上游全名（`origin/main`）。无上游时 git 退出非零 → 保持 None：
    // 面板据此不显示箭头，而不是显示一对恒为 0 的无意义数字。
    if let GitOutcome::Ok(out) =
        run_git(directory, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
    {
        let name = out.trim();
        if !name.is_empty() && name != "@{upstream}" {
            info.upstream = Some(name.to_string());
        }
    }
    // `ahead`/`behind` 的基准时刻 = `.git/FETCH_HEAD` 的 mtime。
    //
    // 用文件时间而不是"上次我们跑 fetch 的时间"：面板重启、命令行手工 fetch、
    // 别的工具 fetch 都会更新这个文件，而模块自己记的时间只知道自己做过什么。
    // `--git-dir` 而不是拼 `<dir>/.git`：worktree / submodule 的 git 目录不在
    // 工作树里（`.git` 是一行文本指针）。
    if info.upstream.is_some() {
        if let GitOutcome::Ok(out) = run_git(directory, &["rev-parse", "--git-dir"]) {
            let git_dir = out.trim();
            if !git_dir.is_empty() {
                let path = if std::path::Path::new(git_dir).is_absolute() {
                    std::path::PathBuf::from(git_dir)
                } else {
                    std::path::Path::new(directory).join(git_dir)
                };
                info.fetched_at = fetch_head_mtime_secs(&path.join("FETCH_HEAD"));
            }
        }
    }
    // 相对上游的领先/落后（无上游时此命令失败，保持 0/0）。
    if let GitOutcome::Ok(out) = run_git(
        directory,
        &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
    ) {
        let mut parts = out.split_whitespace();
        info.behind = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        info.ahead = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    }
    // 变更清单（porcelain v1：XY<空格>路径；`??` = 未跟踪）。
    //
    // `core.quotepath=false`：git 默认会把非 ASCII 路径转义成八进制
    // （`"\344\270\255\346\226\207.txt"`），面板上就会显示一段谁也读不懂的
    // 转义串——文件名恰恰是这张卡片最要紧的信息。关掉转义后中文路径原样回传。
    // 含空格 / 引号 / 换行的路径仍按 porcelain v1 加引号（那是另一个问题，
    // 要彻底解决得换 `-z`，线格式会变，此处不动）。
    //
    // 明细按**类别各自**截断：一个目录里上百个未跟踪构建产物不能把仅有的几条
    // 暂存改动挤出清单——UI 上就是标题写着「已暂存 2」、点开却空空如也。
    if let GitOutcome::Ok(out) = run_git(
        directory,
        &["-c", "core.quotepath=false", "status", "--porcelain"],
    ) {
        let mut listed = [0usize; 3]; // 已暂存 / 已修改 / 未跟踪
        for line in out.lines() {
            if line.len() < 3 {
                continue;
            }
            let mut chars = line.chars();
            let x = chars.next().unwrap_or(' ');
            let y = chars.next().unwrap_or(' ');
            let path = line[3..].to_string();
            let untracked = x == '?' && y == '?';
            let staged = !untracked && x != ' ' && x != '?';
            let modified = !untracked && y != ' ' && y != '?';
            if untracked {
                info.untracked += 1;
            } else {
                if staged {
                    info.staged += 1;
                }
                if modified {
                    info.modified += 1;
                }
            }
            // 一个文件可以同时落在两类（`MM`）：任一类还有配额就收进明细，
            // 归组交给展示侧（按两列字符自行决定）。
            let room = (staged && listed[0] < CHANGED_FILES_CAP)
                || (modified && listed[1] < CHANGED_FILES_CAP)
                || (untracked && listed[2] < CHANGED_FILES_CAP);
            if room {
                if staged {
                    listed[0] += 1;
                }
                if modified {
                    listed[1] += 1;
                }
                if untracked {
                    listed[2] += 1;
                }
                info.changed_entries.push(WorkspaceChangedEntry {
                    path,
                    index: x.to_string(),
                    worktree: y.to_string(),
                });
            }
        }
        // 扁平路径表由明细派生（老前端的兼容视图），不另维护一份配额。
        info.changed_files = info
            .changed_entries
            .iter()
            .map(|e| e.path.clone())
            .collect();
    }
    // 最近一次提交：摘要与提交时间一次取出（同一子进程，不为此多跑一条）。
    //
    // 用 `%x00` 作分隔符而不是空格：subject 里可能有任意空格，摘要在最前、
    // 时间在中、subject 在尾，三段才切得干净。`%cI` = 提交者时间（ISO 8601 /
    // RFC 3339，带时区），git 2.2 起可用；更老的 git 会让整条命令失败，此时
    // 两项都留空（不显示，而不是显示错的）。
    if let GitOutcome::Ok(out) = run_git(
        directory,
        &["log", "-1", "--pretty=format:%h%x00%cI%x00%s"],
    ) {
        let mut parts = out.trim().split('\0');
        let hash = parts.next().unwrap_or("").trim();
        let time = parts.next().unwrap_or("").trim();
        let subject = parts.next().unwrap_or("").trim();
        if !hash.is_empty() {
            info.last_commit = Some(if subject.is_empty() {
                hash.to_string()
            } else {
                format!("{hash} {subject}")
            });
        }
        if !time.is_empty() {
            info.last_commit_time = Some(time.to_string());
        }
    }
    // stash 条数（只数行数，不看内容）。无 stash 时 `stash list` 输出为空、
    // 退出码 0；不在仓库里早在上面的探测就返回了，走不到这里。
    if let GitOutcome::Ok(out) = run_git(directory, &["stash", "list"]) {
        info.stash = out.lines().filter(|line| !line.trim().is_empty()).count() as u32;
    }
    info
}


#[cfg(test)]
mod tests {
    use super::*;

    /// 临时 git 仓库脚手架：只 `init` + `add`，不依赖全局 git 身份。
    fn scratch_repo(tag: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("echo-git-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let status = std::process::Command::new("git")
            .arg("init")
            .arg("-q")
            .arg(&root)
            .status()
            .expect("git init");
        assert!(status.success(), "git init failed");
        root
    }

    #[test]
    fn collects_changed_entries_with_porcelain_status() {
        let root = scratch_repo("entries");
        std::fs::write(root.join("staged.txt"), "a").unwrap();
        std::fs::write(root.join("both.txt"), "b").unwrap();
        std::fs::write(root.join("loose.txt"), "c").unwrap();
        for file in ["staged.txt", "both.txt"] {
            assert!(std::process::Command::new("git")
                .arg("-C")
                .arg(&root)
                .arg("add")
                .arg(file)
                .status()
                .unwrap()
                .success());
        }
        // 暂存后再改：`AM`（同时属于已暂存与已修改两类）。
        std::fs::write(root.join("both.txt"), "b-changed").unwrap();

        let info = collect_dir_git(root.to_str().unwrap());
        assert!(info.is_repo, "{info:?}");
        assert_eq!(
            (info.staged, info.modified, info.untracked),
            (2, 1, 1),
            "{info:?}"
        );
        let find = |name: &str| {
            info.changed_entries
                .iter()
                .find(|e| e.path == name)
                .unwrap_or_else(|| panic!("{name} missing: {info:?}"))
        };
        assert_eq!(find("both.txt").index, "A");
        assert_eq!(find("both.txt").worktree, "M");
        assert_eq!(find("loose.txt").worktree, "?");
        assert_eq!(info.changed_files.len(), info.changed_entries.len());
        std::fs::remove_dir_all(&root).ok();
    }

    /// 明细配额**按类别各算**：未跟踪刷屏不能把已暂存改动挤出清单。
    #[test]
    fn changed_entries_are_capped_per_category() {
        let root = scratch_repo("cap");
        std::fs::write(root.join("a-staged.txt"), "x").unwrap();
        assert!(std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .arg("add")
            .arg("a-staged.txt")
            .status()
            .unwrap()
            .success());
        for i in 0..(CHANGED_FILES_CAP + 5) {
            std::fs::write(root.join(format!("z-untracked-{i:02}.txt")), "x").unwrap();
        }
        let info = collect_dir_git(root.to_str().unwrap());
        assert_eq!(info.untracked, (CHANGED_FILES_CAP + 5) as u32);
        assert_eq!(
            info.changed_entries
                .iter()
                .filter(|e| e.worktree == "?")
                .count(),
            CHANGED_FILES_CAP
        );
        assert!(
            info.changed_entries
                .iter()
                .any(|e| e.path == "a-staged.txt"),
            "staged change must survive an untracked flood: {info:?}"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    /// 在临时仓库里跑一条 git 命令（失败即 panic，省得测试静默通过）。
    fn git_in(root: &std::path::Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .status()
            .unwrap_or_else(|e| panic!("git {args:?} failed to spawn: {e}"));
        assert!(status.success(), "git {args:?} failed");
    }

    /// porcelain 路径不做八进制转义：中文文件名必须原样回传，否则卡片上
    /// 显示的是 `"\344\270\255\346\226\207.txt"`，用户读不出改了哪个文件。
    #[test]
    fn porcelain_paths_are_not_escaped() {
        let root = scratch_repo("quotepath");
        std::fs::write(root.join("中文.txt"), "x").unwrap();
        let info = collect_dir_git(root.to_str().unwrap());
        assert_eq!(info.untracked, 1, "{info:?}");
        assert_eq!(info.changed_entries[0].path, "中文.txt", "{info:?}");
        std::fs::remove_dir_all(&root).ok();
    }

    /// 冲突（unmerged）条目原样保留两列字符，交由展示侧归类。
    ///
    /// 采集侧不解释 `UU` 的含义——归类（冲突 / 已暂存 / 已修改）是 UI 的决定。
    /// 这条测试钉住"两个 `U` 一路原样送到线格式上"。
    #[test]
    fn unmerged_entries_keep_both_status_columns() {
        let root = scratch_repo("conflict");
        git_in(&root, &["config", "user.email", "t@example.com"]);
        git_in(&root, &["config", "user.name", "t"]);
        std::fs::write(root.join("a.txt"), "base\n").unwrap();
        git_in(&root, &["add", "a.txt"]);
        git_in(&root, &["commit", "-q", "-m", "base"]);
        git_in(&root, &["checkout", "-q", "-b", "side"]);
        std::fs::write(root.join("a.txt"), "side\n").unwrap();
        git_in(&root, &["commit", "-q", "-am", "side"]);
        git_in(&root, &["checkout", "-q", "-"]);
        std::fs::write(root.join("a.txt"), "main\n").unwrap();
        git_in(&root, &["commit", "-q", "-am", "main"]);
        // 合并必然冲突（退出码非零，故不用 git_in）。
        let _ = std::process::Command::new("git")
            .args(["-C", root.to_str().unwrap(), "merge", "side"])
            .output();

        let info = collect_dir_git(root.to_str().unwrap());
        let entry = info
            .changed_entries
            .iter()
            .find(|e| e.path == "a.txt")
            .unwrap_or_else(|| panic!("conflict entry missing: {info:?}"));
        assert_eq!((entry.index.as_str(), entry.worktree.as_str()), ("U", "U"));
        std::fs::remove_dir_all(&root).ok();
    }

    /// 提交时间与 stash 数（2026-10）：一次 `log` 取摘要 + 时间，`stash list`
    /// 只数条数。
    #[test]
    fn collects_commit_time_and_stash_count() {
        let root = scratch_repo("time");
        git_in(&root, &["config", "user.email", "t@example.com"]);
        git_in(&root, &["config", "user.name", "t"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git_in(&root, &["add", "a.txt"]);
        git_in(&root, &["commit", "-q", "-m", "first commit"]);

        let info = collect_dir_git(root.to_str().unwrap());
        assert_eq!(info.last_commit.as_deref().map(|s| s.contains("first commit")), Some(true), "{info:?}");
        // 摘要仍是 `<short-hash> <subject>`（老前端照常显示整串）
        let summary = info.last_commit.clone().unwrap();
        assert!(summary.split(' ').next().map(|h| h.len() >= 7).unwrap_or(false), "{summary}");
        // 时间必须是 RFC 3339（`2026-10-19T10:23:45+08:00` 这种形状）
        let time = info.last_commit_time.clone().expect("commit time");
        assert!(time.len() >= 19 && time.contains('T'), "not RFC3339: {time}");
        assert_eq!(info.stash, 0, "没有 stash 时报 0");

        // 造两条 stash（stash 需要改动才能存）
        for i in 0..2 {
            std::fs::write(root.join("a.txt"), format!("stashed-{i}\n")).unwrap();
            git_in(&root, &["stash", "push", "-q", "-m", &format!("s{i}")]);
        }
        let info = collect_dir_git(root.to_str().unwrap());
        assert_eq!(info.stash, 2, "{info:?}");
        // stash 不影响工作区干净的判断
        assert_eq!((info.staged, info.modified, info.untracked), (0, 0, 0), "{info:?}");
        std::fs::remove_dir_all(&root).ok();
    }

    /// 无提交的空仓库：两个新字段都是缺省（None / 0），不是报错。
    #[test]
    fn empty_repo_reports_no_commit_time() {
        let root = scratch_repo("empty");
        let info = collect_dir_git(root.to_str().unwrap());
        assert!(info.is_repo, "{info:?}");
        assert_eq!(info.last_commit, None);
        assert_eq!(info.last_commit_time, None);
        assert_eq!(info.stash, 0);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn non_repo_and_missing_dirs_report_cleanly() {
        let missing = collect_dir_git("/nonexistent/echo-workspace-git-test");
        assert!(!missing.is_repo);
        assert!(missing.error.unwrap_or_default().contains("目录不存在"));

        let tmp = std::env::temp_dir().join("echo-workspace-nonrepo");
        std::fs::create_dir_all(&tmp).ok();
        let non_repo = collect_dir_git(tmp.to_str().unwrap());
        assert!(!non_repo.is_repo);
        let error = non_repo.error.unwrap_or_default();
        assert!(
            error.contains("不是 git 仓库") || error.contains("无法执行 git"),
            "unexpected: {error}"
        );
    }
}
