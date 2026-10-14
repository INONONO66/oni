# action plugin

Owns the `action` capability (#1304): the `action` journal kind with its identity reducer, the `action` deliver input, the `action.pre` gate point, and the `ActionPort` (`@openomni/action/Action`) that `Bundle.actionCapability()` publishes.

It does not compose itself and writes no rows: the product manifest composes it next to `Bundle.hookCapability()`, and hook results re-enter the session as `action` rows through the entity deliver path.
