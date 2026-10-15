import type { Bundle } from "@openomni/agent";
import { Context } from "effect";
import type { MonitorPorts } from "../bundles/alarms/monitor/ports";
import type { ToolPorts } from "./catalog";

/**
 * The late-bound live alarm ports the monitor bundle's ONE tool declaration
 * executes against (#1308): the manifest closes over `current` at compose
 * time; boot calls `bind` once the runtime exists. Unbound calls are the
 * monitor tool's typed refusal, never a silent fallback.
 */
export interface AlarmPortsSlot {
  readonly current: () => MonitorPorts | undefined;
  readonly bind: (ports: MonitorPorts) => void;
}

export function alarmPortsSlot(): AlarmPortsSlot {
  let ports: MonitorPorts | undefined;
  return {
    current: () => ports,
    bind: (next) => {
      ports = next;
    },
  };
}

/**
 * The late-bound live tool ports every tool bundle executes against (#1561),
 * the same door as the alarm slot: boot binds once the runtime exists, and
 * `bind` hands the ports back so the binding site can pass them on.
 */
export interface ToolPortsSlot {
  readonly current: () => ToolPorts | undefined;
  readonly bind: (ports: ToolPorts) => ToolPorts;
}

export function toolPortsSlot(): ToolPortsSlot {
  let ports: ToolPorts | undefined;
  return {
    current: () => ports,
    bind: (next) => {
      ports = next;
      return next;
    },
  };
}

/**
 * The composed-generation seam (#1255 P3): boot runs `config → manifest →
 * compose → runtime` and hands the result here; everything downstream
 * (generation Layers, ingress materialization, resident faces, provisioning
 * recompose in P4) reads the CURRENT composition through this one service.
 * The holder is late-swappable: `provision{bundle_enable|bundle_disable}`
 * recomposes from empty state and replaces `current()`'s value — sessions
 * adopt at their next turn start (core rotation, #1255 S3).
 */
export interface ComposedContext {
  /** The manifest the generation was composed from (rollback = recompose with it). */
  readonly manifest: Bundle.ManifestDefinition;
  /** The compiled generation: one journaled table set, never patched in place. */
  readonly generation: Bundle.Generation;
}

/** The swappable composition cell: `swap` is `provision{bundle_*}`'s recompose commit (#1255 P4). */
export interface ComposedHolder {
  readonly current: () => ComposedContext;
  readonly swap: (next: ComposedContext) => void;
  /** The monitor ports door (#1308): the slot the manifest's monitor bundle closed over. */
  readonly alarms: AlarmPortsSlot;
  /** The tool ports door (#1561): the slot every tool bundle closed over. */
  readonly tools: ToolPortsSlot;
}

export function composedHolderOf(
  initial: ComposedContext,
  alarms: AlarmPortsSlot,
  tools: ToolPortsSlot = toolPortsSlot(),
): ComposedHolder {
  let current = initial;
  return {
    current: () => current,
    swap: (next) => {
      current = next;
    },
    alarms,
    tools,
  };
}

export class ComposedGeneration extends Context.Service<
  ComposedGeneration,
  ComposedHolder
>()("@openomni/openomni/ComposedGeneration") {}
