use std::{io, ptr::NonNull};

use block2::RcBlock;
use objc2_app_kit::{
    NSWorkspace, NSWorkspaceDidWakeNotification, NSWorkspaceWillSleepNotification,
};
use objc2_foundation::NSNotification;
use tokio::sync::mpsc;

use super::retry::Event;

pub fn subscribe(events: mpsc::UnboundedSender<Event>) -> io::Result<()> {
    let (ready, registered) = std::sync::mpsc::sync_channel(0);
    std::thread::spawn(move || {
        let center = NSWorkspace::sharedWorkspace().notificationCenter();
        let awake = events.clone();
        let waking = RcBlock::new(move |_: NonNull<NSNotification>| {
            let _sent = awake.send(Event::Wake);
        });
        let sleeping = RcBlock::new(move |_: NonNull<NSNotification>| {
            let _sent = events.send(Event::Suspend);
        });
        // SAFETY: category 8 (FFI): AppKit retains each copied block for the
        // observer lifetime; the blocks own their senders and the observer
        // tokens remain live while this thread runs its CFRunLoop.
        let _wake = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceDidWakeNotification),
                None,
                None,
                &waking,
            )
        };
        // SAFETY: category 8 (FFI): the owned block and token outlive the
        // run loop exactly as for the wake notification above.
        let _sleep = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceWillSleepNotification),
                None,
                None,
                &sleeping,
            )
        };
        let _registered = ready.send(());
        // SAFETY: category 8 (FFI): Core Foundation owns the current
        // thread's run loop; observers remain owned until process exit.
        unsafe { core_foundation_sys::runloop::CFRunLoopRun() };
    });
    registered.recv().map_err(io::Error::other)
}
