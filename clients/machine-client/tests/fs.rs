use std::{fs, path::Path};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use oni_machine_client::fs::{FsDriver, READ_MAX_BYTES, WRITE_MAX_BYTES};
use oni_protocol::{FsRequest, FsStreamRequest};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

fn driver(root: &Path) -> FsDriver {
    FsDriver::open([("notes".to_owned(), root.to_path_buf())]).expect("driver")
}

fn op(driver: &FsDriver, value: Value) -> Value {
    let request: FsRequest = serde_json::from_value(value).expect("decode request");
    serde_json::to_value(driver.execute(&request)).expect("encode result")
}

fn stream(driver: &mut FsDriver, value: Value) -> Value {
    let request: FsStreamRequest = serde_json::from_value(value).expect("decode request");
    serde_json::to_value(driver.stream(&request)).expect("encode result")
}

fn begin(id: &str, mode: &str, path: &str) -> Value {
    json!({"op":"begin","transferId":id,"mode":mode,"export":"notes","path":path})
}

fn write(id: &str, seq: i64, bytes: &[u8], last: bool, digest: Option<&str>) -> Value {
    let mut request =
        json!({"op":"write","transferId":id,"seq":seq,"data":BASE64.encode(bytes),"last":last});
    if let Some(digest) = digest {
        request["digest"] = json!(digest);
    }
    request
}

#[test]
fn operations_preserve_read_write_list_stat_results() {
    let temp = TempDir::new().expect("temp dir");
    let driver = driver(temp.path());
    let data = BASE64.encode(b"hello");
    assert_eq!(
        op(
            &driver,
            json!({"op":"write","export":"notes","path":"one","data":data})
        ),
        json!({"status":"completed","value":{"op":"write","bytesWritten":5}})
    );
    assert_eq!(
        op(
            &driver,
            json!({"op":"read","export":"notes","path":"one","offset":1,"limit":2})
        ),
        json!({"status":"completed","value":{"op":"read","data":BASE64.encode(b"el"),"bytesRead":2,"size":5,"truncated":true}})
    );
    assert_eq!(
        op(&driver, json!({"op":"list","export":"notes","path":""})),
        json!({"status":"completed","value":{"op":"list","entries":[{"name":"one","kind":"file","size":5}],"truncated":false}})
    );
    let stat = op(&driver, json!({"op":"stat","export":"notes","path":"one"}));
    assert_eq!(stat["status"], "completed");
    assert_eq!(stat["value"]["kind"], "file");
    assert_eq!(stat["value"]["size"], 5);
    assert!(stat["value"]["mtimeMs"].is_number());
}

#[test]
fn operation_caps_and_missing_export_are_typed() {
    let temp = TempDir::new().expect("temp dir");
    let driver = driver(temp.path());
    fs::write(temp.path().join("large"), vec![1; READ_MAX_BYTES + 1]).expect("seed file");
    let read = op(
        &driver,
        json!({"op":"read","export":"notes","path":"large"}),
    );
    assert_eq!(read["value"]["bytesRead"], READ_MAX_BYTES);
    assert_eq!(read["value"]["truncated"], true);
    assert_eq!(
        op(
            &driver,
            json!({"op":"write","export":"notes","path":"oversize","data":BASE64.encode(vec![1; WRITE_MAX_BYTES+1])})
        )["reason"],
        "too_large"
    );
    assert!(!temp.path().join("oversize").exists());
    assert_eq!(
        op(&driver, json!({"op":"stat","export":"absent","path":"x"}))["reason"],
        "export_not_available"
    );
    assert_eq!(
        op(
            &driver,
            json!({"op":"read","export":"notes","path":"missing"})
        )["reason"],
        "not_found"
    );
    assert_eq!(
        op(&driver, json!({"op":"read","export":"notes","path":""}))["reason"],
        "wrong_kind"
    );
}

