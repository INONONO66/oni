use std::{fs, io, io::Write, os::unix::fs::OpenOptionsExt, path::Path};

use nix::libc;
use serde::Serialize;

use crate::{budget::Metrics, screen::Fault};

/// Interpret one source probe without touching the display or prompting.
pub fn screen_permission(probe: Option<Result<(), Fault>>) -> &'static str {
    match probe {
        None => "unsupported",
        Some(Ok(())) => "granted",
        Some(Err(Fault::Permission)) => "denied",
        Some(Err(_)) => "unsupported",
    }
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn mach_host_self() -> libc::mach_port_t;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Load {
    pub load_avg1: f64,
    pub memory_available_bytes: u64,
    pub in_flight: usize,
}

pub trait Probe {
    fn load(&self, in_flight: usize) -> io::Result<Load>;
    fn rss(&self) -> io::Result<u64>;
    fn memory(&self) -> io::Result<u64>;
}

pub struct SystemProbe;

impl Probe for SystemProbe {
    fn load(&self, in_flight: usize) -> io::Result<Load> {
        snapshot(in_flight)
    }

    fn rss(&self) -> io::Result<u64> {
        rss_bytes()
    }

    fn memory(&self) -> io::Result<u64> {
        total_memory()
    }
}

pub fn meminfo_bytes(meminfo: &str, key: &str) -> Option<u64> {
    meminfo.lines().find_map(|line| {
        line.strip_prefix(key)?
            .strip_prefix(':')?
            .split_whitespace()
            .next()?
            .parse::<u64>()
            .ok()
            .map(|kib| kib.saturating_mul(1024))
    })
}

pub fn statm_rss_bytes(statm: &str, page_size: u64) -> Option<u64> {
    let pages = statm.split_whitespace().nth(1)?.parse::<u64>().ok()?;
    Some(pages.saturating_mul(page_size))
}

pub fn vm_available_bytes(free_pages: u32, inactive_pages: u32, page_size: u64) -> u64 {
    (u64::from(free_pages) + u64::from(inactive_pages)).saturating_mul(page_size)
}

fn ensure(ok: bool, call: &str) -> io::Result<()> {
    if ok {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "{call}: {}",
            io::Error::last_os_error()
        )))
    }
}

fn page_bytes(size: libc::c_long) -> io::Result<u64> {
    u64::try_from(size).map_err(|_| io::Error::other("sysconf: no page size"))
}

fn page_size() -> io::Result<u64> {
    // SAFETY: FFI boundary (category 8): sysconf takes a constant selector.
    page_bytes(unsafe { libc::sysconf(libc::_SC_PAGESIZE) })
}

fn average(read: libc::c_int, averages: [f64; 1]) -> io::Result<f64> {
    ensure(read == 1, "getloadavg")?;
    Ok(averages[0])
}

fn load_average() -> io::Result<f64> {
    let mut averages = [0.0_f64; 1];
    // SAFETY: FFI boundary (category 8): the array is initialized, writable,
    // and holds exactly the one f64 requested by getloadavg.
    let read = unsafe { libc::getloadavg(averages.as_mut_ptr(), 1) };
    average(read, averages)
}

fn load(
    in_flight: usize,
    load_avg1: fn() -> io::Result<f64>,
    available: fn() -> io::Result<u64>,
) -> io::Result<Load> {
    Ok(Load {
        load_avg1: load_avg1()?,
        memory_available_bytes: available()?,
        in_flight,
    })
}

pub fn snapshot(in_flight: usize) -> io::Result<Load> {
    load(in_flight, load_average, available_memory)
}

#[cfg(target_os = "linux")]
fn meminfo(key: &str) -> io::Result<u64> {
    meminfo_bytes(&fs::read_to_string("/proc/meminfo")?, key)
        .ok_or_else(|| io::Error::other(format!("/proc/meminfo has no {key}")))
}

#[cfg(target_os = "linux")]
fn available_memory() -> io::Result<u64> {
    meminfo("MemAvailable")
}

#[cfg(target_os = "linux")]
fn total_memory() -> io::Result<u64> {
    meminfo("MemTotal")
}

#[cfg(target_os = "linux")]
pub fn rss_bytes() -> io::Result<u64> {
    resident(&fs::read_to_string("/proc/self/statm")?, page_size()?)
}

#[cfg(target_os = "linux")]
fn resident(statm: &str, page_size: u64) -> io::Result<u64> {
    statm_rss_bytes(statm, page_size)
        .ok_or_else(|| io::Error::other("/proc/self/statm has no resident field"))
}

