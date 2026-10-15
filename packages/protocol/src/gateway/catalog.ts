import { defineCatalog, defineSchema } from "@json-render/core";
import { z } from "zod";

const Id = z.string().min(1);
const Ref = z.string().min(1);
const Style = z.enum(["primary", "danger", "default"]);

const Button = z.union([
  z.object({ label: z.string().min(1), id: Id, style: Style.optional() }).strict(),
  z.object({ label: z.string().min(1), url: z.string().url(), style: Style.optional() }).strict(),
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
const PollProps = z.object({ question: z.string(), options: z.array(z.string()), multi: z.boolean().optional() }).strict();
const StatusProps = z.object({ kind: z.enum(["ok", "warn", "fail", "progress"]), title: z.string(), body: z.string().optional() }).strict();
const ContextProps = z.object({ text: z.string() }).strict();

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
}));

const definitions = {
  Markdown: { props: MarkdownProps, description: "Use for standard markdown: headings, lists, bold, links, and inline code; raw HTML is not supported." },
  Code: { props: CodeProps, description: "Use for source code or other preformatted text; lang names the language for highlighting." },
  Table: { props: TableProps, description: "Use for aligned columns; rows are strings, with one value per column." },
  Image: {
    props: ImageProps,
    description: "Use for visual media. A ref is an /absolute path on the attached machine (machineId:/path) or an https URL; the channel uploads it where it can.",
  },
  File: {
    props: FileProps,
    description: "Use to offer a downloadable file. A ref is an /absolute path on the attached machine (machineId:/path) or an https URL; the channel uploads it where it can.",
  },
  Buttons: { props: EmptyProps, description: "Use for a short set of choices; children are Button elements, at most 5." },
  Button: {
    props: Button,
    description: "Use inside Buttons. Provide exactly one of id (a postback the person can tap; you receive it back as their reply) or url (opens a link).",
  },
  Card: { props: CardProps, description: "Use to group a title, optional image, and optional body as one compact item." },
  Carousel: { props: EmptyProps, description: "Use for 2–10 related Card elements; children are Card elements." },
  Poll: { props: PollProps, description: "Use when the person should choose from options; set multi for multiple selections." },
  Status: { props: StatusProps, description: "Use for progress or outcomes; kind progress means ongoing work, while ok, warn, and fail mean outcomes." },
  Divider: { props: EmptyProps, description: "Use to separate adjacent sections." },
  Context: { props: ContextProps, description: "Use for brief secondary context that supports the main message." },
} as const;

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
export type SpecValue = { root: string; elements: Record<string, Element> };

function hasExpression(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasExpression);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) => key.startsWith("$") || hasExpression(nested));
}

// The library's catalog schema returns an untyped Zod schema for dynamic catalog props.
export const Spec = (Catalog.zodSchema() as z.ZodType<SpecValue>).superRefine((spec, ctx) => {
  if (!(spec.root in spec.elements)) {
    ctx.addIssue({ code: "custom", path: ["root"], message: "root element is missing" });
  }
  for (const [id, element] of Object.entries(spec.elements)) {
    if (hasExpression(element.props)) {
      ctx.addIssue({ code: "custom", path: ["elements", id, "props"], message: "chat specs carry no client state" });
    }
    for (const [index, child] of element.children.entries()) {
      if (!(child in spec.elements)) {
        ctx.addIssue({ code: "custom", path: ["elements", id, "children", index], message: "dangling child id" });
      }
    }
    if (element.type === "Buttons" && element.children.length > 5) {
      ctx.addIssue({ code: "custom", path: ["elements", id, "children"], message: "Buttons may contain at most 5 children" });
    }
    if (element.type === "Carousel" && (element.children.length < 2 || element.children.length > 10)) {
      ctx.addIssue({ code: "custom", path: ["elements", id, "children"], message: "Carousel must contain 2 to 10 children" });
    }
  }
});
export type Spec = z.infer<typeof Spec>;