#[test]
fn listing_is_bounded_and_sorted() {
    let temp = TempDir::new().expect("temp dir");
    for n in 0..1001 {
        fs::write(temp.path().join(format!("item-{n:04}")), []).expect("seed file");
    }
    let value = op(
        &driver(temp.path()),
        json!({"op":"list","export":"notes","path":""}),
    );
    assert_eq!(
        value["value"]["entries"]
            .as_array()
            .expect("entries array")
            .len(),
        1000
    );
    assert_eq!(value["value"]["truncated"], true);
    let entries = value["value"]["entries"].as_array().expect("entries array");
    assert!(entries
        .windows(2)
        .all(|pair| pair[0]["name"].as_str() <= pair[1]["name"].as_str()));
}

#[cfg(unix)]
#[test]
fn links_inside_export_work_and_escaping_links_refuse() {
    use std::os::unix::fs::symlink;
    let temp = TempDir::new().expect("temp dir");
    let outside = TempDir::new().expect("temp dir");
    fs::create_dir(temp.path().join("inner")).expect("create dir");
    fs::write(temp.path().join("inner/data"), b"safe").expect("seed file");
    fs::write(outside.path().join("data"), b"secret").expect("seed file");
    symlink("inner", temp.path().join("alias")).expect("symlink");
    symlink("inner/data", temp.path().join("file-link")).expect("symlink");
    symlink("inner/new", temp.path().join("write-link")).expect("symlink");
    symlink("../../", temp.path().join("inner/up")).expect("symlink");
    symlink(outside.path(), temp.path().join("outside")).expect("symlink");
    symlink("up/data", temp.path().join("inner/nested")).expect("symlink");
    let driver = driver(temp.path());
    assert_eq!(
        op(
            &driver,
            json!({"op":"read","export":"notes","path":"alias/data"})
        )["value"]["data"],
        BASE64.encode(b"safe")
    );
    assert_eq!(
        op(
            &driver,
            json!({"op":"read","export":"notes","path":"file-link"})
        )["value"]["data"],
        BASE64.encode(b"safe")
    );
    assert_eq!(
        op(
            &driver,
            json!({"op":"write","export":"notes","path":"write-link","data":BASE64.encode(b"new")})
        )["status"],
        "completed"
    );
    assert_eq!(
        fs::read(temp.path().join("inner/new")).expect("read back"),
        b"new"
    );
    assert_eq!(
        op(
            &driver,
            json!({"op":"stat","export":"notes","path":"alias"})
        )["value"]["kind"],
        "symlink"
    );
    assert_eq!(
        op(
            &driver,
            json!({"op":"write","export":"notes","path":"outside/data","data":BASE64.encode(b"bad")})
        )["reason"],
        "path_escapes_export"
    );
    for path in [
        "../data",
        "/tmp/data",
        "outside/data",
        "inner/up/data",
        "inner/nested",
    ] {
        assert_eq!(
            op(&driver, json!({"op":"read","export":"notes","path":path}))["reason"],
            "path_escapes_export",
            "{path}"
        );
    }
}

#[test]
fn thirty_third_transfer_is_refused_without_evicting_existing() {
    let temp = TempDir::new().expect("temp dir");
    fs::write(temp.path().join("source"), b"data").expect("seed file");
    let mut driver = driver(temp.path());
    for n in 0..32 {
        assert_eq!(
            stream(&mut driver, begin(&format!("t{n}"), "read", "source"))["status"],
            "begun"
        );
    }
    assert_eq!(
        stream(&mut driver, begin("t32", "read", "source"))["reason"],
        "too_large"
    );
    assert_eq!(
        stream(&mut driver, json!({"op":"abort","transferId":"t0"}))["status"],
        "finished"
    );
    assert_eq!(
        stream(&mut driver, begin("t32", "read", "source"))["status"],
        "begun"
    );
}

fn key(value: &Value) -> usize {
    let request: FsStreamRequest = serde_json::from_value(value.clone()).expect("decode request");
    serde_json::to_string(&request)
        .expect("encode request")
        .len()
}

