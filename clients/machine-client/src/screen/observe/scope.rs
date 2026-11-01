use super::*;
use ax::scoped::{Scope as WalkScope, ScopedWalk};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Scope {
    pub root: Option<String>,
    pub max_depth: Option<usize>,
    pub matching: Option<Matching>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Matching {
    pub role: Option<String>,
    pub label: Option<String>,
}

impl Scope {
    pub(super) fn scoped(&self) -> bool {
        self != &Self::default()
    }

    pub(super) fn walk(
        &self,
        observer: &dyn Observer,
        located: &Located,
        bounds: &Bounds,
    ) -> Result<ScopedWalk, Refusal> {
        if !self.scoped() {
            let walk = observer.walk(&located.window, bounds)?;
            let included = vec![true; walk.nodes.len()];
            return Ok(ScopedWalk { walk, included });
        }
        let scope = WalkScope {
            root: match &self.root {
                Some(root) => ax::segments(root).ok_or(Refusal::RefNotFound)?,
                None => Vec::new(),
            },
            max_depth: self.max_depth,
        };
        Ok(observer.walk_scoped(&located.window, bounds, &scope)?)
    }

    pub(super) fn mint(&self, mut walked: ScopedWalk, max_elements: usize) -> Minted {
        let included = walked.included;
        let mut emitted = included.clone();
        let mut addressed = emitted.clone();
        if let Some(matching) = &self.matching {
            for (at, node) in walked.walk.nodes.iter().enumerate() {
                addressed[at] = emitted[at]
                    && matching
                        .role
                        .as_ref()
                        .is_none_or(|role| node.attributes.role == *role)
                    && matching.label.as_ref().is_none_or(|label| {
                        node.attributes
                            .label
                            .as_ref()
                            .is_some_and(|text| text.to_lowercase().contains(label))
                    });
            }
            emitted.clone_from(&addressed);
            for at in (0..emitted.len()).rev() {
                if emitted[at] {
                    if let Some(parent) = walked.walk.nodes[at].parent {
                        // Prefix proof nodes remain hidden outside the requested root.
                        emitted[parent] = included[parent];
                    }
                }
            }
        }
        let mut count = 0;
        for included in &mut emitted {
            if *included {
                count += 1;
                if count > max_elements {
                    *included = false;
                    walked.walk.complete = false;
                }
            }
        }
        mint_selected(walked.walk, &emitted, &addressed)
    }
}
