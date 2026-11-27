//! Security validators for Minecraft launch options, Java executables, JVM args,
//! launch overrides, and HTTPS download domains (1:1 parity with src/main/game-validation.js).

use crate::sandbox::{
    assert_renderer_path_allowed, assert_write_sandbox, is_unc_path, is_under, normalize_lexical,
    resolve_nearest_real_path, safe_data_dir, AccessMode,
};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use url::Url;

pub const ALLOWED_DOWNLOAD_DOMAINS: &[&str] = &[
    "github.com",
    "githubusercontent.com",
    "gitlab.com",
    "modrinth.com",
    "curseforge.com",
    "curseforge.net",
    "cursecdn.com",
    "forgecdn.net",
    "mojang.com",
    "minecraft.net",
    "fabricmc.net",
    "quiltmc.org",
    "minecraftforge.net",
    "neoforged.net",
    "maven.org",
    "bangbang93.com",
    "adoptium.net",
];

pub const MULTI_TENANT_DOMAINS: &[&str] = &[
    "github.com",
    "githubusercontent.com",
    "gitlab.com",
];

pub const ALLOWED_LOADER_META_DOMAINS: &[&str] = &[
    "mojang.com",
    "minecraft.net",
    "minecraftforge.net",
    "neoforged.net",
    "fabricmc.net",
    "quiltmc.org",
    "maven.org",
    "bangbang93.com",
];

pub const ALLOWED_FW_DOMAINS: &[&str] = &[
    "mojang.com",
    "minecraft.net",
    "minecraftforge.net",
    "neoforged.net",
    "fabricmc.net",
    "quiltmc.org",
    "maven.org",
    "bangbang93.com",
    "github.com",
    "githubusercontent.com",
];

pub const ALLOWED_CLIENT_PACKAGE_DOMAINS: &[&str] = &[
    "mojang.com",
    "minecraft.net",
    "minecraftforge.net",
    "neoforged.net",
    "fabricmc.net",
    "quiltmc.org",
    "maven.org",
    "bangbang93.com",
    "github.com",
    "githubusercontent.com",
    "curseforge.com",
    "curseforge.net",
    "cursecdn.net",
    "forgecdn.net",
    "modrinth.com",
];

const VALID_JAVA_NAMES: &[&str] = &["java", "java.exe", "javaw", "javaw.exe"];

const DANGEROUS_JVM_PREFIXES: &[&str] = &[
    "-agentlib:",
    "-agentpath:",
    "-javaagent:",
    "-xbootclasspath",
    "-xrun",
    "-xx:onoutofmemoryerror",
    "-xx:onerror",
    "-xx:flags=",
    "-xx:compilecommand=",
    "-xx:compilecommandfile",
    "-xx:flightrecorderoptions",
    "-xx:startflightrecording=",
    "-xlog:",
    "-xloggc:",
    "-xx:logfile=",
    "-xx:archiveclassesatexit=",
    "-xx:sharedarchivefile=",
    "--patch-module",
    "--module-path=",
    "--upgrade-module-path=",
    "--module=",
    "-p=",
    "-djavax.net.ssl.truststore",
    "-djavax.accessibility.assistive_technologies=",
    "-djava.system.class.loader=",
    "-djava.security.policy=",
    "-djava.security.manager",
    "-djava.security.auth.login.config=",
    "-djava.util.logging.config.class=",
    "-djava.naming.factory.initial=",
    "-djdk.instrument.traceusage",
    "-djava.rmi",
    "-dcom.sun.management.jmxremote",
    "-dcom.sun.management.config.file=",
    "-dorg.lwjgl.librarypath=",
    "-djna.boot.library.path=",
    "-djna.library.path=",
    "-dhttp.proxyhost=",
    "-dhttps.proxyhost=",
    "-dsocksproxyhost=",
    "-djava.class.path=",
    "--class-path=",
    "-dlog4j.configuration=",
    "-dlog4j.configurationfile=",
    "-dlog4j2.configurationfile=",
    "-dlog4j2.formatmsgnolookups=",
    "-djava.io.tmpdir=",
    "-duser.home=",
    "-xshare:",
    "--add-opens=",
    "--add-exports=",
];

