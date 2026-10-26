use oni_machine_client::agent::manifest::{self, Format};

fn kinds(records: &[oni_machine_client::agent::ParsedRecord]) -> Vec<&'static str> {
    records
        .iter()
        .map(|record| match record.record {
            oni_protocol::AgentTranscriptRecord::Turn { .. } => "turn",
            oni_protocol::AgentTranscriptRecord::ToolCall { .. } => "tool_call",
            oni_protocol::AgentTranscriptRecord::ToolResult { .. } => "tool_result",
            oni_protocol::AgentTranscriptRecord::Corrupt { .. } => "corrupt",
            oni_protocol::AgentTranscriptRecord::Truncated { .. } => "truncated",
        })
        .collect()
}

#[test]
fn parses_representative_records_for_every_dialect() {
    let cases: [(&[u8], Format); 4] = [
        (
            include_bytes!("fixtures/agent/claude/session.jsonl"),
            Format::ClaudeJsonl,
        ),
        (
            include_bytes!("fixtures/agent/codex/session.jsonl"),
            Format::CodexRolloutJsonl,
        ),
        (
            include_bytes!("fixtures/agent/pi/session.jsonl"),
            Format::PiJsonlV3,
        ),
        (
            include_bytes!("fixtures/agent/omp/session.jsonl"),
            Format::OmpJsonlV3,
        ),
    ];
    for (bytes, format) in cases {
        let records = format.parse(bytes);
        assert_eq!(kinds(&records), ["turn", "tool_call", "tool_result"]);
        let values = records
            .iter()
            .map(|record| serde_json::to_value(&record.record).expect("generated wire record"))
            .collect::<Vec<_>>();
        assert_eq!(values[0]["role"], "user");
        assert_eq!(values[0]["text"], "hello");
        assert_eq!(values[1]["callId"], "call-1");
        assert_eq!(values[1]["name"], "read");
        assert_eq!(values[2]["callId"], "call-1");
        assert_eq!(values[2]["output"], "contents");
        assert_eq!(values[2]["failed"], false);
    }
}

#[test]
fn long_normal_records_report_text_tool_input_and_result_truncation() {
    let long = "x".repeat(6000);
    let lines = [
        serde_json::json!({"type":"message","message":{"role":"user","content":long}}),
        serde_json::json!({"type":"message","message":{"role":"assistant","content":[
            {"type":"toolCall","id":"call-1","name":"read","arguments":{"text":long}}
        ]}}),
        serde_json::json!({"type":"message","message":{"role":"toolResult","toolCallId":"call-1","content":long}}),
    ];
    let bytes = format!("{}\n", lines.map(|line| line.to_string()).join("\n"));
    let parsed = Format::PiJsonlV3.parse(bytes.as_bytes());
    assert_eq!(kinds(&parsed), ["truncated", "truncated", "truncated"]);
    for record in &parsed {
        assert!(matches!(&record.record,
            oni_protocol::AgentTranscriptRecord::Truncated { original_bytes, .. }
                if original_bytes.get() >= 6000));
    }
}

#[test]
fn preserves_order_and_source_offsets() {
    let bytes = include_bytes!("fixtures/agent/pi/session.jsonl");
    let records = Format::PiJsonlV3.parse(bytes);
    let header_end = bytes
        .iter()
        .position(|byte| *byte == b'\n')
        .expect("fixture contains a session header")
        + 1;
    assert_eq!(records[0].start, header_end as u64);
    assert!(records.windows(2).all(|pair| pair[0].start < pair[1].start));
    assert_eq!(
        records.last().map(|record| record.end),
        Some(bytes.len() as u64)
    );
}

