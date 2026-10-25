use super::*;

#[test]
fn envelope_preserves_result_error_and_null_fields() {
    let raw = json!({"v":2,"type":"response","id":"c9","result":null,"error":{"code":4001,"message":"full","data":null}});
    assert_eq!(
        envelope::classify(raw.clone()).expect("response"),
        Message::Response {
            id: "c9".into(),
            raw
        }
    );
}

#[test]
fn classification_distinguishes_all_wire_kinds_and_refuses_invalid() {
    assert!(matches!(
        envelope::classify(json!({"v":2,"type":"request","id":"h1","method":"ping","params":{}})),
        Ok(Message::Request { .. })
    ));
    assert!(matches!(
        envelope::classify(json!({"v":2,"type":"notification","method":"event"})),
        Ok(Message::Notification { .. })
    ));
    assert!(envelope::classify(json!({"v":1,"type":"response","id":"c1"})).is_err());
    assert!(envelope::classify(json!({"v":1,"type":"request","id":"c1","method":"ping"})).is_err());
    assert!(envelope::classify(json!({"v":1,"type":"notification","method":"event"})).is_err());
    assert!(envelope::classify(
        json!({"v":2,"type":"response","id":"c1","error":{"code":"bad","message":"bad"}})
    )
    .is_err());
}

#[test]
fn envelope_builders_preserve_optional_fields_and_error_code() {
    assert_eq!(
        envelope::request("c1", "ping", Some(json!({"n": 1}))),
        json!({"v":2,"type":"request","id":"c1","method":"ping","params":{"n":1}})
    );
    assert_eq!(envelope::error("h1", 4001, "full")["error"]["code"], 4001);
    assert_eq!(envelope::response("h1", json!(null))["result"], json!(null));
    assert!(matches!(
        envelope::classify(
            json!({"v":2,"type":"request","id":"h1","method":"ping","params":{"n":1}})
        ),
        Ok(Message::Request {
            params: Some(_),
            ..
        })
    ));
    assert!(matches!(
        envelope::classify(json!({"v":2,"type":"notification","method":"event","params":{"n":1}})),
        Ok(Message::Notification {
            params: Some(_),
            ..
        })
    ));
}

#[test]
fn request_ids_are_monotonic_and_responses_settle_once() {
    let mut table = RequestTable::default();
    let (first, receiver) = table.register();
    let (second, _) = table.register();
    assert_eq!((first.as_str(), second.as_str()), ("c1", "c2"));
    table.resolve(&first, json!({"result": 7}));
    assert_eq!(
        receiver.blocking_recv().expect("settled"),
        json!({"result": 7})
    );
    assert_eq!(table.len(), 1);
    table.remove(&second);
    assert!(table.is_empty());
}
