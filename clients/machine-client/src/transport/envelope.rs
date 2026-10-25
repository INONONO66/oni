use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq)]
pub enum Message {
    Response {
        id: String,
        raw: Value,
    },
    Request {
        id: String,
        method: String,
        params: Option<Value>,
    },
    Notification {
        method: String,
        params: Option<Value>,
    },
}

#[derive(Debug, thiserror::Error)]
#[error("IPC frame matched no v2 message schema")]
pub struct EnvelopeError;

#[derive(Deserialize)]
struct Response {
    v: u8,
    #[serde(rename = "type")]
    kind: String,
    id: String,
    result: Option<Value>,
    error: Option<RemoteError>,
}

#[derive(Deserialize)]
struct RemoteError {
    code: i64,
    message: String,
    data: Option<Value>,
}

#[derive(Deserialize)]
struct Request {
    v: u8,
    #[serde(rename = "type")]
    kind: String,
    id: String,
    method: String,
    params: Option<serde_json::Map<String, Value>>,
}

#[derive(Deserialize)]
struct Notification {
    v: u8,
    #[serde(rename = "type")]
    kind: String,
    method: String,
    params: Option<serde_json::Map<String, Value>>,
}

pub fn classify(raw: Value) -> Result<Message, EnvelopeError> {
    if let Ok(response) = serde_json::from_value::<Response>(raw.clone()) {
        if response.v == 2 && response.kind == "response" {
            let _ = (
                response.result,
                response.error.map(|e| (e.code, e.message, e.data)),
            );
            return Ok(Message::Response {
                id: response.id,
                raw,
            });
        }
    }
    if let Ok(request) = serde_json::from_value::<Request>(raw.clone()) {
        if request.v == 2 && request.kind == "request" {
            return Ok(Message::Request {
                id: request.id,
                method: request.method,
                params: request.params.map(Value::Object),
            });
        }
    }
    if let Ok(notification) = serde_json::from_value::<Notification>(raw) {
        if notification.v == 2 && notification.kind == "notification" {
            return Ok(Message::Notification {
                method: notification.method,
                params: notification.params.map(Value::Object),
            });
        }
    }
    Err(EnvelopeError)
}

pub fn request(id: &str, method: &str, params: Option<Value>) -> Value {
    let mut frame = json!({ "v": 2, "type": "request", "id": id, "method": method });
    if let Some(params) = params {
        frame["params"] = params;
    }
    frame
}

pub fn response(id: &str, result: Value) -> Value {
    json!({ "v": 2, "type": "response", "id": id, "result": result })
}

pub fn error(id: &str, code: i64, message: &str) -> Value {
    json!({ "v": 2, "type": "response", "id": id, "error": { "code": code, "message": message } })
}
