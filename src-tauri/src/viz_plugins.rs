//! ISF visualization plugin discovery (docs/design/visualization-plugins.md, phase 1, step 1).
//!
//! Plugins live under the app data dir's `visualizations/` folder (created on first use) as
//! either a bare top-level `<name>.fs` file, or a folder holding one ISF fragment shader plus
//! optional extras (a matching `.vs`, image assets, `thumbnail.png`/`.jpg`, a `LICENSE*` file).
//! This module only does *discovery* and *raw source retrieval* — full ISF parsing (the JSON
//! header's `INPUTS`/`PASSES`, not just the three display fields below) happens in TypeScript
//! (`src/lib/renderer/isf/`). See the design doc's "Package layout" section for the on-disk
//! layout this mirrors, and "Phase 1" for what this module is scoped to.
//!
//! Two Tauri commands are exposed: [`viz_list_plugins`] (cheap metadata for the picker) and
//! [`viz_read_plugin`] (full source + asset paths for one plugin, fetched on selection). The
//! pure logic behind both — folder-vs-bare-file discovery, the ISF header extraction, and the
//! plugin-id path-traversal guard — is factored into functions that take a `&Path` rather than
//! an `AppHandle`, so it's unit-testable without a Tauri runtime (see the `tests` module).

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

/// Extensions recognised as image assets when building a folder plugin's `assets` map.
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];
const THUMBNAIL_NAMES: &[&str] = &["thumbnail.png", "thumbnail.jpg"];
const LICENSE_NAMES: &[&str] = &["LICENSE", "LICENSE.txt", "LICENSE.md"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VizPluginInfo {
    pub id: String,
    /// Always "isf" in this phase — Milkdrop (phase 6) will add "milkdrop".
    pub format: String,
    pub name: String,
    pub description: Option<String>,
    pub credit: Option<String>,
    pub categories: Vec<String>,
    pub thumbnail_path: Option<String>,
    pub license_path: Option<String>,
    /// Set, and every other metadata field left at its default, when the plugin couldn't be
    /// read or its ISF header couldn't be parsed. A bad plugin is still listed (with this
    /// filled in for the picker's error badge) rather than silently dropped — see the design
    /// doc's gap #6 (a broken plugin must not just show nothing).
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VizPluginSource {
    pub id: String,
    pub fragment_source: String,
    /// The sibling `<stem>.vs` file's contents, if present (ISF's optional vertex shader
    /// convention).
    pub vertex_source: Option<String>,
    /// File name -> absolute path, for a folder plugin's image assets. Empty for a bare-file
    /// plugin (nothing else lives next to it that could be an asset).
    pub assets: HashMap<String, String>,
}

/// `~/.local/share/com.cuemark.app/visualizations` (Tauri's per-app data dir), created if
/// missing so callers never have to special-case "folder doesn't exist yet" themselves.
pub fn viz_plugins_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("visualizations");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
pub fn viz_list_plugins(app: tauri::AppHandle) -> Result<Vec<VizPluginInfo>, String> {
    let dir = viz_plugins_dir(&app)?;
    let plugins = discover_plugins(&dir);
    let error_count = plugins.iter().filter(|p| p.error.is_some()).count();
    log::info!(
        "[viz] listed {} plugin(s) in {} ({} with errors)",
        plugins.len(),
        dir.display(),
        error_count
    );
    Ok(plugins)
}

#[tauri::command]
pub fn viz_read_plugin(app: tauri::AppHandle, id: String) -> Result<VizPluginSource, String> {
    let dir = viz_plugins_dir(&app)?;
    read_plugin_source(&dir, &id)
}

// ---------------------------------------------------------------------------------------------
// Pure logic (unit-tested below without a Tauri runtime)
// ---------------------------------------------------------------------------------------------

struct IsfHeader {
    description: Option<String>,
    credit: Option<String>,
    categories: Vec<String>,
}

/// Extracts and parses an ISF file's leading `/*{ ... }*/` JSON header. Per the ISF spec, the
/// file must start (after optional BOM/whitespace) with `/*`, and the header is everything up
/// to the first `*/` that follows it — not a nested-comment scan, just the first close.
fn extract_isf_header(contents: &str) -> Result<IsfHeader, String> {
    let no_bom = contents.strip_prefix('\u{FEFF}').unwrap_or(contents);
    let trimmed = no_bom.trim_start();
    let after_open = trimmed
        .strip_prefix("/*")
        .ok_or_else(|| "no ISF header comment (file must start with /* ... */)".to_string())?;
    let end = after_open
        .find("*/")
        .ok_or_else(|| "ISF header comment is not closed with */".to_string())?;
    let header_text = after_open[..end].trim();
    let value: serde_json::Value = serde_json::from_str(header_text)
        .map_err(|e| format!("ISF header is not valid JSON: {e}"))?;

    let description = value
        .get("DESCRIPTION")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let credit = value
        .get("CREDIT")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let categories = value
        .get("CATEGORIES")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| c.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    Ok(IsfHeader {
        description,
        credit,
        categories,
    })
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

/// Builds one `VizPluginInfo` by reading `path` and extracting its header. Never fails the
/// caller — a read or parse error is folded into the `error` field instead, per the "don't
/// fail the whole listing because one entry is unreadable" rule.
fn build_plugin_info(
    path: &Path,
    id: String,
    name: String,
    thumbnail_path: Option<String>,
    license_path: Option<String>,
) -> VizPluginInfo {
    let base = |description, credit, categories, error| VizPluginInfo {
        id: id.clone(),
        format: "isf".to_string(),
        name: name.clone(),
        description,
        credit,
        categories,
        thumbnail_path: thumbnail_path.clone(),
        license_path: license_path.clone(),
        error,
    };

    match fs::read_to_string(path) {
        Ok(contents) => match extract_isf_header(&contents) {
            Ok(header) => base(header.description, header.credit, header.categories, None),
            Err(e) => base(None, None, Vec::new(), Some(e)),
        },
        Err(e) => base(None, None, Vec::new(), Some(format!("failed to read file: {e}"))),
    }
}

fn build_bare_plugin_info(path: &Path, file_name: &str) -> VizPluginInfo {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file_name)
        .to_string();
    build_plugin_info(path, file_name.to_string(), stem, None, None)
}

fn find_named(dir: &Path, candidates: &[&str]) -> Option<String> {
    candidates.iter().find_map(|name| {
        let p = dir.join(name);
        if p.is_file() {
            Some(p.display().to_string())
        } else {
            None
        }
    })
}

/// Lists the `.fs` files directly inside `folder` (non-recursive, hidden files skipped),
/// sorted for a deterministic scan order.
fn list_fs_files(folder: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = match fs::read_dir(folder) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                let is_file = fs::metadata(p).map(|m| m.is_file()).unwrap_or(false);
                let is_fs = p
                    .extension()
                    .map(|e| e.eq_ignore_ascii_case("fs"))
                    .unwrap_or(false);
                let hidden = p
                    .file_name()
                    .and_then(|f| f.to_str())
                    .map(is_hidden)
                    .unwrap_or(true);
                is_file && is_fs && !hidden
            })
            .collect(),
        Err(_) => return Vec::new(),
    };
    files.sort();
    files
}

