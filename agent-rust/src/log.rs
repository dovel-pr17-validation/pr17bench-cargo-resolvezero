//! Minimal JSON-lines logger with the same shape as the TypeScript agent:
//! `{"time":"…","level":"info","msg":"…", …extra}`.

use serde_json::{json, Map, Value};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

pub fn log(level: &str, msg: &str, extra: Value) {
    let mut record = Map::new();
    record.insert(
        "time".into(),
        Value::String(
            OffsetDateTime::now_utc()
                .format(&Rfc3339)
                .unwrap_or_default(),
        ),
    );
    record.insert("level".into(), Value::String(level.to_string()));
    record.insert("msg".into(), Value::String(msg.to_string()));
    if let Value::Object(extra) = extra {
        for (key, value) in extra {
            record.insert(key, value);
        }
    }
    println!("{}", Value::Object(record));
}

pub fn info(msg: &str, extra: Value) {
    log("info", msg, extra);
}

pub fn warn(msg: &str, extra: Value) {
    log("warn", msg, extra);
}

pub fn error(msg: &str, extra: Value) {
    log("error", msg, extra);
}

pub fn obj(pairs: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in pairs {
        map.insert(key.to_string(), value);
    }
    Value::Object(map)
}

pub fn str_value(value: impl Into<String>) -> Value {
    Value::String(value.into())
}

pub fn json_num(value: impl Into<i64>) -> Value {
    json!(value.into())
}
