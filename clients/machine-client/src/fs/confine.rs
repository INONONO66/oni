use std::{
    collections::VecDeque,
    fs::File,
    os::fd::OwnedFd,
    path::{Component, Path, PathBuf},
};

use oni_protocol::fs_result::FsResultRefusedReason as Reason;
use rustix::fs::{self, AtFlags, Mode, OFlags};

#[derive(Debug)]
pub(super) struct ExportRoot {
    fd: OwnedFd,
    canonical: PathBuf,
}

impl ExportRoot {
    pub(super) fn open(path: &Path) -> std::io::Result<Self> {
        let canonical = path.canonicalize()?;
        let fd = fs::open(
            &canonical,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )?;
        Ok(Self { fd, canonical })
    }

    pub(super) fn target(&self, path: &str, flags: OFlags) -> Result<File, Reason> {
        let parts = segments(path).ok_or(Reason::PathEscapesExport)?;
        if parts.is_empty() {
            let fd = fs::openat(
                &self.fd,
                ".",
                flags | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
                Mode::empty(),
            )
            .map_err(open_reason)?;
            return Ok(File::from(fd));
        }
        // Exclusive creation follows no link at all: the leaf is left to
        // O_EXCL, which refuses any existing entry, including a symlink.
        let follow = !flags.contains(OFlags::EXCL);
        let (directory, name) = self.walk(parts, follow, flags.contains(OFlags::CREATE), follow)?;
        let fd = fs::openat(
            &directory,
            name.as_str(),
            flags | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
            Mode::RUSR | Mode::WUSR,
        )
        .map_err(open_reason)?;
        Ok(File::from(fd))
    }

    pub(super) fn parent(
        &self,
        path: &str,
        follow_links: bool,
    ) -> Result<(OwnedFd, String), Reason> {
        let parts = segments(path).ok_or(Reason::PathEscapesExport)?;
        if parts.is_empty() {
            return Err(Reason::WrongKind);
        }
        self.walk(parts, false, false, follow_links)
    }

    pub(super) fn metadata(&self, path: &str) -> Result<fs::Stat, Reason> {
        if segments(path).ok_or(Reason::PathEscapesExport)?.is_empty() {
            return fs::fstat(&self.fd).map_err(open_reason);
        }
        let (directory, name) = self.parent(path, true)?;
        fs::statat(&directory, name.as_str(), AtFlags::SYMLINK_NOFOLLOW).map_err(open_reason)
    }

    fn walk(
        &self,
        parts: Vec<String>,
        follow_final: bool,
        allow_missing: bool,
        follow_links: bool,
    ) -> Result<(OwnedFd, String), Reason> {
        let mut pending: VecDeque<String> = parts.into();
        let mut visited = Vec::new();
        let mut directory = rustix::io::dup(&self.fd).map_err(|_| Reason::IoError)?;
        let mut expanded = 0;
        loop {
            // Only a link resolving to the export root itself exhausts the walk.
            let Some(name) = pending.pop_front() else {
                return Ok((directory, ".".to_owned()));
            };
            let final_part = pending.is_empty();
            if final_part && !follow_final {
                return Ok((directory, name));
            }
            let flags = OFlags::RDONLY
                | OFlags::NOFOLLOW
                | OFlags::CLOEXEC
                | OFlags::NONBLOCK
                | if final_part {
                    OFlags::empty()
                } else {
                    OFlags::DIRECTORY
                };
            match fs::openat(&directory, name.as_str(), flags, Mode::empty()) {
                Ok(fd) => {
                    if final_part {
                        return Ok((directory, name));
                    }
                    directory = fd;
                    visited.push(name);
                }
                Err(error) => {
                    if final_part && allow_missing && error == rustix::io::Errno::NOENT {
                        return Ok((directory, name));
                    }
                    if !follow_links {
                        return Err(open_reason(error));
                    }
                    // readlinkat names the entry relative to the pinned directory.
                    // Even if it changes after this read, all subsequent opens are
                    // no-follow; expansion cannot jump outside the pinned root.
                    let link = match fs::readlinkat(&directory, name.as_str(), Vec::new()) {
                        Ok(link) => link,
                        Err(_) => return Err(open_reason(error)),
                    };
                    expanded += 1;
                    if expanded > 40 {
                        return Err(Reason::IoError);
                    }
                    let link_path = Path::new(
                        std::str::from_utf8(link.to_bytes()).map_err(|_| Reason::IoError)?,
                    );
                    let mut rewritten = self.link_segments(link_path, &visited)?;
                    rewritten.extend(pending);
                    pending = rewritten.into();
                    directory = rustix::io::dup(&self.fd).map_err(|_| Reason::IoError)?;
                    visited.clear();
                }
            }
        }
    }

    /// Rewrites a link target as segments from the export root, refusing any
    /// target that leaves it.
    fn link_segments(&self, link: &Path, visited: &[String]) -> Result<Vec<String>, Reason> {
        if link.is_absolute() {
            let normalized = normalize_absolute(link);
            let relative = normalized
                .strip_prefix(&self.canonical)
                .map_err(|_| Reason::PathEscapesExport)?;
            return segments_relative(relative).ok_or(Reason::PathEscapesExport);
        }
        let mut prefix = visited.to_vec();
        for component in link.to_str().ok_or(Reason::IoError)?.split('/') {
            match component {
                "" | "." => {}
                ".." => {
                    prefix.pop().ok_or(Reason::PathEscapesExport)?;
                }
                name => prefix.push(name.to_owned()),
            }
        }
        Ok(prefix)
    }
}

