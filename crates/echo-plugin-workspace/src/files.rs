//! 文件浏览器与目录选择器的**只读**采集 + 限域校验。
//!
//! 两套边界，别混淆：
//!
//! - [`resolve_within_directories`]：文件浏览器。只允许会话**已声明**的目录
//!   及其子孙（面板浏览项目文件用）。
//! - [`resolve_within_browse_roots`]：目录选择器。允许「浏览根」（家目录 +
//!   各工作区目录）内的任意路径——选新目录时它还没被声明，用前一套会陷入
//!   「要浏览才能选、要选才能浏览」的循环。
//!
//! 两者都用 **canonical 前缀 + `/`** 的字面比较，而不是 `Path::starts_with`：
//! `/a/bc` 不能因为字面前缀是 `/a/b` 就被放行。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::wire::{BrowseRoot, WorkspaceDirectory, WorkspaceFileEntry};

/// 文件浏览器单目录返回条目上限。
pub const FILES_CAP: usize = 500;

/// 把 `path` 解析为会话某个工作区目录内的 canonical 路径。
pub fn resolve_within_directories(
    directories: &[WorkspaceDirectory],
    path: &str,
) -> Result<PathBuf, String> {
    let requested = Path::new(path)
        .canonicalize()
        .map_err(|e| format!("路径不存在或不可访问: {e}"))?;
    for dir in directories {
        if dir.is_remote() {
            continue; // 远程目录不参与本机路径解析
        }
        let Ok(root) = Path::new(dir.path()).canonicalize() else {
            continue; // 目录本身不存在：跳过，由其余目录决定
        };
        if requested == root {
            return Ok(requested);
        }
        let mut prefix = root.as_os_str().to_os_string();
        prefix.push("/");
        if requested
            .as_os_str()
            .as_encoded_bytes()
            .starts_with(prefix.as_encoded_bytes())
        {
            return Ok(requested);
        }
    }
    Err("路径不在该会话的工作区目录内".into())
}

/// 目录选择器的**浏览根**：家目录在首位，其后是各工作区目录（去重）。
///
/// `directories` 是**全部 persona** 的目录并集（插件自己拥有所有 store，
/// 因此不需要宿主代劳）；`labels` 用于把目录映射成人类可读标签。
pub fn browse_roots(
    directories: &[WorkspaceDirectory],
    labels: &HashMap<String, String>,
) -> Vec<BrowseRoot> {
    let mut out: Vec<BrowseRoot> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    // 1) 家目录在首位（最常用）
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            seen.insert(home.clone());
            out.push(BrowseRoot {
                label: "家目录 (~)".into(),
                path: home,
            });
        }
    }
    // 2) 各工作区目录（本机；远程由调用方追加带 node:// 的条目）
    for dir in directories {
        if dir.is_remote() {
            continue;
        }
        let path = dir.path().to_string();
        if !seen.insert(path.clone()) {
            continue;
        }
        let label = labels.get(&path).cloned().unwrap_or_else(|| path.clone());
        out.push(BrowseRoot { label, path });
    }
    out
}

/// 浏览根内校验：`path` 的 canonical 形式必须落在任一浏览根的 canonical
/// 前缀内。
pub fn resolve_within_browse_roots(roots: &[BrowseRoot], path: &str) -> Result<PathBuf, String> {
    let requested = Path::new(path)
        .canonicalize()
        .map_err(|e| format!("路径不存在或不可访问: {e}"))?;
    for root in roots {
        if root.path.starts_with("node://") {
            continue; // 远程根不参与本机解析
        }
        let Ok(root_canonical) = Path::new(&root.path).canonicalize() else {
            continue;
        };
        if requested == root_canonical {
            return Ok(requested);
        }
        let mut prefix = root_canonical.as_os_str().to_os_string();
        prefix.push("/");
        if requested
            .as_os_str()
            .as_encoded_bytes()
            .starts_with(prefix.as_encoded_bytes())
        {
            return Ok(requested);
        }
    }
    Err("路径不在浏览根内（可浏览：家目录与各工作区目录）".into())
}