#[test]
fn retained_counts_open_transfers_and_replay_caches_until_aborted() {
    let temp = TempDir::new().expect("temp dir");
    fs::write(temp.path().join("source"), b"data").expect("seed file");
    let mut driver = driver(temp.path());
    for n in 0..3 {
        assert_eq!(
            stream(&mut driver, begin(&format!("t{n}"), "read", "source"))["status"],
            "begun"
        );
    }
    assert_eq!((driver.retained(), driver.retained_bytes()), (3, 0));
    let read = json!({"op":"read","transferId":"t0","seq":0});
    let chunk = stream(&mut driver, read.clone());
    let read_bytes = key(&read) + chunk["data"].as_str().expect("chunk data").len();
    assert_eq!(driver.retained_bytes(), read_bytes);
    assert_eq!(
        stream(&mut driver, begin("w", "write", "target"))["status"],
        "begun"
    );
    let written = write("w", 0, b"abc", false, None);
    assert_eq!(stream(&mut driver, written.clone())["status"], "written");
    assert_eq!(driver.retained(), 4);
    assert_eq!(driver.retained_bytes(), read_bytes + key(&written));
    driver.abort_all();
    assert_eq!((driver.retained(), driver.retained_bytes()), (0, 0));
    assert_eq!(
        stream(&mut driver, json!({"op":"read","transferId":"t1","seq":0}))["reason"],
        "transfer_not_found"
    );
}

#[test]
fn read_chunk_replay_only_accepts_latest_matching_request() {
    let temp = TempDir::new().expect("temp dir");
    fs::write(temp.path().join("source"), vec![3; WRITE_MAX_BYTES + 1]).expect("seed file");
    let mut driver = driver(temp.path());
    assert_eq!(
        stream(&mut driver, begin("r", "read", "source"))["status"],
        "begun"
    );
    let first = stream(&mut driver, json!({"op":"read","transferId":"r","seq":0}));
    assert_eq!(first["last"], false);
    assert_eq!(
        stream(&mut driver, json!({"op":"read","transferId":"r","seq":0})),
        first
    );
    assert_eq!(
        stream(&mut driver, json!({"op":"read","transferId":"r","seq":2}))["reason"],
        "invalid_sequence"
    );
    let second = stream(&mut driver, json!({"op":"read","transferId":"r","seq":1}));
    assert_eq!(second["last"], true);
    assert_eq!(
        second["digest"],
        hex::encode(Sha256::digest(vec![3; WRITE_MAX_BYTES + 1]))
    );
    assert_eq!(
        stream(&mut driver, json!({"op":"read","transferId":"r","seq":0}))["reason"],
        "invalid_sequence"
    );
    assert_eq!(
        stream(&mut driver, json!({"op":"finish","transferId":"r"}))["status"],
        "finished"
    );
}

#[test]
fn staged_write_publishes_only_after_digest_and_finish() {
    let temp = TempDir::new().expect("temp dir");
    fs::write(temp.path().join("target"), b"old").expect("seed file");
    let mut driver = driver(temp.path());
    assert_eq!(
        stream(&mut driver, begin("w", "write", "target"))["status"],
        "begun"
    );
    let staged = temp.path().join(format!(
        ".oni-transfer-{}",
        &hex::encode(Sha256::digest(b"w"))[..32]
    ));
    assert!(staged.exists());
    let first = stream(&mut driver, write("w", 0, b"new", false, None));
    assert_eq!(first["status"], "written");
    assert_eq!(
        stream(&mut driver, write("w", 0, b"new", false, None)),
        first
    );
    assert_eq!(
        stream(&mut driver, write("w", 0, b"bad", false, None))["reason"],
        "invalid_sequence"
    );
    assert_eq!(
        stream(&mut driver, json!({"op":"finish","transferId":"w"}))["reason"],
        "invalid_sequence"
    );
    assert_eq!(
        fs::read(temp.path().join("target")).expect("read back"),
        b"old"
    );
    assert_eq!(
        stream(
            &mut driver,
            write("w", 1, b"!", true, Some("0".repeat(64).as_str()))
        )["reason"],
        "digest_mismatch"
    );
    let digest = hex::encode(Sha256::digest(b"new!"));
    assert_eq!(
        stream(&mut driver, write("w", 1, b"!", true, Some(&digest)))["status"],
        "written"
    );
    assert_eq!(
        stream(&mut driver, json!({"op":"finish","transferId":"w"}))["status"],
        "finished"
    );
    assert_eq!(
        fs::read(temp.path().join("target")).expect("read back"),
        b"new!"
    );
    assert!(!staged.exists());
}