#[test]
fn reports_corrupt_encoding_shape_unsupported_and_truncated_tail() {
    let bytes = b"\xff\n{\n{}\npartial";
    for format in [
        Format::ClaudeJsonl,
        Format::CodexRolloutJsonl,
        Format::PiJsonlV3,
        Format::OmpJsonlV3,
    ] {
        let records = format.parse(bytes);
        assert_eq!(
            kinds(&records),
            ["corrupt", "corrupt", "corrupt", "truncated"]
        );
        assert_eq!(records[0].start, 0);
        assert_eq!(records[0].end, 2);
        assert_eq!(records[3].end, bytes.len() as u64);
        assert!(matches!(
            &records[0].record,
            oni_protocol::AgentTranscriptRecord::Corrupt { reason, .. }
                if reason.to_string() == "invalid_encoding"
        ));
        assert!(matches!(
            &records[3].record,
            oni_protocol::AgentTranscriptRecord::Truncated { original_bytes, .. }
                if original_bytes.get() == 7
        ));
    }
}

#[test]
fn manifest_selects_distinct_supported_formats() {
    assert_eq!(manifest::DIALECTS.len(), 4);
    assert!(manifest::DIALECTS
        .windows(2)
        .all(|pair| pair[0].format != pair[1].format));
    assert!(manifest::DIALECTS
        .iter()
        .all(|dialect| !dialect.discovery.is_empty()));
    assert!(manifest::select("unrecognized").is_none());
    for dialect in manifest::DIALECTS {
        assert_eq!(manifest::select(dialect.cli), Some(dialect));
        let bytes: &[u8] = match dialect.format {
            manifest::Format::ClaudeJsonl => include_bytes!("fixtures/agent/claude/session.jsonl"),
            manifest::Format::CodexRolloutJsonl => {
                include_bytes!("fixtures/agent/codex/session.jsonl")
            }
            manifest::Format::PiJsonlV3 => include_bytes!("fixtures/agent/pi/session.jsonl"),
            manifest::Format::OmpJsonlV3 => include_bytes!("fixtures/agent/omp/session.jsonl"),
        };
        assert_eq!(
            kinds(&dialect.format.parse(bytes)),
            ["turn", "tool_call", "tool_result"]
        );
    }
}

#[test]
fn preserves_multiple_records_from_one_physical_line() {
    let bytes = b"{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"done\"},{\"type\":\"tool_use\",\"id\":\"call-1\",\"name\":\"read\",\"input\":{}}]}}\n";
    let records = Format::ClaudeJsonl.parse(bytes);
    assert_eq!(kinds(&records), ["turn", "tool_call"]);
    assert!(records
        .iter()
        .all(|record| record.start == 0 && record.end == bytes.len() as u64));
}

#[test]
fn omp_title_slot_retains_absolute_byte_offsets() {
    let title = format!(
        "{:<255}\n",
        r#"{"type":"title","v":1,"title":"Example","pad":""}"#
    );
    let message = b"{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n";
    let bytes = [title.as_bytes(), message].concat();
    assert_eq!(title.len(), 256);
    let records = Format::OmpJsonlV3.parse(&bytes);
    assert_eq!(kinds(&records), ["turn"]);
    assert_eq!(
        (records[0].start, records[0].end),
        (256, bytes.len() as u64)
    );
}

#[test]
fn malformed_vendor_fields_are_corrupt_not_dropped() {
    let cases: [(&[u8], Format); 4] = [
        (b"{\"type\":\"assistant\",\"message\":{\"role\":\"other\",\"content\":\"x\"}}\n", Format::ClaudeJsonl),
        (b"{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"other\",\"content\":[]}}\n", Format::CodexRolloutJsonl),
        (b"{\"type\":\"message\",\"message\":{\"role\":\"toolResult\",\"content\":[]}}\n", Format::PiJsonlV3),
        (b"{\"type\":\"message\",\"message\":{\"role\":\"toolResult\",\"content\":[]}}\n", Format::OmpJsonlV3),
    ];
    for (bytes, format) in cases {
        assert_eq!(kinds(&format.parse(bytes)), ["corrupt"]);
    }
}