#[cfg(target_os = "macos")]
fn available_memory() -> io::Result<u64> {
    let mut statistics = std::mem::MaybeUninit::<libc::vm_statistics64>::zeroed();
    let mut count = libc::HOST_VM_INFO64_COUNT;
    // SAFETY: FFI boundary (category 8): the output has the exact
    // vm_statistics64 allocation and count. Read only after success.
    let status = unsafe {
        libc::host_statistics64(
            mach_host_self(),
            libc::HOST_VM_INFO64,
            statistics.as_mut_ptr().cast::<libc::integer_t>(),
            &mut count,
        )
    };
    let filled = status == libc::KERN_SUCCESS && count >= 3;
    ensure(filled, "host_statistics64")?;
    // SAFETY: category 4 (uninitialized memory): the whole structure was
    // zeroed; success with at least three integers initialized the free and
    // inactive counters, regardless of the OS's returned structure size.
    let statistics = unsafe { statistics.assume_init() };
    Ok(vm_available_bytes(
        statistics.free_count,
        statistics.inactive_count,
        page_size()?,
    ))
}

#[cfg(target_os = "macos")]
fn total_memory() -> io::Result<u64> {
    let mut memory: u64 = 0;
    let mut size = std::mem::size_of::<u64>();
    // SAFETY: FFI boundary (category 8): the name is a NUL-terminated literal;
    // memory is an initialized, writable u64 of exactly `size` bytes.
    let status = unsafe {
        libc::sysctlbyname(
            c"hw.memsize".as_ptr(),
            std::ptr::addr_of_mut!(memory).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    let filled = status == 0 && size == std::mem::size_of::<u64>();
    ensure(filled, "sysctlbyname")?;
    Ok(memory)
}

#[cfg(target_os = "macos")]
pub fn rss_bytes() -> io::Result<u64> {
    const SIZE: i32 = std::mem::size_of::<libc::proc_taskinfo>() as i32;
    let mut info = std::mem::MaybeUninit::<libc::proc_taskinfo>::zeroed();
    // SAFETY: FFI boundary (category 8): proc_pidinfo writes at most SIZE
    // bytes into an equally sized, writable proc_taskinfo allocation.
    let written = unsafe {
        libc::proc_pidinfo(
            libc::getpid(),
            libc::PROC_PIDTASKINFO,
            0,
            info.as_mut_ptr().cast(),
            SIZE,
        )
    };
    ensure(written == SIZE, "proc_pidinfo")?;
    // SAFETY: category 4 (uninitialized memory): proc_pidinfo returned the
    // full proc_taskinfo byte count before we read its resident-size field.
    Ok(unsafe { info.assume_init() }.pti_resident_size)
}

pub fn append_metrics(path: &Path, metrics: &Metrics) -> io::Result<()> {
    append_line(
        path,
        &serde_json::to_string(metrics).map_err(io::Error::other)?,
    )
}

/// Appends one line, keeping the newest 1000.
pub fn append_line(path: &Path, line: &str) -> io::Result<()> {
    let lock = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(path.with_extension("jsonl.lock"))?;
    lock.lock()?;
    let mut lines = match fs::read_to_string(path) {
        Ok(existing) => existing.lines().map(str::to_owned).collect::<Vec<_>>(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error),
    };
    lines.push(line.to_owned());
    let start = lines.len().saturating_sub(1000);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    for line in &lines[start..] {
        writeln!(file, "{line}")?;
    }
    Ok(())
}

/// Stream observations one `machine.report` carries.
pub const MAX_STREAM_OBSERVATIONS: usize = 4;

/// Adds the bounded `streams` observations to a report; none adds nothing.
pub fn with_streams(report: &mut serde_json::Value, mut streams: Vec<serde_json::Value>) {
    streams.truncate(MAX_STREAM_OBSERVATIONS);
    if !streams.is_empty() {
        report["streams"] = serde_json::Value::Array(streams);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simultaneous_writers_keep_both_metrics_lines() {
        let directory = tempfile::tempdir().expect("metrics directory");
        let path = directory.path().join("metrics.jsonl");
        let start = std::sync::Arc::new(std::sync::Barrier::new(3));
        std::thread::scope(|scope| {
            for line in ["first", "second"] {
                let start = start.clone();
                let path = &path;
                scope.spawn(move || {
                    start.wait();
                    append_line(path, line).expect("append metrics");
                });
            }
            start.wait();
        });
        let lines = fs::read_to_string(path).expect("both metrics lines");
        assert_eq!(lines.lines().count(), 2);
        assert!(lines.lines().any(|line| line == "first"));
        assert!(lines.lines().any(|line| line == "second"));
    }

    #[test]
    fn screen_permission_follows_the_injected_probe() {
        use crate::screen::{fixture::Fixture, Screen};

        let permitted = Screen::new(Box::new(Fixture::display(16, 16, 1.0)), 1);
        assert_eq!(screen_permission(permitted.probe()), "granted");
        let empty = Screen::new(Box::new(Fixture::default()), 1);
        assert_eq!(screen_permission(empty.probe()), "granted");
        let denied = Screen::new(
            Box::new(Fixture {
                denied: true,
                ..Fixture::default()
            }),
            1,
        );
        assert_eq!(screen_permission(denied.probe()), "denied");
        assert_eq!(
            screen_permission(Some(Err(Fault::Failed("screen unavailable".to_owned())))),
            "unsupported"
        );
        assert_eq!(screen_permission(Some(Err(Fault::Absent))), "unsupported");
        assert_eq!(screen_permission(Screen::absent().probe()), "unsupported");
    }

    #[test]
    fn meminfo_reads_named_kibibyte_field() {
        let text = "MemTotal:       2048 kB\nMemAvailable:    512 kB\n";
        assert_eq!(meminfo_bytes(text, "MemAvailable"), Some(512 * 1024));
        assert_eq!(meminfo_bytes(text, "MemTotal"), Some(2048 * 1024));
        assert_eq!(meminfo_bytes(text, "MemFree"), None);
        assert_eq!(meminfo_bytes("MemTotalX: 3 kB\n", "MemTotal"), None);
        assert_eq!(meminfo_bytes("MemTotal:\n", "MemTotal"), None);
        assert_eq!(meminfo_bytes("", "MemTotal"), None);
        assert_eq!(meminfo_bytes("MemTotal: x kB", "MemTotal"), None);
        assert_eq!(
            meminfo_bytes(&format!("MemTotal: {} kB", u64::MAX), "MemTotal"),
            Some(u64::MAX)
        );
    }

    #[test]
    fn statm_reads_resident_pages() {
        assert_eq!(statm_rss_bytes("100 25 3 1 0 9 0", 4096), Some(25 * 4096));
        assert_eq!(statm_rss_bytes("", 4096), None);
        assert_eq!(statm_rss_bytes("100", 4096), None);
        assert_eq!(statm_rss_bytes("100 x", 4096), None);
        assert_eq!(statm_rss_bytes("100 2", u64::MAX), Some(u64::MAX));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_counters_name_the_missing_field() {
        assert_eq!(
            meminfo("NoSuchCounter")
                .expect_err("absent meminfo key")
                .to_string(),
            "/proc/meminfo has no NoSuchCounter"
        );
        assert_eq!(resident("100 25", 4096).expect("resident"), 25 * 4096);
        assert_eq!(
            resident("100", 4096)
                .expect_err("statm without resident field")
                .to_string(),
            "/proc/self/statm has no resident field"
        );
    }

    #[test]
    fn vm_statistics_fold_free_and_inactive_pages() {
        assert_eq!(vm_available_bytes(3, 4, 16_384), 7 * 16_384);
        assert_eq!(vm_available_bytes(u32::MAX, u32::MAX, u64::MAX), u64::MAX);
    }

    #[test]
    fn system_probe_reads_native_counters() {
        let load = SystemProbe.load(3).expect("load");
        assert_eq!(load.in_flight, 3);
        assert!(load.load_avg1 >= 0.0);
        assert!(load.memory_available_bytes > 0);
        assert!(SystemProbe.rss().expect("rss") > 0);
        assert!(SystemProbe.memory().expect("memory") >= load.memory_available_bytes);
    }

    #[test]
    fn failed_counters_fail_the_load_sample() {
        assert_eq!(page_bytes(16_384).expect("page"), 16_384);
        assert_eq!(
            page_bytes(-1).expect_err("negative page size").kind(),
            io::ErrorKind::Other
        );
        assert_eq!(average(1, [0.25]).expect("average"), 0.25);
        for read in [-1, 0] {
            let error = average(read, [0.0]).expect_err("failed loadavg");
            assert_eq!(error.kind(), io::ErrorKind::Other);
            assert!(error.to_string().starts_with("getloadavg: "));
        }
        let sample = load(2, || Ok(0.5), || Ok(9)).expect("sample");
        assert_eq!(
            (
                sample.load_avg1,
                sample.memory_available_bytes,
                sample.in_flight
            ),
            (0.5, 9, 2)
        );
    }

    #[test]
    fn failed_load_probe_preserves_error() {
        let sample = load(
            0,
            || Err(io::Error::from(io::ErrorKind::Interrupted)),
            available_memory,
        );

        assert!(matches!(sample, Err(error) if error.kind() == io::ErrorKind::Interrupted));
    }

    #[test]
    fn failed_memory_probe_preserves_error() {
        let sample = load(
            0,
            || Ok(0.5),
            || Err(io::Error::from(io::ErrorKind::PermissionDenied)),
        );

        assert!(matches!(sample, Err(error) if error.kind() == io::ErrorKind::PermissionDenied));
    }

    #[test]
    fn failed_system_call_is_named() {
        assert!(ensure(true, "call").is_ok());
        assert!(ensure(false, "getloadavg")
            .expect_err("failed call")
            .to_string()
            .starts_with("getloadavg: "));
    }
}