#[test]
fn finish_refuses_and_discards_staging_when_publication_fails() {
    let temp = TempDir::new().expect("temp dir");
    let mut driver = driver(temp.path());
    assert_eq!(
        stream(&mut driver, begin("p", "write", "target"))["status"],
        "begun"
    );
    let digest = hex::encode(Sha256::digest(b"data"));
    assert_eq!(
        stream(&mut driver, write("p", 0, b"data", true, Some(&digest)))["status"],
        "written"
    );
    fs::create_dir(temp.path().join("target")).expect("create dir");
    fs::write(temp.path().join("target/keep"), []).expect("seed file");
    assert_eq!(
        stream(&mut driver, json!({"op":"finish","transferId":"p"}))["reason"],
        "io_error"
    );
    assert!(temp.path().join("target/keep").exists());
    assert_eq!(fs::read_dir(temp.path()).expect("read dir").count(), 1);
}

#[test]
fn abort_and_drop_discard_unfinished_staging() {
    let temp = TempDir::new().expect("temp dir");
    let mut driver = driver(temp.path());
    stream(&mut driver, begin("a", "write", "a"));
    stream(&mut driver, write("a", 0, b"incomplete", false, None));
    assert_eq!(
        stream(&mut driver, json!({"op":"abort","transferId":"a"}))["status"],
        "finished"
    );
    assert!(!temp.path().join("a").exists());
    stream(&mut driver, begin("b", "write", "b"));
    drop(driver);
    assert!(!temp.path().join("b").exists());
    assert_eq!(fs::read_dir(temp.path()).expect("read dir").count(), 0);
}

#[test]
fn export_open_failure_and_directory_shapes() {
    let temp = TempDir::new().expect("temp dir");
    assert!(FsDriver::open([("missing".to_owned(), temp.path().join("absent"))]).is_err());
    fs::write(temp.path().join("not-directory"), []).expect("seed file");
    assert!(FsDriver::open([("file".to_owned(), temp.path().join("not-directory"))]).is_err());
    fs::create_dir(temp.path().join("folder")).expect("create dir");
    fs::write(temp.path().join("file"), []).expect("seed file");
    let driver = driver(temp.path());
    assert_eq!(
        op(&driver, json!({"op":"stat","export":"notes","path":""}))["value"]["kind"],
        "dir"
    );
    assert_eq!(
        op(
            &driver,
            json!({"op":"stat","export":"notes","path":"folder"})
        )["value"]["kind"],
        "dir"
    );
    assert_eq!(
        op(&driver, json!({"op":"list","export":"notes","path":""}))["value"]["entries"],
        json!([{"name":"file","kind":"file","size":0},{"name":"folder","kind":"dir"},{"name":"not-directory","kind":"file","size":0}])
    );
    assert_eq!(
        op(
            &driver,
            json!({"op":"write","export":"notes","path":"folder","data":""})
        )["reason"],
        "wrong_kind"
    );
}

