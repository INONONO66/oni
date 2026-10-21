//! Generates Rust types for every machine wire schema listed in
//! `packages/protocol/schema/machine/index.json`.
//!
//! Each schema file is converted in its own `TypeSpace` and lands in its own
//! module, because every file carries its own `definitions` namespace and the
//! same local definition name can mean different shapes in different files.
//! The root type is named after the index entry and re-exported at the crate
//! root.
//!
//! Generated code is written as one token line per module, so clippy's
//! `possible_missing_else` (a layout lint about `} if` on one line) is allowed
//! on those modules only.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use typify::{TypeSpace, TypeSpaceSettings};

const SCHEMA_DIR: &str = "../../packages/protocol/schema/machine";

struct Entry {
    name: String,
    file: String,
}

fn main() {
    let schema_dir = Path::new(SCHEMA_DIR);
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set by cargo"));
    println!("cargo:rerun-if-changed={SCHEMA_DIR}");

    let index = read_json(&schema_dir.join("index.json"));
    let version = index["contractVersion"]
        .as_u64()
        .expect("index.json contractVersion is a non-negative integer");
    let version = u32::try_from(version).expect("index.json contractVersion fits in u32");

    let mut root = format!(
        "/// Machine wire contract version these types were generated from.\n\
         pub const CONTRACT_VERSION: u32 = {version};\n"
    );
    for entry in entries(&index) {
        let path = schema_dir.join(&entry.file);
        println!("cargo:rerun-if-changed={}", path.display());
        let module = module_name(&entry.name);
        let code = generate(&entry.name, read_json(&path));
        fs::write(out_dir.join(format!("{module}.rs")), code).expect("write generated module");
        root.push_str(&format!(
            "/// Types generated from `{file}`.\n\
             #[allow(clippy::possible_missing_else)]\n\
             pub mod {module} {{\n    include!(concat!(env!(\"OUT_DIR\"), \"/{module}.rs\"));\n}}\n\
             pub use {module}::{name};\n",
            file = entry.file,
            name = entry.name,
        ));
    }
    fs::write(out_dir.join("machine.rs"), root).expect("write machine.rs");
}

