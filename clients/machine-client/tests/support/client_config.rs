use std::path::Path;

use oni_machine_client::config::{ClientConfig, Export};

/// A test client config with one export `name` at `root`, or none.
pub fn client_config(root: &Path, export: Option<&str>) -> ClientConfig {
    ClientConfig {
        machine_id: "laptop".into(),
        name: "Laptop".into(),
        host: "127.0.0.1:7643".into(),
        tags: vec![],
        exports: export
            .map(|name| Export {
                name: name.into(),
                path: root.to_str().expect("utf8 root").into(),
            })
            .into_iter()
            .collect(),
        memory_budget_mb: 96,
        unix: None,
        tmux_socket: None,
    }
}
