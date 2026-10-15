import { defineCatalog, defineSchema, type PromptContext } from "@json-render/core";
import { z } from "zod";

const Id = z.string().min(1);
const Ref = z.string().min(1);
const Style = z.enum(["primary", "danger", "default"]);

const Button = z.union([
  z.object({ label: z.string().min(1), id: Id, style: Style.optional() }).strict(),
  z.object({ label: z.string().min(1), url: z.url({ protocol: /^https?$/ }), style: Style.optional() }).strict(),
]);
const MarkdownProps = z.object({ text: z.string() }).strict();
const CodeProps = z.object({ text: z.string(), lang: Id.optional() }).strict();
const TableProps = z
  .object({
    columns: z.array(z.object({ header: z.string(), align: z.enum(["left", "center", "right"]).optional() }).strict()),
    rows: z.array(z.array(z.string())),
  })
  .strict();
const ImageProps = z.object({ ref: Ref, caption: z.string().optional() }).strict();
const FileProps = z.object({ ref: Ref, name: Id, mime: Id.optional() }).strict();
const EmptyProps = z.object({}).strict();
const CardProps = z.object({ title: z.string(), image: Ref.optional(), body: z.string().optional() }).strict();
const PollProps = z
  .object({ question: z.string(), options: z.array(z.string()).min(2).max(10), multi: z.boolean().optional() })
  .strict();
const StatusProps = z.object({ kind: z.enum(["ok", "warn", "fail", "progress"]), title: z.string(), body: z.string().optional() }).strict();
const ContextProps = z.object({ text: z.string() }).strict();
const StackProps = z.object({}).strict();
type JsonValue = z.infer<ReturnType<typeof z.json>>;

const definitions = {
  Stack: { props: StackProps, description: "The message body: an ordered sequence of sections. Use as root whenever the message has more than one element." },
  Markdown: { props: MarkdownProps, description: "Use for standard markdown: headings, lists, bold, links, and inline code; raw HTML is not supported." },
  Code: { props: CodeProps, description: "Use for source code or other preformatted text; lang names the language for highlighting." },
  Table: { props: TableProps, description: "Use for aligned columns; every row carries exactly one value per column." },
  Image: {
    props: ImageProps,
    description: "Use for visual media. A ref is an /absolute path on the attached machine (machineId:/path) or an https URL; the channel uploads it where it can.",
  },
  File: {
    props: FileProps,
    description: "Use to offer a downloadable file. A ref is an /absolute path on the attached machine (machineId:/path) or an https URL; the channel uploads it where it can.",
  },
  Buttons: { props: EmptyProps, description: "Use for a short set of choices; children are 1 to 5 Button elements." },
  Button: {
    props: Button,
    description: "Use inside Buttons. Provide exactly one of id (a postback the person can tap; you receive it back as their reply) or url (opens a link).",
  },
  Card: { props: CardProps, description: "Use to group a title, optional image, and optional body as one compact item; it may contain one Buttons child." },
  Carousel: { props: EmptyProps, description: "Use for 2–10 related Card elements; children are Card elements." },
  Poll: { props: PollProps, description: "Use when the person should choose from 2 to 10 options; set multi for multiple selections." },
  Status: { props: StatusProps, description: "Use for progress or outcomes; kind progress means ongoing work, while ok, warn, and fail mean outcomes." },
  Divider: { props: EmptyProps, description: "Use to separate adjacent sections." },
  Context: { props: ContextProps, description: "Use for brief secondary context that supports the main message." },
} as const;

const promptTemplate = ({ catalog, formatZodType }: PromptContext) => {
  const components = catalog as { components: Record<string, { props: z.ZodType; description: string }> };
  const componentLines = Object.entries(components.components)
    .map(([name, definition]) => `- ${name}: ${formatZodType(definition.props)} — ${definition.description}`)
    .join("\n");
  return [
    "A structured message is one JSON value `{ root, elements }` passed as `send_message.message`. `elements` maps ids to `{ type, props, children }`; `root` names the first element; `children` lists element ids in order. Specs are static: no client state, expressions, or dynamic fields (the tool rejects them). Use plain markdown text when none of these elements adds anything.",
    componentLines,
    'A Button with `id` arrives back as the person\'s reply: `{ kind: "postback", id, label }`.',
    "The spec is one tree: every element hangs off `root` exactly once, with no shared, orphaned, or missing ids, and an element that holds nothing carries `children: []`. A Stack needs at least one child, Buttons 1 to 5 Button children, and Carousel 2 to 10 Card children; a Button is never the root.",
    'Example: {"root":"body","elements":{"body":{"type":"Stack","props":{},"children":["intro","data","choices"]},"intro":{"type":"Markdown","props":{"text":"## Results"},"children":[]},"data":{"type":"Table","props":{"columns":[{"header":"Name"}],"rows":[["Ada"]]},"children":[]},"choices":{"type":"Buttons","props":{},"children":["continue"]},"continue":{"type":"Button","props":{"label":"Continue","id":"continue"},"children":[]}}}',
  ].join("\n\n");
};

const schema = defineSchema((s) => ({
  spec: s.object({
    root: s.string(),
    elements: s.record(
      s.object({
        type: s.ref("catalog.components"),
        props: s.propsOf("catalog.components"),
        children: s.array(s.string()),
      }),
    ),
  }),
  catalog: s.object({
    components: s.map({
      props: s.zod(),
      description: s.string(),
    }),
    actions: s.map({
      description: s.string(),
    }),
  }),
}), { promptTemplate });

export const Catalog = defineCatalog(schema, {
  components: definitions,
  actions: {
    postback: { description: "Send a button postback." },
  },
});