/// Discovers the plugin(s) inside one top-level subfolder, per the rules in the design doc's
/// "Package layout": a `<folder>.fs` file wins outright; otherwise exactly one `.fs` makes the
/// whole folder one plugin; otherwise (zero, or several with none named after the folder) each
/// `.fs` is listed as its own plugin. Never recurses past this one level.
fn discover_folder_plugins(folder: &Path, folder_name: &str) -> Vec<VizPluginInfo> {
    let fs_files = list_fs_files(folder);
    if fs_files.is_empty() {
        return Vec::new();
    }

    let thumbnail_path = find_named(folder, THUMBNAIL_NAMES);
    let license_path = find_named(folder, LICENSE_NAMES);

    let named_file = folder.join(format!("{folder_name}.fs"));
    if let Some(path) = fs_files.iter().find(|p| **p == named_file) {
        let id = format!("{folder_name}/{folder_name}.fs");
        return vec![build_plugin_info(
            path,
            id,
            folder_name.to_string(),
            thumbnail_path,
            license_path,
        )];
    }

    if fs_files.len() == 1 {
        let path = &fs_files[0];
        let file_name = path.file_name().and_then(|f| f.to_str()).unwrap_or_default();
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(file_name)
            .to_string();
        let id = format!("{folder_name}/{file_name}");
        return vec![build_plugin_info(path, id, stem, thumbnail_path, license_path)];
    }

    fs_files
        .iter()
        .map(|path| {
            let file_name = path.file_name().and_then(|f| f.to_str()).unwrap_or_default();
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(file_name)
                .to_string();
            let id = format!("{folder_name}/{file_name}");
            build_plugin_info(path, id, stem, thumbnail_path.clone(), license_path.clone())
        })
        .collect()
}

