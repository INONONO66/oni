use oni_protocol::ComputerCloseRequest;
use serde_json::{json, Value};

use crate::input::dispatch::DispatchLedger;

pub fn serve_computer_close(ledger: &DispatchLedger, request: &ComputerCloseRequest) -> Value {
    ledger.cancel_through(request.generation.get(), request.through.get());
    json!({"status": "closed"})
}

#[cfg(test)]
mod tests {
    use super::*;
    use oni_protocol::decode;

    #[test]
    fn stop_fences_started_and_delayed_input_without_cancelling_future_calls() {
        let ledger = DispatchLedger::default();
        ledger.attach(1);
        let running = ledger.start("1-1").expect("running input");
        running.dispatching();
        running.delivered();
        let request = decode::<ComputerCloseRequest>(json!({"generation":1,"through":2}))
            .expect("close request");

        assert_eq!(
            serve_computer_close(&ledger, &request),
            json!({"status":"closed"})
        );
        assert!(!running.before_event(ledger.current()));
        running.cancelled_result();
        running.finish();
        assert_eq!(
            ledger.status("1-1"),
            json!({
                "status":"ok","requestId":"1-1","dispatched":true,"state":"cancelled","eventsDelivered":1
            })
        );
        let delayed = ledger.start("1-2").expect("delayed input");
        assert!(!delayed.before_event(ledger.current()));
        delayed.cancelled_result();
        delayed.finish();
        assert_eq!(ledger.status("1-2")["state"], "cancelled");
        assert!(ledger
            .start("1-3")
            .expect("new input")
            .before_event(ledger.current()));
        ledger.cancel_through(1, 1);
        assert!(ledger
            .start("1-4")
            .expect("newer input")
            .before_event(ledger.current()));
        ledger.attach(2);
        ledger.cancel_through(1, 99);
        assert!(ledger
            .start("2-1")
            .expect("reattached input")
            .before_event(ledger.current()));
    }
}