const DANGEROUS_JVM_EXACT: &[&str] = &[
    "-agentlib",
    "-agentpath",
    "-javaagent",
    "-xbootclasspath",
    "-xrun",
    "-xx:flags",
    "--patch-module",
    "--module-path",
    "--upgrade-module-path",
    "--module",
    "-m",
    "-p",
    "-cp",
    "-classpath",
    "--class-path",
    "-jar",
    "-djava.library.path",
    "-dorg.lwjgl.librarypath",
    "-djna.boot.library.path",
    "-djna.library.path",
    "-djava.ext.dirs",
    "-djava.security.policy",
    "-djava.security.auth.login.config",
    "-dcom.sun.management.config.file",
    "-dhttp.proxyhost",
    "-dhttps.proxyhost",
    "-dsocksproxyhost",
    "-djava.util.logging.config.class",
    "-djavax.accessibility.assistive_technologies",
    "-djava.naming.factory.initial",
    "-djava.class.path",
    "-dlog4j.configurationfile",
    "-dlog4j2.configurationfile",
    "-dlog4j2.formatmsgnolookups",
    "-djava.io.tmpdir",
    "-duser.home",
    "--add-opens",
    "--add-exports",
    "-xloggc",
];

const BLOCKED_LAUNCH_FLAGS: &[&str] = &[
    "--accesstoken",
    "--session",
    "--uuid",
    "--username",
    "--gamedir",
    "--assetsdir",
    "--assetindex",
    "--proxyhost",
    "--proxyport",
    "--proxyuser",
    "--proxypass",
    "--userproperties",
    "--clientid",
    "--xuid",
];

pub fn is_allowed_domain(hostname: &str, allowed_list: &[&str]) -> bool {
    let clean = hostname.trim().to_lowercase();
    let clean = clean.trim_end_matches('.');
    if clean.is_empty() {
        return false;
    }
    allowed_list.iter().any(|d| {
        let dom = d.to_lowercase();
        clean == dom || clean.ends_with(&format!(".{}", dom))
    })
}

pub fn assert_allowed_https_url(
    url_str: &str,
    label: &str,
    allowed_domains: &[&str],
) -> Result<Url, String> {
    let parsed = Url::parse(url_str).map_err(|_| format!("URL invalide ({}).", label))?;
    if parsed.scheme() != "https" {
        return Err(format!("URL non HTTPS bloquée ({}).", label));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| format!("Hôte manquant ({}).", label))?;
    if !is_allowed_domain(host, allowed_domains) {
        return Err(format!("Domaine non autorisé bloqué ({}: {}).", label, host));
    }
    Ok(parsed)
}

pub fn validate_safe_segment(val: &str, label: &str) -> Result<String, String> {
    let trimmed = val.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed.contains("..")
        || trimmed
            .chars()
            .any(|c| matches!(c, '/' | '\\' | ':') || (c as u32) < 0x20)
    {
        return Err(format!(
            "{} contient des caractères ou séquences interdits ({}).",
            label, trimmed
        ));
    }
    Ok(trimmed.to_string())
}

