use std::{
    fs,
    path::{Path, PathBuf},
};

fn field<'a>(bytes: &'a [u8], offset: &mut usize) -> Option<&'a [u8]> {
    let size = u16::from_be_bytes(bytes.get(*offset..*offset + 2)?.try_into().ok()?);
    *offset += 2;
    let value = bytes.get(*offset..*offset + usize::from(size))?;
    *offset += usize::from(size);
    Some(value)
}

pub fn cookie(bytes: &[u8], display: u16) -> Option<Vec<u8>> {
    let mut offset = 0;
    while offset < bytes.len() {
        let _family = u16::from_be_bytes(bytes.get(offset..offset + 2)?.try_into().ok()?);
        offset += 2;
        let _address = field(bytes, &mut offset)?;
        let number = field(bytes, &mut offset)?;
        let name = field(bytes, &mut offset)?;
        let secret = field(bytes, &mut offset)?;
        if number == display.to_string().as_bytes() && name == b"MIT-MAGIC-COOKIE-1" {
            return Some(secret.to_vec());
        }
    }
    None
}

pub fn server_file(root: &Path, display: &str) -> Option<PathBuf> {
    for entry in fs::read_dir(root).ok()?.flatten() {
        if !entry
            .file_name()
            .to_string_lossy()
            .bytes()
            .all(|byte| byte.is_ascii_digit())
        {
            continue;
        }
        let Ok(command) = fs::read(entry.path().join("cmdline")) else {
            continue;
        };
        let args: Vec<_> = command
            .split(|byte| *byte == 0)
            .filter(|arg| !arg.is_empty())
            .collect();
        let server = args
            .first()
            .and_then(|name| Path::new(std::str::from_utf8(name).ok()?).file_name());
        if !matches!(
            server.and_then(|name| name.to_str()),
            Some("Xorg" | "Xvfb" | "X")
        ) || !(args.contains(&display.as_bytes()) || owns_socket(root, &entry.path(), display))
        {
            continue;
        }
        if let Some(path) = args
            .windows(2)
            .find(|pair| pair[0] == b"-auth")
            .and_then(|pair| std::str::from_utf8(pair[1]).ok())
        {
            return Some(PathBuf::from(path));
        }
    }
    None
}

fn owns_socket(root: &Path, process: &Path, display: &str) -> bool {
    let socket = format!("/tmp/.X11-unix/X{}", display.trim_start_matches(':'));
    let Ok(table) = fs::read_to_string(root.join("net/unix")) else {
        return false;
    };
    let inodes: Vec<_> = table
        .lines()
        .filter_map(|line| {
            let columns: Vec<_> = line.split_whitespace().collect();
            (columns.get(7) == Some(&socket.as_str()))
                .then(|| columns.get(6).copied())
                .flatten()
        })
        .map(|inode| format!("socket:[{inode}]"))
        .collect();
    fs::read_dir(process.join("fd"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| fs::read_link(entry.path()).ok())
        .any(|link| inodes.iter().any(|inode| link == Path::new(inode)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(number: &str, name: &str, secret: &[u8]) -> Vec<u8> {
        let mut bytes = 256_u16.to_be_bytes().to_vec();
        for field in [
            b"host".as_slice(),
            number.as_bytes(),
            name.as_bytes(),
            secret,
        ] {
            bytes.extend_from_slice(
                &u16::try_from(field.len())
                    .expect("field length")
                    .to_be_bytes(),
            );
            bytes.extend_from_slice(field);
        }
        bytes
    }

    #[test]
    fn cookie_selects_the_display_and_refuses_malformed_or_other_protocols() {
        let mut bytes = entry("23", "OTHER", b"wrong");
        bytes.extend(entry("24", "MIT-MAGIC-COOKIE-1", b"correct"));
        assert_eq!(cookie(&bytes, 24), Some(b"correct".to_vec()));
        assert_eq!(cookie(&bytes, 23), None);
        assert_eq!(cookie(&bytes[..bytes.len() - 1], 24), None);
        assert_eq!(cookie(&[], 24), None);
    }

    #[test]
    fn server_authority_file_matches_display_and_process_name() {
        let root = tempfile::tempdir().expect("proc root");
        fs::create_dir(root.path().join("7")).expect("process directory");
        fs::write(
            root.path().join("7/cmdline"),
            b"Xvfb\0:24\0-auth\0/tmp/server.auth\0",
        )
        .expect("cmdline");
        fs::create_dir(root.path().join("8")).expect("process without readable command");
        assert_eq!(
            server_file(root.path(), ":24"),
            Some(PathBuf::from("/tmp/server.auth"))
        );
        assert_eq!(server_file(root.path(), ":25"), None);
        fs::write(
            root.path().join("7/cmdline"),
            b"other\0:24\0-auth\0/tmp/server.auth\0",
        )
        .expect("different process");
        assert_eq!(server_file(root.path(), ":24"), None);
    }
}