/// 列出一级子目录（目录选择器用；文件被过滤——选择器只选目录）。
pub fn collect_child_dirs(directory: &Path) -> Result<Vec<WorkspaceFileEntry>, String> {
    let mut entries = collect_dir_files(directory)?;
    entries.retain(|e| e.is_dir);
    Ok(entries)
}

/// List one directory level for the file browser (blocking; read-only).
///
/// 目录在前、文件在后，各自按名称不区分大小写排序；超过 [`FILES_CAP`]
/// 截断。隐藏文件（`.` 开头）跳过——它们是工具链噪音（.git 等）。
pub fn collect_dir_files(directory: &Path) -> Result<Vec<WorkspaceFileEntry>, String> {
    let reader = std::fs::read_dir(directory).map_err(|e| format!("读取目录失败: {e}"))?;
    let mut entries: Vec<WorkspaceFileEntry> = Vec::new();
    for item in reader.flatten() {
        let name = item.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let size = if is_dir {
            0
        } else {
            item.metadata().map(|m| m.len()).unwrap_or(0)
        };
        entries.push(WorkspaceFileEntry {
            name,
            path: item.path().to_string_lossy().to_string(),
            is_dir,
            size,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries.truncate(FILES_CAP);
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_dir_files_sorts_dirs_first_and_skips_hidden() {
        let root = std::env::temp_dir().join(format!("echo-files-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join(".hidden-dir")).unwrap();
        std::fs::write(root.join("b.txt"), "bb").unwrap();
        std::fs::write(root.join("A.txt"), "a").unwrap();
        std::fs::write(root.join(".hidden-file"), "x").unwrap();

        let entries = collect_dir_files(&root).expect("list");
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["src", "A.txt", "b.txt"], "got: {names:?}");
        assert!(entries[0].is_dir);
        assert_eq!(entries[1].size, 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_within_directories_accepts_subtree_rejects_others() {
        let root = std::env::temp_dir().join(format!("echo-scope-test-{}", std::process::id()));
        let other = std::env::temp_dir().join(format!("echo-scope-other-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&other);
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::create_dir_all(&other).unwrap();

        let dirs = vec![WorkspaceDirectory::local(
            root.to_string_lossy().to_string(),
        )];
        assert!(resolve_within_directories(&dirs, root.to_str().unwrap()).is_ok());
        assert!(resolve_within_directories(&dirs, root.join("sub").to_str().unwrap()).is_ok());
        assert!(resolve_within_directories(&dirs, other.to_str().unwrap()).is_err());
        assert!(resolve_within_directories(&dirs, "/nonexistent/echo-scope").is_err());
        // 形似前缀（sibling 同名扩展）不得误放行。
        let sibling =
            std::env::temp_dir().join(format!("echo-scope-test-{}-sibling", std::process::id()));
        std::fs::create_dir_all(&sibling).unwrap();
        assert!(resolve_within_directories(&dirs, sibling.to_str().unwrap()).is_err());

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&other);
        let _ = std::fs::remove_dir_all(&sibling);
    }

    #[test]
    fn browse_roots_include_home_and_workspace_dirs_deduped() {
        let mut labels = HashMap::new();
        labels.insert("/srv/proj".to_string(), "Proj".to_string());
        let dirs = vec![
            WorkspaceDirectory::local("/srv/proj"),
            WorkspaceDirectory::local("/srv/proj"),
            WorkspaceDirectory::Qualified {
                path: "/srv/remote".into(),
                node: Some("gpu-box".into()),
            },
        ];
        let roots = browse_roots(&dirs, &labels);
        assert!(roots[0].path.starts_with('/'), "roots[0]: {:?}", roots[0]);
        assert!(roots
            .iter()
            .any(|r| r.label == "Proj" && r.path == "/srv/proj"));
        assert!(!roots.iter().any(|r| r.path.contains("node://")));
        assert_eq!(roots.iter().filter(|r| r.path == "/srv/proj").count(), 1);
    }

    #[test]
    fn collect_child_dirs_filters_files() {
        let dir = std::env::temp_dir().join(format!("echo-childdirs-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("file.txt"), "x").unwrap();
        let entries = collect_child_dirs(&dir).expect("list");
        assert_eq!(entries.len(), 1, "entries: {entries:?}");
        assert_eq!(entries[0].name, "sub");
        std::fs::remove_dir_all(&dir).ok();
    }
}