pub fn validate_java_executable(java_path: &str) -> Result<(), String> {
    let trimmed = java_path.trim();
    if trimmed.is_empty() {
        return Err("Chemin Java invalide bloqué.".into());
    }
    if is_unc_path(trimmed) || trimmed.starts_with('\\') || trimmed.starts_with("//") {
        return Err("Exécution de Java depuis un partage réseau bloquée.".into());
    }
    let base_name = Path::new(trimmed)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !VALID_JAVA_NAMES.contains(&base_name.as_str()) {
        return Err("Chemin Java invalide bloqué.".into());
    }

    // Bare executable name resolved via PATH (e.g. "java" or "javaw.exe")
    if VALID_JAVA_NAMES.contains(&trimmed.to_lowercase().as_str()) {
        if let Ok(path_var) = std::env::var("PATH") {
            for dir in std::env::split_paths(&path_var) {
                let candidate = dir.join(trimmed);
                if candidate.is_file() {
                    let real = resolve_nearest_real_path(&candidate);
                    let parent_name = real
                        .parent()
                        .and_then(|p| p.file_name())
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_lowercase();
                    if parent_name != "bin" {
                        return Err(
                            "L'exécutable Java trouvé dans PATH doit résider dans un dossier bin/ valide."
                                .into(),
                        );
                    }
                    break;
                }
            }
        }
        return Ok(());
    }

    let p = Path::new(trimmed);
    if !p.is_absolute() {
        return Err("Chemin relatif Java non autorisé bloqué.".into());
    }
    let resolved = normalize_lexical(p);
    #[cfg(target_os = "windows")]
    if resolved.to_string_lossy().starts_with(r"\\") {
        return Err("Exécution de Java depuis un partage réseau bloquée.".into());
    }
    let meta = fs::metadata(&resolved).map_err(|_| "Fichier Java introuvable.".to_string())?;
    if !meta.is_file() {
        return Err("Fichier Java introuvable.".into());
    }
    let real_java = resolve_nearest_real_path(&resolved);
    let real_base = real_java
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !VALID_JAVA_NAMES.contains(&real_base.as_str()) {
        return Err("Cible du lien Java invalide bloquée.".into());
    }
    let real_parent = real_java
        .parent()
        .and_then(|d| d.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase();
    if real_parent != "bin" {
        return Err("L'exécutable Java doit résider dans un dossier bin/ valide.".into());
    }

    let tmp_dir = std::env::temp_dir();
    let real_tmp = resolve_nearest_real_path(&tmp_dir);
    let mut blocked_dirs = vec![tmp_dir, real_tmp];
    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        let h = PathBuf::from(home);
        blocked_dirs.push(h.join("Downloads"));
        blocked_dirs.push(h.join("Desktop"));
        blocked_dirs.push(h.join("Documents"));
        blocked_dirs.push(h.join("OneDrive").join("Desktop"));
        blocked_dirs.push(h.join("OneDrive").join("Documents"));
        blocked_dirs.push(h.join(".Trash"));
        blocked_dirs.push(h.join(".local").join("share").join("Trash"));
        #[cfg(target_os = "windows")]
        blocked_dirs.push(h.join("AppData").join("Local").join("Temp"));
    }
    #[cfg(not(target_os = "windows"))]
    {
        blocked_dirs.push(PathBuf::from("/tmp"));
        blocked_dirs.push(PathBuf::from("/var/tmp"));
        blocked_dirs.push(PathBuf::from("/dev/shm"));
    }

    let sandbox = safe_data_dir();
    let runtime_dir = sandbox.join("runtime");
    let java_dir = sandbox.join("java");

    for cand in [&resolved, &real_java] {
        let low = cand.to_string_lossy().to_lowercase();
        let sep = std::path::MAIN_SEPARATOR;
        if blocked_dirs.iter().any(|bd| is_under(cand, bd))
            || low.contains(&format!("{}temp{}", sep, sep))
            || low.contains(&format!("{}$recycle.bin{}", sep, sep))
        {
            return Err("Exécution de Java depuis un dossier temporaire, Corbeille, Documents, Desktop ou de téléchargement bloquée.".into());
        }
        let allowed_sandbox_java = is_under(cand, &runtime_dir) || is_under(cand, &java_dir);
        if is_under(cand, &sandbox) && !allowed_sandbox_java {
            return Err(
                "Exécution de Java depuis un dossier utilisateur du sandbox hors runtime bloquée."
                    .into(),
            );
        }
    }

    Ok(())
}

pub fn validate_custom_jvm_args(raw: Option<&Value>) -> Result<Vec<String>, String> {
    let Some(val) = raw else { return Ok(Vec::new()) };
    if val.is_null() {
        return Ok(Vec::new());
    }
    let arr = val
        .as_array()
        .ok_or_else(|| "customArgs doit être un tableau.".to_string())?;
    if arr.len() > 64 {
        return Err("Trop d'arguments JVM personnalisés (max 64).".into());
    }
    let path_delim = if cfg!(target_os = "windows") { ';' } else { ':' };
    let mut clean = Vec::new();
    for item in arr {
        let s = item
            .as_str()
            .ok_or_else(|| "Chaque argument JVM doit être une chaîne.".to_string())?;
        let trimmed = s.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.contains('\0') || trimmed.contains('\n') || trimmed.contains('\r') {
            return Err("Argument JVM contenant un caractère de contrôle bloqué.".into());
        }
        if trimmed.starts_with('@') {
            return Err(format!("Argfile JVM bloqué ({}).", trimmed));
        }
        let lower = trimmed.to_lowercase();
        if DANGEROUS_JVM_PREFIXES.iter().any(|p| lower.starts_with(p))
            || DANGEROUS_JVM_EXACT.contains(&lower.as_str())
        {
            return Err(format!("Argument JVM à risque bloqué ({}).", trimmed));
        }
        if lower.starts_with("-djava.library.path=")
            || lower.starts_with("-djava.ext.dirs=")
            || lower.starts_with("-xx:errorfile=")
            || lower.starts_with("-xx:heapdumppath=")
        {
            let mode = if lower.starts_with("-xx:errorfile=") || lower.starts_with("-xx:heapdumppath=")
            {
                AccessMode::Write
            } else {
                AccessMode::Read
            };
            if let Some(eq) = trimmed.find('=') {
                for part in trimmed[eq + 1..].trim().split(path_delim) {
                    if !part.is_empty() {
                        let safe = assert_write_sandbox(part)?;
                        assert_renderer_path_allowed(&safe, mode)?;
                    }
                }
            }
        }
        clean.push(trimmed.to_string());
    }
    Ok(clean)
}

