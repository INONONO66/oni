//! A scoped walk retains prefix siblings as census evidence, never their
//! descendants. Only the selected subtree contributes emitted elements.
use std::{collections::HashMap, time::Instant};

use super::{transparent, Bounds, Node, Segment, Tree, Walk};
use crate::screen::Fault;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Scope {
    pub root: Vec<Segment>,
    pub max_depth: Option<usize>,
}

pub struct ScopedWalk {
    pub walk: Walk,
    pub included: Vec<bool>,
}

pub fn walk<T: Tree>(
    tree: &T,
    roots: Vec<T::Item>,
    bounds: &Bounds,
    scope: &Scope,
) -> Result<ScopedWalk, Fault> {
    let deadline = Instant::now() + bounds.budget;
    let mut pending: Vec<_> = roots
        .into_iter()
        .rev()
        .map(|item| (item, None, 0))
        .collect();
    let mut walk = Walk {
        nodes: Vec::new(),
        focused: None,
        complete: true,
    };
    let mut included = Vec::new();
    let mut prefixes: Vec<Option<usize>> = Vec::new();
    let mut counts = HashMap::new();
    let mut emitted = 0;
    while let Some((item, parent, depth)) = pending.pop() {
        if walk.nodes.len() == bounds.max_visits || Instant::now() >= deadline {
            walk.complete = false;
            break;
        }
        let (mut attributes, children) = tree.read(&item)?;
        let role = super::slug(&attributes.role);
        let count = counts.entry((parent, role.clone())).or_insert(0);
        let segment = Segment {
            role,
            index: *count,
        };
        *count += 1;
        let prefix = parent
            .map_or(Some(0), |at: usize| prefixes[at])
            .and_then(|at| {
                if at == scope.root.len() {
                    Some(at)
                } else {
                    (scope.root[at] == segment).then_some(at + 1)
                }
            });
        let visible = prefix == Some(scope.root.len());
        if visible && emitted == bounds.max_elements {
            walk.complete = false;
            break;
        }
        let depth = if visible {
            depth + usize::from(!transparent(&attributes))
        } else {
            0
        };
        let descend =
            prefix.is_some() && (!visible || scope.max_depth.is_none_or(|limit| depth < limit));
        if visible {
            emitted += 1;
            if !descend && !children.is_empty() {
                attributes.children_cut = Some(children.len());
            }
            if attributes.focused {
                walk.focused = Some(walk.nodes.len());
            }
        }
        let index = walk.nodes.len();
        walk.nodes.push(Node { attributes, parent });
        prefixes.push(prefix);
        included.push(visible);
        if descend {
            pending.extend(
                children
                    .into_iter()
                    .rev()
                    .map(|child| (child, Some(index), depth)),
            );
        }
    }
    Ok(ScopedWalk { walk, included })
}
