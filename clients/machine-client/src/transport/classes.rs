use std::io;

use serde::Serialize;

use crate::{
    attach::AttachError,
    transport::{client::TransportError, request_table::CallError},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureClass {
    Authentication,
    Configuration,
    HostUnreachable,
    RemoteUnavailable,
    Timeout,
    Superseded,
}

impl FailureClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Authentication => "authentication",
            Self::Configuration => "configuration",
            Self::HostUnreachable => "host_unreachable",
            Self::RemoteUnavailable => "remote_unavailable",
            Self::Timeout => "timeout",
            Self::Superseded => "superseded",
        }
    }

    pub fn retries(self) -> bool {
        matches!(
            self,
            Self::HostUnreachable | Self::RemoteUnavailable | Self::Timeout
        )
    }

    pub fn next_step(self) -> &'static str {
        match self {
            Self::Authentication => "check enrollment and peer identity",
            Self::Configuration => "correct client configuration and host pin",
            Self::HostUnreachable => "check host address and network",
            Self::RemoteUnavailable => "check host admission and capacity",
            Self::Timeout => "check host responsiveness",
            Self::Superseded => "wait for the newer attachment",
        }
    }
}

pub fn classify_io(error: &io::Error) -> FailureClass {
    match error.kind() {
        io::ErrorKind::TimedOut => FailureClass::Timeout,
        _ => FailureClass::HostUnreachable,
    }
}

pub fn classify(error: &AttachError) -> FailureClass {
    match error {
        AttachError::Terminal(reason)
            if reason == "peer_key_mismatch" || reason == "machine_not_enrolled" =>
        {
            FailureClass::Authentication
        }
        AttachError::Terminal(reason) if reason == "stale_generation" => FailureClass::Superseded,
        AttachError::Terminal(_)
        | AttachError::Config(_)
        | AttachError::Io(_)
        | AttachError::Decode(_)
        | AttachError::Json(_)
        | AttachError::Computer(_)
        | AttachError::Update(_)
        | AttachError::ServiceUnavailable => FailureClass::Configuration,
        AttachError::Once(class) => *class,
        AttachError::Transport(
            TransportError::HostKeyMismatch
            | TransportError::HostCertificate
            | TransportError::Tls(_),
        ) => FailureClass::Configuration,
        AttachError::Transport(TransportError::ConnectTimeout)
        | AttachError::Call(CallError::Timeout(_)) => FailureClass::Timeout,
        AttachError::Transport(TransportError::Connect(error)) => classify_io(error),
        AttachError::Call(CallError::Remote(reason))
            if reason.contains("machine_not_enrolled") || reason.contains("peer_key_mismatch") =>
        {
            FailureClass::Authentication
        }
        AttachError::Transport(
            TransportError::Frame(_)
            | TransportError::Envelope(_)
            | TransportError::Closed
            | TransportError::QueueFull,
        )
        | AttachError::Call(CallError::Disconnected | CallError::Remote(_)) => {
            FailureClass::RemoteUnavailable
        }
        AttachError::EventsClosed => FailureClass::RemoteUnavailable,
        AttachError::MemoryBudget => FailureClass::Configuration,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attach_refusals_keep_authentication_configuration_and_capacity_separate() {
        for (reason, expected) in [
            ("peer_key_mismatch", FailureClass::Authentication),
            ("machine_not_enrolled", FailureClass::Authentication),
            ("unsupported_contract", FailureClass::Configuration),
            ("stale_generation", FailureClass::Superseded),
        ] {
            assert_eq!(
                classify(&AttachError::Terminal(reason.to_owned())),
                expected
            );
        }
    }

    #[test]
    fn transport_timeout_and_host_key_mismatch_have_distinct_actions() {
        assert_eq!(
            classify(&AttachError::Transport(TransportError::ConnectTimeout)),
            FailureClass::Timeout
        );
        assert_eq!(
            classify(&AttachError::Transport(TransportError::HostKeyMismatch)),
            FailureClass::Configuration
        );
        assert_eq!(
            classify(&AttachError::Transport(TransportError::Connect(
                io::Error::new(io::ErrorKind::ConnectionRefused, "refused")
            ))),
            FailureClass::HostUnreachable
        );
        assert_eq!(
            classify_io(&io::Error::new(io::ErrorKind::TimedOut, "timeout")),
            FailureClass::Timeout
        );
    }

    #[test]
    fn retry_classes_are_only_network_and_remote_failures() {
        for class in [
            FailureClass::Authentication,
            FailureClass::Configuration,
            FailureClass::Superseded,
        ] {
            assert!(!class.retries());
        }
        for class in [
            FailureClass::HostUnreachable,
            FailureClass::RemoteUnavailable,
            FailureClass::Timeout,
        ] {
            assert!(class.retries());
        }
    }

    #[test]
    fn every_class_has_a_wire_name_and_remediation() {
        for (class, name) in [
            (FailureClass::Authentication, "authentication"),
            (FailureClass::Configuration, "configuration"),
            (FailureClass::HostUnreachable, "host_unreachable"),
            (FailureClass::RemoteUnavailable, "remote_unavailable"),
            (FailureClass::Timeout, "timeout"),
            (FailureClass::Superseded, "superseded"),
        ] {
            assert_eq!(class.as_str(), name);
            assert!(!class.next_step().is_empty());
        }
    }

    #[test]
    fn io_and_remote_call_failures_remain_distinct() {
        assert_eq!(
            classify(&AttachError::Call(CallError::Remote(
                "peer_key_mismatch".to_owned()
            ))),
            FailureClass::Authentication
        );
        assert_eq!(
            classify(&AttachError::Call(CallError::Remote(
                "host draining".to_owned()
            ))),
            FailureClass::RemoteUnavailable
        );
        assert_eq!(
            classify(&AttachError::Call(CallError::Timeout("attach".to_owned()))),
            FailureClass::Timeout
        );
        assert_eq!(
            classify(&AttachError::Once(FailureClass::Superseded)),
            FailureClass::Superseded
        );
        assert_eq!(
            classify(&AttachError::MemoryBudget),
            FailureClass::Configuration
        );
    }

    #[test]
    fn closed_attachment_events_are_remote_unavailable() {
        assert_eq!(
            classify(&AttachError::EventsClosed),
            FailureClass::RemoteUnavailable
        );
    }
}