pub fn validate_custom_launch_args(raw: Option<&Value>) -> Result<Vec<String>, String> {
    let cleaned = validate_custom_jvm_args(raw)?;
    for arg in &cleaned {
        let lower = arg.to_lowercase();
        let flag_only = lower.split('=').next().unwrap_or("");
        if BLOCKED_LAUNCH_FLAGS.contains(&flag_only) {
            return Err(format!("Argument de lancement réservé bloqué ({}).", arg));
        }
    }
    Ok(cleaned)
}

pub fn validate_launch_overrides(opts: &Value) -> Result<(), String> {
    if let Some(overrides) = opts.get("overrides")
        && !overrides.is_null() {
            let obj = overrides
                .as_object()
                .ok_or_else(|| "opts.overrides invalide.".to_string())?;
            for key in ["directory", "assetRoot", "libraryRoot", "cwd", "gameDirectory", "natives"] {
                if let Some(s) = obj.get(key).and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
                    let safe = assert_write_sandbox(s)?;
                    assert_renderer_path_allowed(&safe, AccessMode::Write)?;
                }
            }
            for key in ["minecraftJar", "versionJson", "log4jConfigurationFile"] {
                if let Some(s) = obj.get(key).and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
                    let safe = assert_write_sandbox(s)?;
                    assert_renderer_path_allowed(&safe, AccessMode::Read)?;
                }
            }
            if let Some(ai) = obj.get("assetIndex").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
                validate_safe_segment(ai, "opts.overrides.assetIndex")?;
            }
            if let Some(classes) = obj.get("classes") {
                let arr = classes
                    .as_array()
                    .ok_or_else(|| "opts.overrides.classes doit être un tableau.".to_string())?;
                for c in arr {
                    if let Some(s) = c.as_str() {
                        let safe = assert_write_sandbox(s)?;
                        assert_renderer_path_allowed(&safe, AccessMode::Read)?;
                    }
                }
            }
            for (url_key, allowlist) in [
                ("url", ALLOWED_LOADER_META_DOMAINS),
                ("fw", ALLOWED_FW_DOMAINS),
            ] {
                if let Some(sub) = obj.get(url_key).filter(|v| !v.is_null()) {
                    let sub_obj = sub
                        .as_object()
                        .ok_or_else(|| format!("opts.overrides.{} invalide.", url_key))?;
                    for (k, v) in sub_obj {
                        if let Some(vs) = v.as_str().map(|s| s.trim()).filter(|s| !s.is_empty())
                            && (k == "baseUrl" || vs.contains("://")) {
                                assert_allowed_https_url(vs, &format!("{}.{}", url_key, k), allowlist)?;
                            }
                    }
                }
            }
        }

    if let Some(cp) = opts.get("clientPackage").and_then(|v| v.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty()) {
        if cp.contains("://") {
            assert_allowed_https_url(cp, "clientPackage", ALLOWED_CLIENT_PACKAGE_DOMAINS)?;
        } else {
            let safe = assert_write_sandbox(cp)?;
            assert_renderer_path_allowed(&safe, AccessMode::Read)?;
        }
    }

    if let Some(qp) = opts.get("quickPlay").filter(|v| !v.is_null()) {
        let obj = qp
            .as_object()
            .ok_or_else(|| "opts.quickPlay invalide.".to_string())?;
        let qp_type = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if !matches!(qp_type, "singleplayer" | "multiplayer" | "realms" | "legacy") {
            return Err(format!("Type quickPlay non autorisé : {}", qp_type));
        }
        let id = obj
            .get("identifier")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        let is_sp = qp_type == "singleplayer";
        let invalid = id.is_empty()
            || id.len() > 255
            || if is_sp {
                id == "."
                    || id == ".."
                    || id.contains("..")
                    || id.chars().any(|c| matches!(c, '/' | '\\' | '\t' | '\r' | '\n') || (c as u32) < 0x20)
            } else {
                id.chars().any(|c| c.is_whitespace() || (c as u32) < 0x20)
            };
        if invalid {
            return Err("Identifiant quickPlay invalide.".into());
        }
        if let Some(p) = obj.get("path").and_then(|v| v.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty()) {
            let safe = assert_write_sandbox(p)?;
            assert_renderer_path_allowed(&safe, AccessMode::Read)?;
        }
    }

    Ok(())
}