export type ElementType = keyof typeof Catalog["data"]["components"];
type ElementOf<T extends ElementType, P> = { type: T; props: P; children: string[] };
export type Element = {
  [K in keyof typeof definitions]: ElementOf<K, z.infer<(typeof definitions)[K]["props"]>>;
}[keyof typeof definitions];
export type Spec = { root: string; elements: Record<string, Element> };

const SPEC_FIELDS = new Set(["root", "elements"]);
const ELEMENT_FIELDS = new Set(["type", "props", "children"]);

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasClientStateField(value: JsonValue | undefined): boolean {
  if (Array.isArray(value)) return value.some(hasClientStateField);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, nested]) => key === "visible" || key === "watch" || key.startsWith("$") || hasClientStateField(nested),
  );
}

type Issue = { path: (string | number)[]; message: string };

/** What only the raw input shows: fields the catalog schema would drop, and client state inside props. Element ids are names, so they are never read as fields. */
function rawIssues(input: JsonValue): Issue[] {
  if (!isRecord(input)) return [];
  const issues: Issue[] = Object.keys(input)
    .filter((key) => !SPEC_FIELDS.has(key))
    .map((key) => ({ path: [key], message: "unknown spec field" }));
  const elements = input.elements;
  if (!isRecord(elements)) return issues;
  for (const [id, element] of Object.entries(elements)) {
    if (!isRecord(element)) continue;
    for (const key of Object.keys(element)) {
      if (!ELEMENT_FIELDS.has(key)) issues.push({ path: ["elements", id, key], message: "unknown element field" });
    }
    if (hasClientStateField(element.props)) {
      issues.push({ path: ["elements", id, "props"], message: "chat specs carry no client state" });
    }
  }
  return issues;
}

function childCountIssue(type: ElementType, count: number): string | undefined {
  if (type === "Stack") return count === 0 ? "Stack must contain at least one child" : undefined;
  if (type === "Buttons") {
    if (count === 0) return "Buttons must contain at least one child";
    return count > 5 ? "Buttons may contain at most 5 children" : undefined;
  }
  if (type === "Card") return count > 1 ? "Card may contain at most one Buttons child" : undefined;
  if (type === "Carousel") return count < 2 || count > 10 ? "Carousel must contain 2 to 10 children" : undefined;
  return count > 0 ? "this element cannot have children" : undefined;
}

function nestingIssue(parent: ElementType, child: ElementType | undefined): string | undefined {
  if (parent === "Buttons" && child !== undefined && child !== "Button") return "Buttons children must be Button elements";
  if (parent === "Card" && child !== undefined && child !== "Buttons") return "Card children must be Buttons elements";
  if (parent === "Carousel" && child !== undefined && child !== "Card") return "Carousel children must be Card elements";
  if (parent !== "Buttons" && child === "Button") return "Button must be a child of Buttons";
  return undefined;
}

/** A table reads as columns, so every row carries one value per column. */
function tableIssue(element: Element): Issue[] {
  if (element.type !== "Table") return [];
  const width = element.props.columns.length;
  const ragged = element.props.rows.findIndex((row) => row.length !== width);
  return ragged === -1 ? [] : [{ path: ["props", "rows", ragged], message: "a table row carries one value per column" }];
}

function elementIssues(id: string, element: Element, elements: Record<string, Element>, ids: Set<string>): Issue[] {
  const issues: Issue[] = tableIssue(element).map((issue) => ({ ...issue, path: ["elements", id, ...issue.path] }));
  if (!definitions[element.type].props.safeParse(element.props).success) {
    issues.push({ path: ["elements", id, "props"], message: "invalid catalog props" });
  }
  for (const [index, child] of element.children.entries()) {
    if (!ids.has(child)) issues.push({ path: ["elements", id, "children", index], message: "dangling child id" });
    const nesting = nestingIssue(element.type, elements[child]?.type);
    if (nesting !== undefined) issues.push({ path: ["elements", id, "children", index], message: nesting });
  }
  const count = childCountIssue(element.type, element.children.length);
  if (count !== undefined) issues.push({ path: ["elements", id, "children"], message: count });
  return issues;
}

/** Every element hangs off the root exactly once: no orphans, no sharing, no cycles. */
function treeIssues(spec: Spec): Issue[] {
  const root = spec.elements[spec.root];
  if (root === undefined) return [{ path: ["root"], message: "root element is missing" }];
  const issues: Issue[] = root.type === "Button" ? [{ path: ["root"], message: "Button must be a child of Buttons" }] : [];
  const reached = new Set<string>([spec.root]);
  const pending: string[] = [spec.root];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    for (const child of spec.elements[id]?.children ?? []) {
      if (reached.has(child)) {
        issues.push({ path: ["elements", id, "children"], message: "element is referenced more than once" });
        continue;
      }
      reached.add(child);
      pending.push(child);
    }
  }
  for (const id of Object.keys(spec.elements)) {
    if (!reached.has(id)) issues.push({ path: ["elements", id], message: "element is not reachable from root" });
  }
  return issues;
}

// The library's catalog schema returns an untyped Zod schema for dynamic catalog props.
const SpecBody = (Catalog.zodSchema() as z.ZodType<Spec>).superRefine((spec, ctx) => {
  const ids = new Set(Object.keys(spec.elements));
  const issues = [
    ...treeIssues(spec),
    ...Object.entries(spec.elements).flatMap(([id, element]) => elementIssues(id, element, spec.elements, ids)),
  ];
  for (const issue of issues) ctx.addIssue({ code: "custom", ...issue });
});
export const Spec = z.preprocess((input: JsonValue, ctx) => {
  for (const issue of rawIssues(input)) ctx.addIssue({ code: "custom", ...issue });
  return input;
}, SpecBody) as z.ZodType<Spec>;
