//! Generates Rust types for every machine wire schema listed in
//! `packages/protocol/schema/machine/index.json`.
//!
//! Each schema file is converted in its own `TypeSpace` and lands in its own
//! module, because every file carries its own `definitions` namespace and the
//! same local definition name can mean different shapes in different files.
//! The root type is named after the index entry and re-exported at the crate
//! root.
//!
//! Generated shapes preserve field presence; embedded validators enforce the
//! original schemas at the decode boundary.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use syn::{parse_quote, punctuated::Punctuated, Meta, Token, Type};
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
        let code = generate(&entry.name, read_json(&path), &path);
        fs::write(out_dir.join(format!("{module}.rs")), code).expect("write generated module");
        root.push_str(&format!(
            "/// Types generated from `{file}`.\n\
             // build.rs proves every pattern with regress before emitting runtime unwraps.\n\
             #[allow(clippy::unwrap_used)]\n\
             pub mod {module} {{\n\
                 include!(concat!(env!(\"OUT_DIR\"), \"/{module}.rs\"));\n\
                 static VALIDATOR: std::sync::LazyLock<jsonschema::Validator> =\n\
                     std::sync::LazyLock::new(|| {{\n\
                         let schema = serde_json::from_str(include_str!(concat!(\n\
                             env!(\"CARGO_MANIFEST_DIR\"), \"/{SCHEMA_DIR}/{file}\"\n\
                         ))).expect(\"embedded schema JSON\");\n\
                         jsonschema::draft7::new(&schema).expect(\"embedded draft-07 schema\")\n\
                     }});\n\
                 impl crate::WireRoot for {name} {{\n\
                     fn validator() -> &'static jsonschema::Validator {{ &VALIDATOR }}\n\
                 }}\n\
             }}\n\
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
fn generate(name: &str, mut schema: Value, path: &Path) -> String {
    name_variant_members(&mut schema, name, false);
    let mut settings = TypeSpaceSettings::default();
    prove_schema(&schema, path, &mut settings);
    let root = schema
        .as_object_mut()
        .unwrap_or_else(|| panic!("{name}: schema document is an object"));
    root.insert("title".to_owned(), Value::String(name.to_owned()));
    let root = serde_json::from_value(schema)
        .unwrap_or_else(|error| panic!("{name}: not a draft-07 root schema: {error}"));
    let mut space = TypeSpace::new(&settings);
    space
        .add_root_schema(root)
        .unwrap_or_else(|error| panic!("{name}: typify refused the schema: {error}"))
        .unwrap_or_else(|| panic!("{name}: typify produced no root type"));
    let mut module = syn::parse2::<syn::File>(space.to_stream()).expect("generated Rust module");
    derive_enum_defaults(&mut module);
    for item in &mut module.items {
        match item {
            syn::Item::Struct(item) => preserve_presence(&mut item.fields),
            syn::Item::Enum(item) => {
                for variant in &mut item.variants {
                    preserve_presence(&mut variant.fields);
                }
            }
            _ => {}
        }
    }
    prettyplease::unparse(&module)
}

fn derive_enum_defaults(module: &mut syn::File) {
    let defaults: Vec<_> = module
        .items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let syn::Item::Impl(item) = item else {
                return None;
            };
            let (_, trait_path, _) = item.trait_.as_ref()?;
            if trait_path.segments.last()?.ident != "Default" {
                return None;
            }
            let syn::Type::Path(ty) = &*item.self_ty else {
                return None;
            };
            let [syn::ImplItem::Fn(method)] = item.items.as_slice() else {
                return None;
            };
            let [syn::Stmt::Expr(syn::Expr::Path(value), None)] = method.block.stmts.as_slice()
            else {
                return None;
            };
            Some((
                index,
                ty.path.segments.last()?.ident.clone(),
                value.path.segments.last()?.ident.clone(),
            ))
        })
        .collect();
    for (_, name, variant) in &defaults {
        for item in &mut module.items {
            if let syn::Item::Enum(item) = item {
                if item.ident == *name {
                    item.attrs.push(parse_quote!(#[derive(Default)]));
                    for value in &mut item.variants {
                        if value.ident == *variant {
                            value.attrs.push(parse_quote!(#[default]));
                        }
                    }
                }
            }
        }
    }
    for (index, _, _) in defaults.into_iter().rev() {
        module.items.remove(index);
    }
}

/// Patterns are immutable build inputs. Number shapes retain the JSON number
/// representation instead of rounding integers or changing them into floats.
fn prove_schema(schema: &Value, path: &Path, settings: &mut TypeSpaceSettings) {
    match schema {
        Value::Object(object) => {
            if let Some(pattern) = object.get("pattern").and_then(Value::as_str) {
                regress::Regex::new(pattern).unwrap_or_else(|error| {
                    panic!("{}: pattern {pattern:?}: {error}", path.display())
                });
            }
            if object.get("type").and_then(Value::as_str) == Some("number") {
                settings.with_conversion(
                    serde_json::from_value(schema.clone()).expect("number schema"),
                    "::serde_json::Number",
                    std::iter::empty(),
                );
            }
            for child in object.values() {
                prove_schema(child, path, settings);
            }
        }
        Value::Array(children) => {
            for child in children {
                prove_schema(child, path, settings);
            }
        }
        _ => {}
    }
}

/// Current nullable optional properties are unrestricted JSON (`{}`), emitted
/// as Option<Value>. No optional typed-null union or BTreeMap occurs.
fn preserve_presence(fields: &mut syn::Fields) {
    for field in fields {
        let ty = &field.ty;
        let nullable = matches!(ty, Type::Path(outer)
            if outer.path.segments.last().is_some_and(|segment|
                segment.ident == "Option" && matches!(&segment.arguments,
                    syn::PathArguments::AngleBracketed(args)
                    if matches!(args.args.first(), Some(syn::GenericArgument::Type(Type::Path(inner)))
                        if inner.path.segments.iter().map(|part| part.ident.to_string())
                            .eq(["serde_json", "Value"])))));
        let mut rewritten = false;
        for attribute in &mut field.attrs {
            if !attribute.path().is_ident("serde") {
                continue;
            }
            let arguments = attribute
                .parse_args_with(Punctuated::<Meta, Token![,]>::parse_terminated)
                .expect("generated serde attributes");
            let optional = arguments.iter().any(|meta| meta.path().is_ident("default"));
            let collection = matches!(ty, Type::Path(path)
                if path.path.segments.last().is_some_and(|segment|
                    segment.ident == "Vec" || segment.ident == "HashMap"));
            if !(nullable && skips(&arguments, "::is_none")
                || collection && optional && skips(&arguments, "::is_empty"))
            {
                continue;
            }
            let kept: Punctuated<Meta, Token![,]> = arguments
                .into_iter()
                .filter(|meta| {
                    !meta.path().is_ident("default") && !meta.path().is_ident("skip_serializing_if")
                })
                .collect();
            *attribute = parse_quote!(#[serde(#kept)]);
            rewritten = true;
        }
        if rewritten {
            field.ty = parse_quote!(::std::option::Option<#ty>);
            field.attrs.push(parse_quote!(
                #[serde(default, skip_serializing_if = "Option::is_none")]
            ));
            if nullable {
                field.attrs.push(parse_quote!(
                    #[serde(deserialize_with = "crate::presence::some")]
                ));
            }
        }
    }
}

fn skips(arguments: &Punctuated<Meta, Token![,]>, suffix: &str) -> bool {
    arguments.iter().any(|meta| {
        matches!(meta,
            Meta::NameValue(value) if value.path.is_ident("skip_serializing_if")
                && matches!(&value.value, syn::Expr::Lit(literal)
                    if matches!(&literal.lit, syn::Lit::Str(text)
                        if text.value().ends_with(suffix))))
    })
}

/// typify cannot name a struct, a nested union, a constrained string or a
/// string enum that sits below a `oneOf`/`anyOf` member (the member itself
/// becomes an enum variant and has no type name to derive from), and panics
/// instead. This pass gives every
/// such schema a `title` built from its path, the same way typify names
/// property types elsewhere: parent name, then the property name, `Item` for
/// array items, `Value` for map values, and the member's discriminant for a
/// union member. It also rewrites `const` as a one-value `enum`. The original
/// schema remains the authority used by the decode validator.
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
