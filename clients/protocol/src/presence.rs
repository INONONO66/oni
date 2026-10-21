use serde::{Deserialize, Deserializer};

/// A present nullable field is Some(None); only an absent field defaults to None.
pub(crate) fn some<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}
