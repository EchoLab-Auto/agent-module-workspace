//! 只读 git 采集（带硬超时）。
//!
//! 从 Core 内置插件原样搬出：行为、超时、明细配额、porcelain 解析都未改。
//! 唯一的变化是类型来自 [`crate::wire`]。

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::wire::{WorkspaceChangedEntry, WorkspaceGitInfo};

/// 单次 `git` 调用的硬超时。
pub const GIT_TIMEOUT: Duration = Duration::from_secs(5);
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

/// Run `git -C <dir> <args…>` with a hard timeout. Stdout/stderr are drained
/// on dedicated threads so a verbose command cannot deadlock on a full pipe.
fn run_git(dir: &str, args: &[&str]) -> GitOutcome {
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

    let deadline = Instant::now() + GIT_TIMEOUT;
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
                        GIT_TIMEOUT.as_secs()
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
    // 明细按**类别各自**截断：一个目录里上百个未跟踪构建产物不能把仅有的几条
    // 暂存改动挤出清单——UI 上就是标题写着「已暂存 2」、点开却空空如也。
    if let GitOutcome::Ok(out) = run_git(directory, &["status", "--porcelain"]) {
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
    // 最近一次提交摘要（仓库无提交时失败 → None）。
    if let GitOutcome::Ok(out) = run_git(directory, &["log", "-1", "--pretty=format:%h %s"]) {
        let line = out.trim();
        if !line.is_empty() {
            info.last_commit = Some(line.to_string());
        }
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