fn normalize_absolute(path: &Path) -> PathBuf {
    let mut result = PathBuf::from("/");
    for component in path.components() {
        match component {
            Component::Normal(part) => result.push(part),
            Component::ParentDir => {
                result.pop();
            }
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
        }
    }
    result
}

fn segments_relative(path: &Path) -> Option<Vec<String>> {
    let mut output = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => output.push(part.to_str()?.to_owned()),
            Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => return None,
        }
    }
    Some(output)
}

fn segments(path: &str) -> Option<Vec<String>> {
    if path.starts_with('/') || path.contains('\0') || path.split('/').any(|part| part == "..") {
        return None;
    }
    segments_relative(Path::new(path))
}

pub(super) fn target_kind(directory: &OwnedFd, name: &str) -> Result<(), Reason> {
    match fs::statat(directory, name, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(stat) => match fs::FileType::from_raw_mode(stat.st_mode) {
            fs::FileType::RegularFile => Ok(()),
            fs::FileType::Symlink => Err(Reason::PathEscapesExport),
            _ => Err(Reason::WrongKind),
        },
        Err(rustix::io::Errno::NOENT) => Ok(()),
        Err(error) => Err(open_reason(error)),
    }
}

/// Exclusive creation refuses any existing entry, whatever its kind.
pub(super) fn vacant(directory: &OwnedFd, name: &str) -> Result<(), Reason> {
    match fs::statat(directory, name, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(_) => Err(Reason::AlreadyExists),
        Err(rustix::io::Errno::NOENT) => Ok(()),
        Err(error) => Err(open_reason(error)),
    }
}

pub(super) fn open_reason(error: rustix::io::Errno) -> Reason {
    match error {
        rustix::io::Errno::EXIST => Reason::AlreadyExists,
        rustix::io::Errno::NOENT => Reason::NotFound,
        rustix::io::Errno::LOOP => Reason::PathEscapesExport,
        rustix::io::Errno::NOTDIR | rustix::io::Errno::ISDIR => Reason::WrongKind,
        _ => Reason::IoError,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lexical_path_components_and_io_errors_are_classified() {
        assert_eq!(
            segments_relative(Path::new("./file")),
            Some(vec!["file".to_owned()])
        );
        assert_eq!(segments_relative(Path::new("../file")), None);
        assert_eq!(segments_relative(Path::new("/file")), None);
        assert_eq!(
            normalize_absolute(Path::new("/one/../two")),
            Path::new("/two")
        );
        assert_eq!(
            open_reason(rustix::io::Errno::LOOP),
            Reason::PathEscapesExport
        );
        assert_eq!(open_reason(rustix::io::Errno::NOTDIR), Reason::WrongKind);
        assert_eq!(open_reason(rustix::io::Errno::ISDIR), Reason::WrongKind);
        assert_eq!(open_reason(rustix::io::Errno::NOENT), Reason::NotFound);
        assert_eq!(open_reason(rustix::io::Errno::PERM), Reason::IoError);
    }

    #[test]
    fn target_kind_classifies_entries_and_invalid_parent_descriptor() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let file = temp.path().join("regular");
        std::fs::write(&file, []).expect("seed file");
        std::fs::create_dir(temp.path().join("folder")).expect("create dir");
        std::os::unix::fs::symlink("regular", temp.path().join("link")).expect("symlink");
        let root: OwnedFd = File::open(temp.path()).expect("open fd").into();
        assert_eq!(target_kind(&root, "regular"), Ok(()));
        assert_eq!(target_kind(&root, "missing"), Ok(()));
        assert_eq!(target_kind(&root, "link"), Err(Reason::PathEscapesExport));
        assert_eq!(target_kind(&root, "folder"), Err(Reason::WrongKind));
        let descriptor: OwnedFd = File::open(&file).expect("open fd").into();
        assert_eq!(target_kind(&descriptor, "child"), Err(Reason::WrongKind));
    }

    #[test]
    fn vacant_refuses_every_existing_entry_and_maps_eexist() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let file = temp.path().join("regular");
        std::fs::write(&file, []).expect("seed file");
        std::fs::create_dir(temp.path().join("folder")).expect("create dir");
        std::os::unix::fs::symlink("missing", temp.path().join("dangling")).expect("symlink");
        let root: OwnedFd = File::open(temp.path()).expect("open fd").into();
        assert_eq!(vacant(&root, "missing"), Ok(()));
        for name in ["regular", "folder", "dangling"] {
            assert_eq!(vacant(&root, name), Err(Reason::AlreadyExists), "{name}");
        }
        let descriptor: OwnedFd = File::open(&file).expect("open fd").into();
        assert_eq!(vacant(&descriptor, "child"), Err(Reason::WrongKind));
        assert_eq!(open_reason(rustix::io::Errno::EXIST), Reason::AlreadyExists);
    }
}
