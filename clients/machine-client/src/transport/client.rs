use std::{
    collections::VecDeque,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::Value;
use tokio::{
    io::{split, AsyncRead, AsyncWrite},
    sync::mpsc,
    task::{JoinHandle, JoinSet},
    time::timeout,
};

use super::{
    envelope::{self, Message},
    framing::{self, Framed},
    request_table::{CallError, Pending, RequestTable, CALL_TIMEOUT},
};

const EXECUTING: usize = 16;
const WAITING: usize = 64;
const WRITER_CAPACITY: usize = 256;
enum Outbound {
    Frame(Value),
    Close,
}

type HandlerFuture = Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>;
pub type Handler = Arc<dyn Fn(String, Option<Value>) -> HandlerFuture + Send + Sync>;

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error(transparent)]
    Frame(#[from] framing::FrameError),
    #[error(transparent)]
    Envelope(#[from] envelope::EnvelopeError),
    #[error("IPC connection timeout")]
    ConnectTimeout,
    #[error("IPC connection failed: {0}")]
    Connect(#[from] std::io::Error),
    #[error("IPC TLS configuration failed: {0}")]
    Tls(#[from] rustls::Error),
    #[error("IPC host certificate is missing or malformed")]
    HostCertificate,
    #[error("IPC host public key does not match the configured pin")]
    HostKeyMismatch,
    #[error("IPC peer closed")]
    Closed,
    #[error("IPC inbound request queue is full")]
    QueueFull,
}

/// A clonable handle that issues calls over a live connection; once the
/// connection ends every call fails with `CallError::Disconnected`.
#[derive(Clone)]
pub struct Caller {
    outbound: mpsc::Sender<Outbound>,
    requests: Arc<Mutex<RequestTable>>,
}

impl Caller {
    pub async fn call_with_timeout(
        &self,
        method: &str,
        params: Option<Value>,
        duration: Duration,
    ) -> Result<Option<Value>, CallError> {
        let (id, receiver) = self
            .requests
            .lock()
            .map_err(|_| CallError::Disconnected)?
            .register();
        let pending = Pending::new(id, &self.requests);
        let frame = timeout(duration, async {
            self.outbound
                .send(Outbound::Frame(envelope::request(
                    &pending.id,
                    method,
                    params,
                )))
                .await
                .map_err(|_| CallError::Disconnected)?;
            receiver.await.map_err(|_| CallError::Disconnected)
        })
        .await
        .map_err(|_| CallError::Timeout(method.to_owned()))??;
        if let Some(error) = frame.get("error") {
            return Err(CallError::Remote(error.to_string()));
        }
        Ok(frame.get("result").cloned())
    }
}

pub struct Client {
    outbound: mpsc::Sender<Outbound>,
    requests: Arc<Mutex<RequestTable>>,
    reader: JoinHandle<Result<(), TransportError>>,
    writer: JoinHandle<Result<(), framing::FrameError>>,
}

impl Client {
    pub fn from_stream<S>(stream: S, handler: Handler) -> Self
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let (reader, mut writer) = split(stream);
        let (outbound, mut frames) = mpsc::channel(WRITER_CAPACITY);
        let writer = tokio::spawn(async move {
            while let Some(frame) = frames.recv().await {
                match frame {
                    Outbound::Frame(value) => framing::write_frame(&mut writer, &value).await?,
                    Outbound::Close => break,
                }
            }
            Ok(())
        });
        let requests = Arc::new(Mutex::new(RequestTable::default()));
        let reader = tokio::spawn(read_loop(
            Framed::new(reader),
            outbound.clone(),
            requests.clone(),
            handler,
        ));
        Self {
            outbound,
            requests,
            reader,
            writer,
        }
    }

    pub async fn call(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> Result<Option<Value>, CallError> {
        self.call_with_timeout(method, params, CALL_TIMEOUT).await
    }

    pub async fn notify(&self, method: &str, params: Option<Value>) -> Result<(), CallError> {
        let mut frame = serde_json::json!({ "v": 2, "type": "notification", "method": method });
        if let Some(params) = params {
            frame["params"] = params;
        }
        self.outbound
            .send(Outbound::Frame(frame))
            .await
            .map_err(|_| CallError::Disconnected)
    }

    pub async fn call_with_timeout(
        &self,
        method: &str,
        params: Option<Value>,
        duration: Duration,
    ) -> Result<Option<Value>, CallError> {
        self.caller()
            .call_with_timeout(method, params, duration)
            .await
    }

    pub fn caller(&self) -> Caller {
        Caller {
            outbound: self.outbound.clone(),
            requests: self.requests.clone(),
        }
    }

    pub fn pending_calls(&self) -> usize {
        self.requests.lock().map_or(0, |table| table.len())
    }

    pub fn writer_remaining(&self) -> usize {
        self.outbound.capacity()
    }

    pub async fn closed(&mut self) -> Result<(), TransportError> {
        let result = (&mut self.reader)
            .await
            .map_err(|_| TransportError::Closed)?;
        (&mut self.writer)
            .await
            .map_err(|_| TransportError::Closed)??;
        result
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        self.reader.abort();
        self.writer.abort();
        if let Ok(mut table) = self.requests.lock() {
            *table = RequestTable::default();
        }
    }
}

async fn read_loop(
    mut reader: Framed,
    outbound: mpsc::Sender<Outbound>,
    requests: Arc<Mutex<RequestTable>>,
    handler: Handler,
) -> Result<(), TransportError> {
    let result = read_frames(&mut reader, &outbound, &requests, &handler).await;
    let _closed = outbound.send(Outbound::Close).await;
    if let Ok(mut table) = requests.lock() {
        *table = RequestTable::default();
    }
    result
}

async fn read_frames(
    reader: &mut Framed,
    outbound: &mpsc::Sender<Outbound>,
    requests: &Arc<Mutex<RequestTable>>,
    handler: &Handler,
) -> Result<(), TransportError> {
    let mut tasks = JoinSet::new();
    // Cells await host callbacks and may outlive many ordinary requests.
    // They cannot consume the slots those callbacks and cancellation need.
    let mut cells = JoinSet::new();
    let mut active = 0;
    let mut waiting = VecDeque::new();
    loop {
        tokio::select! {
            _finished = cells.join_next(), if !cells.is_empty() => {}
            _finished = tasks.join_next(), if active > 0 => {
                active -= 1;
                if let Some((id, method, params)) = waiting.pop_front() {
                    spawn_request(&mut tasks, id, method, params, outbound.clone(), handler.clone());
                    active += 1;
                }
            }
            frame = reader.next() => {
                let Some(frame) = frame? else { return Err(TransportError::Closed) };
                match envelope::classify(frame)? {
                    Message::Response { id, raw } => {
                        if let Ok(mut table) = requests.lock() {
                            table.resolve(&id, raw);
                        }
                    }
                    Message::Request { id, method, params } if method == "machine.run_code" => {
                        if cells.len() < WAITING {
                            spawn_request(&mut cells, id, method, params, outbound.clone(), handler.clone());
                        } else {
                            outbound.send(Outbound::Frame(envelope::error(&id, 4001, "IPC inbound cell limit reached")))
                                .await.map_err(|_| TransportError::Closed)?;
                        }
                    }
                    Message::Request { id, method, params } if active < EXECUTING => {
                        spawn_request(&mut tasks, id, method, params, outbound.clone(), handler.clone());
                        active += 1;
                    }
                    Message::Request { id, method, params } => {
                        if waiting.len() == WAITING {
                            outbound.send(Outbound::Frame(envelope::error(&id, 4001, "IPC inbound request queue is full")))
                                .await.map_err(|_| TransportError::Closed)?;
                            return Err(TransportError::QueueFull);
                        }
                        waiting.push_back((id, method, params));
                    }
                    Message::Notification { method, params } => {
                        let _result = handler(method, params).await;
                    }
                }
            }
        }
    }
}

fn spawn_request(
    tasks: &mut JoinSet<()>,
    id: String,
    method: String,
    params: Option<Value>,
    outbound: mpsc::Sender<Outbound>,
    handler: Handler,
) {
    tasks.spawn(async move {
        let frame = match handler(method, params).await {
            Ok(result) => envelope::response(&id, result),
            Err(message) => envelope::error(&id, 1000, &message),
        };
        let _sent = outbound.send(Outbound::Frame(frame)).await;
    });
}

pub fn handler<F, Fut>(callback: F) -> Handler
where
    F: Fn(String, Option<Value>) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Value, String>> + Send + 'static,
{
    Arc::new(move |method, params| Box::pin(callback(method, params)))
}