#[test]
fn rejects_incomplete_turns_and_tool_records() {
    let cases: [(&[u8], Format); 15] = [
        (b"{\"type\":\"other\"}\n", Format::ClaudeJsonl),
        (b"{\"type\":\"user\"}\n", Format::ClaudeJsonl),
        (b"{\"type\":\"user\",\"message\":{\"role\":\"assistant\",\"content\":\"x\"}}\n", Format::ClaudeJsonl),
        (b"{\"type\":\"user\",\"message\":{\"role\":\"user\"}}\n", Format::ClaudeJsonl),
        (b"{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":123}}\n", Format::ClaudeJsonl),
        (b"{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\"},{\"type\":\"tool_use\",\"id\":\"x\"},{\"type\":\"tool_result\"},{\"type\":\"image\"}]}}\n", Format::ClaudeJsonl),
        (b"{\"type\":\"response_item\"}\n", Format::CodexRolloutJsonl),
        (b"{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\"}}\n", Format::CodexRolloutJsonl),
        (b"{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{}]}}\n", Format::CodexRolloutJsonl),
        (b"{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\"}}\n", Format::CodexRolloutJsonl),
        (b"{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\"}}\n", Format::CodexRolloutJsonl),
        (b"{\"type\":\"response_item\",\"payload\":{\"type\":\"other\"}}\n", Format::CodexRolloutJsonl),
        (b"{\"type\":\"message\"}\n", Format::PiJsonlV3),
        (b"{\"type\":\"message\",\"message\":{\"role\":\"user\"}}\n", Format::PiJsonlV3),
        (b"{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\"},{\"type\":\"toolCall\"},{}]}}\n", Format::PiJsonlV3),
    ];
    for (bytes, format) in cases {
        assert!(format.parse(bytes).iter().all(|record| matches!(
            record.record,
            oni_protocol::AgentTranscriptRecord::Corrupt { .. }
        )));
    }
}

#[test]
fn rejects_nontext_result_parts_and_invalid_wire_identifiers() {
    let malformed = b"{\"type\":\"message\",\"message\":{\"role\":\"toolResult\",\"toolCallId\":\"call-1\",\"content\":[{\"type\":\"image\"}]}}\n";
    assert_eq!(kinds(&Format::PiJsonlV3.parse(malformed)), ["corrupt"]);
    let user_image = b"{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"image\"}]}}\n";
    assert_eq!(kinds(&Format::PiJsonlV3.parse(user_image)), ["corrupt"]);
    let empty_id = b"{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"call_id\":\"\",\"name\":\"read\",\"arguments\":\"{}\"}}\n";
    assert_eq!(
        kinds(&Format::CodexRolloutJsonl.parse(empty_id)),
        ["corrupt"]
    );
    let missing_result = b"{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"call-1\"}]}}\n";
    assert_eq!(
        kinds(&Format::ClaudeJsonl.parse(missing_result)),
        ["corrupt"]
    );
    let failed_result = b"{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"call-1\",\"content\":\"failed\",\"is_error\":true}]}}\n";
    let records = Format::ClaudeJsonl.parse(failed_result);
    assert_eq!(kinds(&records), ["tool_result"]);
    assert_eq!(
        serde_json::to_value(&records[0].record).expect("generated wire record")["failed"],
        true
    );
}

#[test]
fn omp_rejects_unknown_entries_but_skips_known_metadata() {
    let bytes = b"{\"type\":\"title\"}\n{\"type\":\"mode_change\"}\n{\"type\":\"unknown\"}\n";
    let records = Format::OmpJsonlV3.parse(bytes);
    assert_eq!(kinds(&records), ["corrupt"]);
    assert_eq!(
        records[0].start,
        b"{\"type\":\"title\"}\n{\"type\":\"mode_change\"}\n".len() as u64
    );
}

#[test]
fn pi_preserves_assistant_text_and_rejects_unknown_roles() {
    let bytes = b"{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}\n";
    let records = Format::PiJsonlV3.parse(bytes);
    assert_eq!(kinds(&records), ["turn"]);
    assert_eq!(
        serde_json::to_value(&records[0].record).expect("generated wire record")["text"],
        "done"
    );
    for bytes in [
        &b"{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":\"not an array\"}}\n"[..],
        &b"{\"type\":\"message\",\"message\":{\"role\":\"future\",\"content\":\"unknown\"}}\n"[..],
    ] {
        assert_eq!(kinds(&Format::PiJsonlV3.parse(bytes)), ["corrupt"]);
    }
}
