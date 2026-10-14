/** The footer row's second line and its glyph tone; the first line is always "Gateway". */
export type GatewayStatus = {
  readonly detail: string;
  readonly tone: "muted" | "danger";
};