fn read_json(path: &Path) -> Value {
    let text =
        fs::read_to_string(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

fn entries(index: &Value) -> Vec<Entry> {
    let schemas = index["schemas"]
        .as_array()
        .expect("index.json schemas is an array");
    schemas
        .iter()
        .map(|item| Entry {
            name: item["name"].as_str().expect("schema name").to_owned(),
            file: item["file"].as_str().expect("schema file").to_owned(),
        })
        .collect()
}

/// Converts one schema document. The index name becomes the schema title so
/// typify emits the root type under that name.
fn generate(name: &str, mut schema: Value) -> String {
    name_variant_members(&mut schema, name, false);
    let root = schema
        .as_object_mut()
        .unwrap_or_else(|| panic!("{name}: schema document is an object"));
    close_empty_root(name, root);
    root.insert("title".to_owned(), Value::String(name.to_owned()));
    let root = serde_json::from_value(schema)
        .unwrap_or_else(|error| panic!("{name}: not a draft-07 root schema: {error}"));
    let mut space = TypeSpace::new(&TypeSpaceSettings::default());
    space
        .add_root_schema(root)
        .unwrap_or_else(|error| panic!("{name}: typify refused the schema: {error}"))
        .unwrap_or_else(|| panic!("{name}: typify produced no root type"));
    space.to_stream().to_string()
}

/// typify cannot name a struct, a nested union, a constrained string or a
/// string enum that sits below a `oneOf`/`anyOf` member (the member itself
/// becomes an enum variant and has no type name to derive from), and panics
/// instead. This pass gives every
/// such schema a `title` built from its path, the same way typify names
/// property types elsewhere: parent name, then the property name, `Item` for
/// array items, `Value` for map values, and the member's discriminant for a
/// union member. It also rewrites `const` as a one-value `enum`. Validation keywords are untouched, so the generated types
/// accept exactly what the schema accepts.
fn name_variant_members(schema: &mut Value, path: &str, below_variant: bool) {
    if let Some(object) = schema.as_object_mut() {
        // typify drops `const` on a struct field and accepts any value of the
        // base type; the one-value `enum` is the same constraint and is kept.
        if let Some(value) = object.remove("const") {
            object.insert("enum".to_owned(), Value::Array(vec![value]));
        }
        if below_variant && needs_name(object) && !object.contains_key("title") {
            object.insert("title".to_owned(), Value::String(path.to_owned()));
        }
    }
    name_children(schema, path, below_variant);
}

/// Walks the children of one schema; union members are walked without being
/// titled themselves so they stay inline enum variants.
fn name_children(schema: &mut Value, path: &str, below_variant: bool) {
    let Some(object) = schema.as_object_mut() else {
        return;
    };
    if let Some(Value::Object(properties)) = object.get_mut("properties") {
        for (key, property) in properties.iter_mut() {
            name_variant_members(property, &format!("{path}{}", pascal(key)), below_variant);
        }
    }
    for (key, suffix) in [("items", "Item"), ("additionalProperties", "Value")] {
        if let Some(child) = object.get_mut(key) {
            name_variant_members(child, &format!("{path}{suffix}"), below_variant);
        }
    }
    for key in ["oneOf", "anyOf"] {
        if let Some(Value::Array(members)) = object.get_mut(key) {
            // `X | null` becomes `Option<X>`, so X is a type of its own.
            let nullable = members.len() == 2 && members.iter().any(is_null);
            for (position, member) in members.iter_mut().enumerate() {
                if nullable {
                    name_variant_members(member, path, below_variant);
                } else {
                    let member_path = format!("{path}{}", member_label(member, position));
                    name_children(member, &member_path, true);
                }
            }
        }
    }
}

/// A closed object with no properties becomes an empty struct, and serde also
/// accepts an empty array for any struct. A map whose value type has no
/// members accepts exactly `{}`. typify names that value type only through a
/// definition, so the empty enum is hoisted into `definitions`. Only the
/// document root is rewritten; the exported schemas have no nested case.
fn close_empty_root(name: &str, root: &mut serde_json::Map<String, Value>) {
    let no_properties = root
        .get("properties")
        .and_then(Value::as_object)
        .is_some_and(serde_json::Map::is_empty);
    if !no_properties || root.get("additionalProperties") != Some(&Value::Bool(false)) {
        return;
    }
    let never = format!("{name}Value");
    root.remove("properties");
    root.insert(
        "additionalProperties".to_owned(),
        serde_json::json!({ "$ref": format!("#/definitions/{never}") }),
    );
    let definitions = root
        .entry("definitions")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    if let Value::Object(definitions) = definitions {
        definitions.insert(never, serde_json::json!({ "enum": [], "type": "string" }));
    }
}

fn is_null(schema: &Value) -> bool {
    schema["type"].as_str() == Some("null")
}

fn needs_name(object: &serde_json::Map<String, Value>) -> bool {
    let kind = object.get("type").and_then(Value::as_str);
    let constrained = ["pattern", "minLength", "maxLength", "enum"]
        .iter()
        .any(|key| object.contains_key(*key));
    let union = object.contains_key("oneOf") || object.contains_key("anyOf");
    let structure = kind == Some("object") && object.contains_key("properties");
    union || structure || (kind == Some("string") && constrained)
}

/// Labels a union member by the first `const` property it carries (its
/// discriminant), falling back to its position.
fn member_label(member: &Value, position: usize) -> String {
    member["properties"]
        .as_object()
        .and_then(|properties| {
            properties
                .values()
                .find_map(|property| property["const"].as_str().map(pascal))
        })
        .unwrap_or_else(|| format!("Variant{position}"))
}

fn pascal(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut upper = true;
    for character in text.chars() {
        if character.is_ascii_alphanumeric() {
            if upper {
                out.push(character.to_ascii_uppercase());
            } else {
                out.push(character);
            }
            upper = false;
        } else {
            upper = true;
        }
    }
    out
}

fn module_name(name: &str) -> String {
    let mut module = String::with_capacity(name.len() + 4);
    for (position, character) in name.chars().enumerate() {
        if character.is_ascii_uppercase() {
            if position > 0 {
                module.push('_');
            }
            module.push(character.to_ascii_lowercase());
        } else {
            module.push(character);
        }
    }
    module
}
