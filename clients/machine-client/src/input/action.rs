//! Ref-targeted actions (#1689): `machine.input.action` names the
//! observation it read; the screen's observations check it against the
//! window's latest observation and a fresh walk before the observer acts.

use oni_protocol::{input_action_request::InputActionRequestAction, InputActionRequest};
use serde_json::{json, Value};
use std::cell::Cell;

use crate::input::dispatch::{DispatchLedger, Entry};
use crate::screen::{
    ax::Action,
    observe::{target, Act},
    Screen,
};

/// The request as [`Act`]; `setValue` needs `value` and `perform` needs
/// `name`, so a request without them is invalid params.
pub fn parse(request: &InputActionRequest) -> Result<Act, String> {
    let action = match request.action {
        InputActionRequestAction::Press => Action::Press,
        InputActionRequestAction::SetValue => Action::SetValue(
            request
                .value
                .as_ref()
                .ok_or("setValue needs value")?
                .to_string(),
        ),
        InputActionRequestAction::Perform => Action::Perform(
            request
                .name
                .as_ref()
                .ok_or("perform needs name")?
                .to_string(),
        ),
    };
    let wire = &request.target;
    Ok(Act {
        target: target(wire.pid.get(), wire.window_id, Some(wire.epoch)),
        observation: request.observation_id.to_string(),
        reference: request.ref_.to_string(),
        action,
        wait_ms: request.wait_ms.map_or(2000, |wait| wait.unsigned_abs()),
    })
}

pub fn serve_action(screen: &Screen, act: &Act) -> Value {
    screen
        .act(act)
        .map_or_else(|refusal| refusal.acted(), |()| json!({"status": "ok"}))
}

pub fn serve_action_guarded(
    screen: &Screen,
    act: &Act,
    entry: &Entry,
    ledger: &DispatchLedger,
) -> Value {
    let cancelled = Cell::new(false);
    let result = screen.act_guarded(act, &|| {
        if !entry.before_event(ledger.current()) {
            cancelled.set(true);
            return false;
        }
        entry.dispatching();
        true
    });
    if cancelled.get() || (!entry.before_event(ledger.current()) && !entry.dispatched()) {
        return entry.cancelled_result();
    }
    result.map_or_else(
        |refusal| refusal.acted(),
        |()| {
            entry.delivered();
            json!({"status": "ok"})
        },
    )
}
