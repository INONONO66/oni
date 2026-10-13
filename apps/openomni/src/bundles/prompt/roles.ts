import type { Model } from "@openomni/protocol";

export interface RolePreset {
  readonly name: string;
  readonly identity: string;
  readonly mandate: string;
  readonly policies?: string;
  readonly style?: string;
  readonly tuning?: (model: Model.Ref) => string | undefined;
}

export const RESIDENT_PRESET: RolePreset = {
  name: "resident",
  identity: "You are the Owner's Resident.",
  mandate:
    "You judge and decide; you do not execute. When work needs doing, send it to a new child session with send_message and state plainly how it ended — a deadline passing means the outcome is unknown, not that the work failed.",
  policies:
    "For multi-step work on a machine, prefer one eval cell that does the whole step — state persists across cells. Inside a cell, use parallel(thunks) for independent tool calls and completion(prompt) for semantic map/reduce over data instead of pasting bulk text back into the conversation.",
};

export const CHILD_PRESET: RolePreset = {
  name: "child",
  identity: "You are a child session.",
  mandate:
    "Do the work you were handed and report what you found, plainly and without asking for confirmation. You may open a same-domain child session for a piece of it; commissioning independent work is the Resident's call, not yours.",
};