#[cfg(unix)]
#[test]
fn special_entries_and_link_boundaries_have_typed_results() {
    use std::os::unix::fs::{symlink, FileTypeExt};
    let temp = TempDir::new().expect("temp dir");
    let outside = TempDir::new().expect("temp dir");
    let root = temp.path();
    fs::create_dir(root.join("folder")).expect("create dir");
    symlink("folder", root.join("link")).expect("symlink");
    symlink("folder/../folder", root.join("normalized")).expect("symlink");
    symlink("./folder", root.join("dotted")).expect("symlink");
    symlink(
        root.canonicalize().expect("canonical root").join("folder"),
        root.join("absolute"),
    )
    .expect("symlink");
    symlink(outside.path(), root.join("escaped")).expect("symlink");
    symlink("loop", root.join("loop")).expect("symlink");
    let pipe = root.join("pipe");
    assert!(std::process::Command::new("mkfifo")
        .arg(&pipe)
        .status()
        .expect("mkfifo")
        .success());
    assert!(fs::metadata(&pipe)
        .expect("fifo metadata")
        .file_type()
        .is_fifo());
    let _reader = rustix::fs::open(
        &pipe,
        rustix::fs::OFlags::RDWR | rustix::fs::OFlags::NONBLOCK,
        rustix::fs::Mode::empty(),
    )
    .expect("open fifo reader");
    let mut client = driver(root);
    let entries = op(&client, json!({"op":"list","export":"notes","path":""}));
    assert!(entries["value"]["entries"]
        .as_array()
        .expect("entries array")
        .iter()
        .any(|entry| entry["name"] == "pipe"
            && entry["kind"] == "other"
            && entry["size"].is_null()));
    assert_eq!(
        op(&client, json!({"op":"stat","export":"notes","path":"pipe"}))["value"]["kind"],
        "other"
    );
    assert_eq!(
        op(&client, json!({"op":"read","export":"notes","path":"pipe"}))["reason"],
        "wrong_kind"
    );
    assert_eq!(
        op(
            &client,
            json!({"op":"write","export":"notes","path":"pipe","data":""})
        )["reason"],
        "wrong_kind"
    );
    for name in ["link", "pipe"] {
        assert_eq!(
            stream(&mut client, begin("special", "write", name))["reason"],
            if name == "link" {
                "path_escapes_export"
            } else {
                "wrong_kind"
            }
        );
    }
    assert_eq!(
        op(
            &client,
            json!({"op":"list","export":"notes","path":"normalized"})
        )["status"],
        "completed"
    );
    assert_eq!(
        op(
            &client,
            json!({"op":"list","export":"notes","path":"dotted"})
        )["status"],
        "completed"
    );
    assert_eq!(
        op(
            &client,
            json!({"op":"list","export":"notes","path":"absolute"})
        )["status"],
        "completed"
    );
    assert_eq!(
        op(
            &client,
            json!({"op":"list","export":"notes","path":"escaped"})
        )["reason"],
        "path_escapes_export"
    );
    assert_eq!(
        op(&client, json!({"op":"list","export":"notes","path":"loop"}))["reason"],
        "io_error"
    );
    assert_eq!(
        op(
            &client,
            json!({"op":"stat","export":"notes","path":"missing"})
        )["reason"],
        "not_found"
    );
    assert_eq!(
        stream(&mut client, begin("missing", "write", "folder/file"))["status"],
        "begun"
    );
}

#[test]
fn stream_rejects_invalid_begins_and_chunks() {
    let temp = TempDir::new().expect("temp dir");
    fs::write(temp.path().join("source"), b"data").expect("seed file");
    let mut driver = driver(temp.path());
    assert_eq!(
        stream(&mut driver, begin("x", "read", "source"))["status"],
        "begun"
    );
    assert_eq!(
        stream(&mut driver, begin("x", "read", "source"))["status"],
        "begun"
    );
    assert_eq!(
        stream(&mut driver, begin("x", "write", "other"))["reason"],
        "invalid_sequence"
    );
    assert_eq!(
        stream(
            &mut driver,
            json!({"op":"read","transferId":"absent","seq":0})
        )["reason"],
        "transfer_not_found"
    );
    assert_eq!(
        stream(&mut driver, json!({"op":"finish","transferId":"absent"}))["reason"],
        "transfer_not_found"
    );
    assert_eq!(
        stream(
            &mut driver,
            json!({"op":"write","transferId":"x","seq":0,"data":"","last":false})
        )["reason"],
        "invalid_sequence"
    );
    assert_eq!(
        stream(&mut driver, begin("not-there", "read", "missing"))["reason"],
        "not_found"
    );
    assert_eq!(
        stream(
            &mut driver,
            json!({"op":"begin","transferId":"bad","mode":"read","export":"absent","path":"source"})
        )["reason"],
        "export_not_available"
    );
    assert_eq!(
        stream(&mut driver, begin("directory", "read", ""))["reason"],
        "wrong_kind"
    );
    assert_eq!(
        stream(&mut driver, begin("no-parent", "write", "missing/file"))["reason"],
        "not_found"
    );
    assert_eq!(
        stream(&mut driver, begin("root", "write", ""))["reason"],
        "wrong_kind"
    );
}