/// Scans the plugins directory (one level: bare `.fs` files and subfolders, `milkdrop/`
/// skipped, hidden entries skipped) and returns a deterministically-sorted list. Never panics
/// or fails on an unreadable entry — that entry just carries an `error` instead.
pub fn discover_plugins(dir: &Path) -> Vec<VizPluginInfo> {
    let mut out = Vec::new();

    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return out,
    };

    for entry in entries.filter_map(|e| e.ok()) {
        let Some(file_name) = entry.file_name().to_str().map(|s| s.to_string()) else {
            continue; // non-UTF-8 name; skip rather than mangle an id
        };
        if is_hidden(&file_name) {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };

        if file_type.is_file() {
            let path = entry.path();
            if path.extension().map(|e| e.eq_ignore_ascii_case("fs")).unwrap_or(false) {
                out.push(build_bare_plugin_info(&path, &file_name));
            }
        } else if file_type.is_dir() {
            if file_name.eq_ignore_ascii_case("milkdrop") {
                continue; // phase 6
            }
            out.extend(discover_folder_plugins(&entry.path(), &file_name));
        }
    }

    out.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    out
}

/// Validates a plugin id and resolves it to a canonical path guaranteed to live inside `dir`.
/// Rejects `..` components, absolute paths and backslashes before ever touching the
/// filesystem (so a traversal attempt never gets far enough to canonicalize something like
/// `/etc/passwd`), then canonicalizes both sides and checks containment as a second, filesystem-
/// level guard against symlink tricks.
fn resolve_plugin_path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    if !id.ends_with(".fs") {
        return Err(format!("plugin id must end in .fs: {id}"));
    }
    if id.contains('\\') {
        return Err(format!("plugin id must not contain backslashes: {id}"));
    }
    let candidate = Path::new(id);
    if candidate.is_absolute() {
        return Err(format!("plugin id must not be an absolute path: {id}"));
    }
    if candidate
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!("plugin id must not contain '..': {id}"));
    }

    let canonical_dir = dir
        .canonicalize()
        .map_err(|e| format!("plugins dir not found: {e}"))?;
    let joined = dir.join(candidate);
    let canonical = joined
        .canonicalize()
        .map_err(|e| format!("plugin not found: {id}: {e}"))?;
    if !canonical.starts_with(&canonical_dir) {
        return Err(format!("plugin id resolves outside plugins dir: {id}"));
    }
    Ok(canonical)
}

