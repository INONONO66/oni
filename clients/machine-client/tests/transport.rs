#[path = "support/mod.rs"]
mod support;

use std::{
    future::Future,
    io,
    path::Path,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};

use oni_machine_client::transport::{
    client::{handler, Client, TransportError},
    envelope::{self, Message},
    framing::{FrameError, Framed, MAX_FRAME_BYTES},
    request_table::{CallError, RequestTable},
};
use serde_json::json;
use support::fake_host::FakeHost;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf},
    sync::{mpsc, Semaphore},
};

#[path = "transport/connection.rs"]
mod connection_cases;
#[path = "transport/envelope.rs"]
mod envelope_cases;
#[path = "transport/framing.rs"]
mod framing_cases;
#[path = "transport/limits.rs"]
mod limits;