fn exclusive_begin(id: &str, path: &str) -> Value {
    let mut request = begin(id, "write", path);
    request["create"] = json!("exclusive");
    request
}

fn exclusive_write(path: &str, bytes: &[u8]) -> Value {
    json!({"op":"write","export":"notes","path":path,"data":BASE64.encode(bytes),"create":"exclusive"})
}

#[cfg(unix)]
#[test]
fn exclusive_write_creates_once_and_refuses_occupied_or_linked_leaves() {
    use std::os::unix::fs::symlink;
    let temp = TempDir::new().expect("temp dir");
    let root = temp.path();
    fs::create_dir(root.join("inbox")).expect("create dir");
    fs::write(root.join("sibling"), b"untouched").expect("seed file");
    symlink("../sibling", root.join("inbox/link")).expect("symlink");
    symlink("inbox", root.join("alias")).expect("symlink");
    let driver = driver(root);
    assert_eq!(
        op(&driver, exclusive_write("inbox/link", b"bytes"))["reason"],
        "already_exists"
    );
    assert_eq!(
        fs::read(root.join("sibling")).expect("read back"),
        b"untouched"
    );
    assert_eq!(
        op(&driver, exclusive_write("alias/escape", b"bytes"))["status"],
        "refused"
    );
    assert_eq!(
        fs::read_dir(root.join("inbox")).expect("read dir").count(),
        1
    );
    assert_eq!(
        op(&driver, exclusive_write("inbox/new", b"bytes")),
        json!({"status":"completed","value":{"op":"write","bytesWritten":5}})
    );
    assert_eq!(
        op(&driver, exclusive_write("inbox/new", b"replace"))["reason"],
        "already_exists"
    );
    assert_eq!(
        fs::read(root.join("inbox/new")).expect("read back"),
        b"bytes"
    );
    assert_eq!(
        op(&driver, exclusive_write("inbox", b"bytes"))["reason"],
        "already_exists"
    );
}

#[cfg(unix)]
#[test]
fn exclusive_begin_refuses_existing_file_directory_and_symlink() {
    use std::os::unix::fs::symlink;
    let temp = TempDir::new().expect("temp dir");
    let root = temp.path();
    fs::write(root.join("file"), b"old").expect("seed file");
    fs::create_dir(root.join("folder")).expect("create dir");
    symlink("file", root.join("link")).expect("symlink");
    symlink("folder", root.join("alias")).expect("symlink");
    let mut driver = driver(root);
    for path in ["file", "folder", "link"] {
        assert_eq!(
            stream(&mut driver, exclusive_begin(path, path))["reason"],
            "already_exists",
            "{path}"
        );
    }
    assert_eq!(
        stream(&mut driver, exclusive_begin("alias", "alias/new"))["status"],
        "refused"
    );
    assert_eq!(fs::read_dir(root).expect("read dir").count(), 4);
    assert_eq!(fs::read(root.join("file")).expect("read back"), b"old");
}

#[cfg(unix)]
#[test]
fn exclusive_finish_refuses_a_competing_leaf_and_discards_staging() {
    use std::os::unix::fs::symlink;
    for kind in ["file", "symlink"] {
        let temp = TempDir::new().expect("temp dir");
        let root = temp.path();
        fs::write(root.join("sibling"), b"untouched").expect("seed file");
        let mut driver = driver(root);
        assert_eq!(
            stream(&mut driver, exclusive_begin("x", "target"))["status"],
            "begun"
        );
        let digest = hex::encode(Sha256::digest(b"new"));
        assert_eq!(
            stream(&mut driver, write("x", 0, b"new", true, Some(&digest)))["last"],
            true
        );
        if kind == "file" {
            fs::write(root.join("target"), b"winner").expect("seed file");
        } else {
            symlink("sibling", root.join("target")).expect("symlink");
        }
        assert_eq!(
            stream(&mut driver, json!({"op":"finish","transferId":"x"}))["reason"],
            "already_exists",
            "{kind}"
        );
        let expected: &[u8] = if kind == "file" {
            b"winner"
        } else {
            b"untouched"
        };
        assert_eq!(fs::read(root.join("target")).expect("read back"), expected);
        assert_eq!(
            fs::read(root.join("sibling")).expect("read back"),
            b"untouched"
        );
        assert_eq!(fs::read_dir(root).expect("read dir").count(), 2);
    }
}