/// Reads one plugin's full source: the fragment shader, its optional sibling `.vs`, and — for
/// a folder plugin (an id containing `/`) — the folder's image assets by file name.
fn read_plugin_source(dir: &Path, id: &str) -> Result<VizPluginSource, String> {
    let path = resolve_plugin_path(dir, id)?;
    let fragment_source =
        fs::read_to_string(&path).map_err(|e| format!("failed to read {id} as UTF-8: {e}"))?;
    let vertex_source = fs::read_to_string(path.with_extension("vs")).ok();

    let mut assets = HashMap::new();
    if id.contains('/') {
        if let Some(parent) = path.parent() {
            if let Ok(entries) = fs::read_dir(parent) {
                for entry in entries.filter_map(|e| e.ok()) {
                    let p = entry.path();
                    let is_file = fs::metadata(&p).map(|m| m.is_file()).unwrap_or(false);
                    if !is_file {
                        continue;
                    }
                    let is_image = p
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|ext| IMAGE_EXTENSIONS.iter().any(|ie| ie.eq_ignore_ascii_case(ext)))
                        .unwrap_or(false);
                    if !is_image {
                        continue;
                    }
                    if let Some(name) = p.file_name().and_then(|f| f.to_str()) {
                        assets.insert(name.to_string(), p.display().to_string());
                    }
                }
            }
        }
    }

    Ok(VizPluginSource {
        id: id.to_string(),
        fragment_source,
        vertex_source,
        assets,
    })
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// No `tempfile` dev-dependency in this crate (checked Cargo.toml), so tests make their
    /// own unique directory under the OS temp dir and remove it via `Drop` on the way out
    /// (including on panic/assert failure, since `Drop` still runs during unwind here).
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "cuemark-viz-plugins-test-{}-{}-{}",
                std::process::id(),
                n,
                nanos
            ));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const VALID_HEADER: &str = r#"/*{
	"DESCRIPTION": "A test plugin",
	"CREDIT": "Test Author",
	"CATEGORIES": ["Test", "Generator"]
}*/
void main() { gl_FragColor = vec4(1.0); }
"#;

    #[test]
    fn bare_file_plugin() {
        let dir = TempDir::new();
        fs::write(dir.0.join("my-plasma.fs"), VALID_HEADER).unwrap();

        let plugins = discover_plugins(&dir.0);
        assert_eq!(plugins.len(), 1);
        let p = &plugins[0];
        assert_eq!(p.id, "my-plasma.fs");
        assert_eq!(p.name, "my-plasma");
        assert_eq!(p.format, "isf");
        assert_eq!(p.description.as_deref(), Some("A test plugin"));
        assert_eq!(p.credit.as_deref(), Some("Test Author"));
        assert_eq!(p.categories, vec!["Test".to_string(), "Generator".to_string()]);
        assert!(p.error.is_none());
        assert!(p.thumbnail_path.is_none());
        assert!(p.license_path.is_none());
    }

    #[test]
    fn folder_with_named_file() {
        let dir = TempDir::new();
        let folder = dir.0.join("starfield");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("starfield.fs"), VALID_HEADER).unwrap();
        fs::write(folder.join("noise.png"), b"fake png").unwrap();
        fs::write(folder.join("thumbnail.png"), b"fake thumb").unwrap();
        fs::write(folder.join("LICENSE"), b"MIT").unwrap();

        let plugins = discover_plugins(&dir.0);
        assert_eq!(plugins.len(), 1);
        let p = &plugins[0];
        assert_eq!(p.id, "starfield/starfield.fs");
        assert_eq!(p.name, "starfield");
        assert!(p.thumbnail_path.as_ref().unwrap().ends_with("thumbnail.png"));
        assert!(p.license_path.as_ref().unwrap().ends_with("LICENSE"));
    }

    #[test]
    fn folder_with_one_other_fs() {
        let dir = TempDir::new();
        let folder = dir.0.join("wave");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("wave-thing.fs"), VALID_HEADER).unwrap();

        let plugins = discover_plugins(&dir.0);
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].id, "wave/wave-thing.fs");
        assert_eq!(plugins[0].name, "wave-thing");
    }

    #[test]
    fn folder_with_multiple_fs_none_named() {
        let dir = TempDir::new();
        let folder = dir.0.join("pack");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("a.fs"), VALID_HEADER).unwrap();
        fs::write(folder.join("b.fs"), VALID_HEADER).unwrap();

        let plugins = discover_plugins(&dir.0);
        assert_eq!(plugins.len(), 2);
        let ids: Vec<_> = plugins.iter().map(|p| p.id.clone()).collect();
        assert!(ids.contains(&"pack/a.fs".to_string()));
        assert!(ids.contains(&"pack/b.fs".to_string()));
    }

    #[test]
    fn milkdrop_folder_skipped_entirely() {
        let dir = TempDir::new();
        let folder = dir.0.join("milkdrop");
        fs::create_dir_all(&folder).unwrap();
        // Even a well-formed .fs in here must not surface — phase 6 owns this folder.
        fs::write(folder.join("preset.fs"), VALID_HEADER).unwrap();

        let plugins = discover_plugins(&dir.0);
        assert!(plugins.is_empty());
    }

    #[test]
    fn bad_json_header_is_an_error_entry_not_a_dropped_one() {
        let dir = TempDir::new();
        fs::write(dir.0.join("broken.fs"), "/*{ not valid json }*/\nvoid main(){}").unwrap();

        let plugins = discover_plugins(&dir.0);
        assert_eq!(plugins.len(), 1);
        assert!(plugins[0].error.is_some());
    }

    #[test]
    fn missing_header_is_an_error_entry_not_a_dropped_one() {
        let dir = TempDir::new();
        fs::write(dir.0.join("noheader.fs"), "void main(){ gl_FragColor = vec4(1.0); }").unwrap();

        let plugins = discover_plugins(&dir.0);
        assert_eq!(plugins.len(), 1);
        assert!(plugins[0].error.is_some());
    }

    #[test]
    fn header_with_leading_whitespace_still_parses() {
        let dir = TempDir::new();
        let content = format!("\n\n   {VALID_HEADER}");
        fs::write(dir.0.join("padded.fs"), content).unwrap();

        let plugins = discover_plugins(&dir.0);
        assert_eq!(plugins.len(), 1);
        assert!(plugins[0].error.is_none());
        assert_eq!(plugins[0].description.as_deref(), Some("A test plugin"));
    }

    #[test]
    fn vertex_shader_sibling_is_picked_up_when_present() {
        let dir = TempDir::new();
        fs::write(dir.0.join("shader.fs"), VALID_HEADER).unwrap();
        fs::write(dir.0.join("shader.vs"), "// vertex").unwrap();
        fs::write(dir.0.join("no-vs.fs"), VALID_HEADER).unwrap();

        let with_vs = read_plugin_source(&dir.0, "shader.fs").unwrap();
        assert_eq!(with_vs.vertex_source.as_deref(), Some("// vertex"));

        let without_vs = read_plugin_source(&dir.0, "no-vs.fs").unwrap();
        assert!(without_vs.vertex_source.is_none());
    }

    #[test]
    fn folder_plugin_assets_map_is_images_only_bare_file_has_none() {
        let dir = TempDir::new();
        let folder = dir.0.join("assetpack");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("assetpack.fs"), VALID_HEADER).unwrap();
        fs::write(folder.join("noise.png"), b"x").unwrap();
        fs::write(folder.join("tex.JPG"), b"x").unwrap(); // extension match is case-insensitive
        fs::write(folder.join("readme.txt"), b"x").unwrap(); // not an image, excluded

        let src = read_plugin_source(&dir.0, "assetpack/assetpack.fs").unwrap();
        assert_eq!(src.assets.len(), 2);
        assert!(src.assets.contains_key("noise.png"));
        assert!(src.assets.contains_key("tex.JPG"));
        assert!(!src.assets.contains_key("readme.txt"));

        fs::write(dir.0.join("bare.fs"), VALID_HEADER).unwrap();
        let bare_src = read_plugin_source(&dir.0, "bare.fs").unwrap();
        assert!(bare_src.assets.is_empty());
    }

    #[test]
    fn path_traversal_is_rejected() {
        let dir = TempDir::new();
        fs::write(dir.0.join("ok.fs"), VALID_HEADER).unwrap();

        assert!(resolve_plugin_path(&dir.0, "../x.fs").is_err());
        assert!(resolve_plugin_path(&dir.0, "/etc/passwd").is_err());
        assert!(resolve_plugin_path(&dir.0, "a/../../x.fs").is_err());
    }

    #[test]
    fn non_fs_extension_is_rejected() {
        let dir = TempDir::new();
        fs::write(dir.0.join("ok.txt"), "not a shader").unwrap();

        assert!(resolve_plugin_path(&dir.0, "ok.txt").is_err());
    }
}
