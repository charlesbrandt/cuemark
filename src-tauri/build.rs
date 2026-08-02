use std::process::Command;

/// Emit build provenance (git SHA, dirty flag, build time, profile) as compile-time
/// env vars, so the running app can log exactly which code produced it.
///
/// Why: the recurring failure mode in this project is not "the build is stale", it is
/// "nobody knows which build is running". The desktop-launcher binary never auto-rebuilds
/// (see CLAUDE.md) and was once a month behind during a freeze diagnosis; separately, a
/// `cargo tauri dev` rebuild can be in flight while the old binary is still serving the
/// window. Stamping provenance into every log file makes that unambiguous after the fact.
fn main() {
    let sha = git(&["rev-parse", "--short", "HEAD"]).unwrap_or_else(|| "unknown".into());

    // `--quiet` exits non-zero when the worktree differs from HEAD. An error (not in a
    // repo, no git binary) is reported as "unknown" rather than a misleading "clean".
    let dirty = match Command::new("git")
        .args(["diff", "--quiet", "HEAD"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .status()
    {
        Ok(s) if s.success() => "clean",
        Ok(_) => "dirty",
        Err(_) => "unknown",
    };

    let built_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    println!("cargo:rustc-env=CUEMARK_GIT_SHA={sha}");
    println!("cargo:rustc-env=CUEMARK_GIT_DIRTY={dirty}");
    println!("cargo:rustc-env=CUEMARK_BUILT_AT={built_at}");

    // Rebuild when the commit changes, so the stamped SHA doesn't go stale after a
    // commit/checkout that leaves the sources byte-identical. Worktree dirtiness is not
    // tracked here — any edit that makes it dirty already triggers a rebuild on its own.
    if let Some(git_dir) = git(&["rev-parse", "--absolute-git-dir"]) {
        println!("cargo:rerun-if-changed={git_dir}/HEAD");
        if let Some(head_ref) = git(&["symbolic-ref", "--quiet", "HEAD"]) {
            println!("cargo:rerun-if-changed={git_dir}/{head_ref}");
        }
    }

    tauri_build::build()
}

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!s.is_empty()).then_some(s)
}