#[test]
fn exclusive_stream_publishes_a_fresh_target() {
    let temp = TempDir::new().expect("temp dir");
    let mut driver = driver(temp.path());
    assert_eq!(
        stream(&mut driver, exclusive_begin("f", "fresh"))["status"],
        "begun"
    );
    let digest = hex::encode(Sha256::digest(b"fresh"));
    stream(&mut driver, write("f", 0, b"fresh", true, Some(&digest)));
    assert_eq!(
        stream(&mut driver, json!({"op":"finish","transferId":"f"}))["status"],
        "finished"
    );
    assert_eq!(
        fs::read(temp.path().join("fresh")).expect("read back"),
        b"fresh"
    );
    assert_eq!(fs::read_dir(temp.path()).expect("read dir").count(), 1);
}

#[test]
fn schema_valid_non_canonical_base64_is_refused_without_unwinding() {
    let temp = TempDir::new().expect("temp dir");
    let mut driver = driver(temp.path());
    assert_eq!(
        stream(&mut driver, begin("w", "write", "target"))["status"],
        "begun"
    );
    // "QR==" matches the wire pattern but carries nonzero trailing bits,
    // which the strict decoder rejects.
    let request: FsStreamRequest = oni_protocol::decode(
        json!({"op":"write","transferId":"w","seq":0,"data":"QR==","last":false}),
    )
    .expect("schema admits the payload");
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        serde_json::to_value(driver.stream(&request)).expect("encode result")
    }))
    .expect("stream must not unwind");
    assert_eq!(result["status"], "refused");
    assert_eq!(result["reason"], "io_error");
    assert_eq!(
        stream(&mut driver, write("w", 0, b"ok", false, None))["status"],
        "written"
    );
}

#[cfg(unix)]
#[test]
fn links_to_the_export_root_list_the_root() {
    use std::os::unix::fs::symlink;
    let temp = TempDir::new().expect("temp dir");
    let root = temp.path().canonicalize().expect("canonical root");
    fs::write(root.join("file"), b"data").expect("seed file");
    symlink(".", root.join("relative")).expect("symlink");
    symlink(&root, root.join("absolute")).expect("symlink");
    let driver = driver(&root);
    let expected = op(&driver, json!({"op":"list","export":"notes","path":""}));
    assert_eq!(expected["status"], "completed");
    for link in ["relative", "absolute"] {
        assert_eq!(
            op(&driver, json!({"op":"list","export":"notes","path":link})),
            expected,
            "{link}"
        );
    }
}

#[test]
fn stream_refuses_invalid_payloads_and_truncated_sources() {
    let temp = TempDir::new().expect("temp dir");
    fs::write(temp.path().join("source"), b"data").expect("seed file");
    let mut driver = driver(temp.path());
    assert_eq!(
        stream(&mut driver, begin("r", "read", "source"))["status"],
        "begun"
    );
    fs::write(temp.path().join("source"), []).expect("seed file");
    assert_eq!(
        stream(&mut driver, json!({"op":"read","transferId":"r","seq":0}))["reason"],
        "io_error"
    );
    assert_eq!(
        stream(&mut driver, begin("w", "write", "target"))["status"],
        "begun"
    );
    assert_eq!(
        stream(
            &mut driver,
            write("w", 0, &vec![1; WRITE_MAX_BYTES + 1], false, None)
        )["reason"],
        "too_large"
    );
    assert_eq!(
        stream(&mut driver, write("w", 0, b"hello", true, None))["reason"],
        "digest_mismatch"
    );
    assert_eq!(
        stream(&mut driver, json!({"op":"read","transferId":"w","seq":0}))["reason"],
        "invalid_sequence"
    );
}
