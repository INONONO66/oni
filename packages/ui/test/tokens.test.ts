import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type Oklch, ratio } from "./contrast";

/**
 * The token file is the design system's source of truth, so its invariants are
 * asserted against the CSS text rather than trusted to review. A ramp that
 * silently loses a step, or a theme whose `faint` tone is unreadable, is a
 * defect the compiler cannot see and a screenshot only sometimes shows.
 */
const CSS = await Bun.file(join(import.meta.dir, "..", "src", "styles.css")).text();

/** Lightness of a `--color-neutral-*` step, in percent. */
const RAMP = new Map(
  [...CSS.matchAll(/--color-neutral-(\d+):\s*oklch\(([\d.]+)%\s+([\d.]+)\s+/g)].map((hit) => [
    Number(hit[1]),
    { lightness: Number(hit[2]), chroma: Number(hit[3]) },
  ]),
);

/** The `:root[data-theme="light"]` block, isolated from the dark defaults. */
const LIGHT = CSS.slice(CSS.indexOf('[data-theme="light"]'));
const DARK = CSS.slice(0, CSS.indexOf('[data-theme="light"]'));

function ramp(block: string, token: string): number {
  const step = block.match(new RegExp(`${token}:\\s*var\\(--color-neutral-(\\d+)\\)`))?.[1];
  if (step === undefined) throw new Error(`${token} does not resolve to a ramp step`);
  const entry = RAMP.get(Number(step));
  if (!entry) throw new Error(`--color-neutral-${step} is not defined`);
  return entry.lightness;
}

/** The oklch triple a semantic token resolves to, via the ramp. */
function color(block: string, token: string): Oklch {
  return { lightness: ramp(block, token) / 100, chroma: 0, hue: 0 };
}

/** A token declared as a literal oklch triple, rather than via the ramp. */
function literal(block: string, token: string): Oklch {
  const hit = block.match(
    new RegExp(`${token}:\\s*oklch\\(([\\d.]+)%\\s+([\\d.]+)\\s+([\\d.]+)\\)`),
  );
  if (!hit) throw new Error(`${token} is not an oklch literal`);
  return {
    lightness: Number(hit[1]) / 100,
    chroma: Number(hit[2]),
    hue: Number(hit[3]),
  };
}

/** The theme's literal accent declaration, which names oklch directly. */
function accent(block: string): Oklch {
  return literal(block, "--color-accent");
}

const THEMES = [
  { name: "dark", block: DARK, backgroundIsDark: true },
  { name: "light", block: LIGHT, backgroundIsDark: false },
] as const;

/**
 * The three surfaces a piece of text can land on. Every tone is measured
 * against ALL of them, not just `bg`: the sidebar is `sunken`, a selected row
 * and a code fence are `raised`, and a tone that clears the floor on the window
 * but not on the row is a tone that fails exactly where the Owner is looking.
 */
const SURFACES = ["--color-bg", "--color-sunken", "--color-raised"] as const;

/**
 * WCAG floors. `fg`/`muted`/`subtle` carry meaning and take 4.5:1. `faint` is
 * the ambient tier — timestamps, durations, reason lines, syntax punctuation —
 * and takes 3:1: quiet by design, but never below the point where it stops
 * being a tone and becomes a missing one.
 */
const FLOORS = [
  { token: "--color-fg", floor: 4.5 },
  { token: "--color-fg-muted", floor: 4.5 },
  { token: "--color-fg-subtle", floor: 4.5 },
  { token: "--color-fg-faint", floor: 3 },
] as const;

describe("the neutral ramp", () => {
  test("Given the ramp, When parsed, Then every step is fully achromatic", () => {
    // One chromatic value exists in this system and it is the accent. A neutral
    // with chroma would tint every surface built on it.
    expect(RAMP.size).toBeGreaterThan(8);
    for (const [step, { chroma }] of RAMP) {
      expect(chroma, `--color-neutral-${step}`).toBe(0);
    }
  });

  test("Given the ramp, When ordered by name, Then lightness increases monotonically", () => {
    const steps = [...RAMP.keys()].sort((a, b) => a - b);
    const lightness = steps.map((step) => RAMP.get(step)?.lightness ?? -1);

    expect(lightness).toEqual([...lightness].sort((a, b) => a - b));
  });

  test("Given the ramp, When each step is traced, Then a semantic token claims it", () => {
    // A step nothing claims is a spare palette entry, and a spare palette entry
    // is how the deleted palette comes back. It is also invisible on screen,
    // because Tailwind never emits an unreferenced theme color.
    const claimed = new Set(
      [...CSS.matchAll(/var\(--color-neutral-(\d+)\)/g)].map((hit) => Number(hit[1])),
    );

    expect([...RAMP.keys()].filter((step) => !claimed.has(step))).toEqual([]);
  });
});

describe("both themes stay readable", () => {
  test("Given each theme, When the text ramp is read, Then it recedes from fg toward the surface", () => {
    for (const theme of THEMES) {
      const steps = ["--color-fg", "--color-fg-muted", "--color-fg-subtle", "--color-fg-faint"].map(
        (token) => ramp(theme.block, token),
      );

      // In dark the ramp descends toward the background; in light it ascends.
      // Either way `faint` must be the closest step to the surface and `fg` the
      // furthest, or the hierarchy is not a hierarchy.
      const expected = theme.backgroundIsDark
        ? [...steps].sort((a, b) => b - a)
        : [...steps].sort((a, b) => a - b);
      expect(steps, theme.name).toEqual(expected);
    }
  });

  test("Given each theme, When every text tone meets every surface, Then it clears its WCAG floor", () => {
    // The measured matrix, not a lightness-delta proxy: 4 tones x 3 surfaces x
    // 2 themes. This is the assertion the previous light theme would have
    // failed — its `faint` resolved to 1.15:1 on white and every reason line in
    // the sidebar vanished, with all other gates green.
    const failures: string[] = [];

    for (const theme of THEMES) {
      for (const { token, floor } of FLOORS) {
        for (const surface of SURFACES) {
          const measured = ratio(color(theme.block, token), color(theme.block, surface));
          if (measured < floor) {
            failures.push(`${theme.name} ${token} on ${surface}: ${measured} < ${floor}`);
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  test("Given each theme, When the accent is read as text, Then it clears 4.5:1 on every surface", () => {
    // `running` is the one word in the system allowed to be chromatic, and it
    // is rendered on all three surfaces — including a SELECTED sidebar row,
    // which is the tightest of the three. The light accent is #007AFF darkened
    // in oklch precisely because the original failed here.
    const failures: string[] = [];

    for (const theme of THEMES) {
      for (const surface of SURFACES) {
        const measured = ratio(accent(theme.block), color(theme.block, surface));
        if (measured < 4.5) {
          failures.push(`${theme.name} accent on ${surface}: ${measured} < 4.5`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  test("Given each theme, When the accent is read as a fill, Then its own text clears 4.5:1", () => {
    // The primary button is the accent AS FILL. One accent token cannot be both
    // light enough to read as text on a dark surface and dark enough to carry
    // white text, so `--color-accent-fg` is what differs per theme: black on
    // dark's accent, white on light's.
    for (const theme of THEMES) {
      const measured = ratio(accent(theme.block), color(theme.block, "--color-accent-fg"));

      expect(measured, `${theme.name} accent-fg on accent`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("Given each theme, When the surfaces are compared, Then all three are distinct and quiet", () => {
    for (const theme of THEMES) {
      const surfaces = SURFACES.map((token) => ramp(theme.block, token));

      // `sunken` separates the columns without a border and `raised` carries
      // the selected row. Either collapsing into `bg` loses a signal the system
      // has no second way to express.
      expect(new Set(surfaces).size, theme.name).toBe(3);

      // ...and each step must stay QUIET. A surface more than 1.4:1 from the
      // window reads as a filled box rather than a change in elevation, which
      // is how the light theme's selected row and code fences turned grey.
      const background = color(theme.block, "--color-bg");
      for (const token of ["--color-sunken", "--color-raised"] as const) {
        const measured = ratio(color(theme.block, token), background);

        expect(measured, `${theme.name} ${token} vs bg`).toBeGreaterThan(1.02);
        expect(measured, `${theme.name} ${token} vs bg`).toBeLessThan(1.4);
      }
    }
  });

  test("Given each theme, When the surface hairline is measured, Then it edges without outlining", () => {
    // The surface hairline has a NARROW band to live in, and both walls are
    // real failures the system has already hit once.
    //
    // Below the floor it is not an edge at all: the selected row goes back to
    // being a fill that fades out at its own corners, which is the exact
    // smudge the border was added to fix.
    //
    // Above the ceiling it becomes an OUTLINE. A border at text contrast draws
    // a hard box around every row and every code fence — the boxed-in card
    // look this system removed. That is why it must not be `fg-faint`, which
    // is ~3.9:1 on bg in both themes and would blow straight through this.
    //
    // Measured against every surface it can legally edge, not just `bg`: a row
    // sits on `sunken` in the sidebar and on `bg` in the transcript, and a
    // fence sits on `bg` — a border that only worked on one of them would fail
    // in exactly the place nobody screenshotted.
    const failures: string[] = [];

    for (const theme of THEMES) {
      for (const surface of SURFACES) {
        const measured = ratio(
          color(theme.block, "--color-line-surface"),
          color(theme.block, surface),
        );

        if (measured < 1.05) {
          failures.push(`${theme.name} line-surface on ${surface}: ${measured} < 1.05 (no edge)`);
        }
        if (measured > 2) {
          failures.push(`${theme.name} line-surface on ${surface}: ${measured} > 2 (outline)`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  test("Given each theme, When the surface hairline is compared to fg-faint, Then it is materially quieter", () => {
    // The rule this encodes: a BORDER is not a TEXT tier. Someone reaching for
    // "the faint one" when adding a bordered surface is the most likely way
    // this system reacquires hard outlines, so the distance is asserted rather
    // than left to the reviewer's eye.
    for (const theme of THEMES) {
      const background = color(theme.block, "--color-bg");
      const hairline = ratio(color(theme.block, "--color-line-surface"), background);
      const faint = ratio(color(theme.block, "--color-fg-faint"), background);

      expect(hairline, `${theme.name} line-surface vs fg-faint on bg`).toBeLessThan(faint / 2);
    }
  });

  test("Given each theme, When the hairline is compared to raised, Then they are separate steps", () => {
    // A border and a surface are different jobs. Sharing one ramp step is what
    // made a selected row in light mode read as an outlined box.
    for (const theme of THEMES) {
      expect(
        ramp(theme.block, "--color-line") === ramp(theme.block, "--color-raised"),
        theme.name,
      ).toBe(theme.backgroundIsDark);
    }
  });
});

/**
 * The diff pair: the system's ONE scoped exception to the single-accent law.
 *
 * They are held to the SAME 4.5:1 floor as any tone that carries meaning, and
 * for a sharper reason than prose: the marker is a 2px bar and the sign is one
 * glyph, so a tone that merely looks green at swatch size is a tone that
 * disappears at the size it is actually drawn. Measured on all three surfaces
 * because a fence sits on `bg` in the transcript and the row beneath the marker
 * can be `raised` when anchored.
 */
const DIFF = ["--color-diff-add", "--color-diff-remove"] as const;

describe("the diff exception", () => {
  test("Given each theme, When the diff tones are read, Then both clear 4.5:1 on every surface", () => {
    const failures: string[] = [];

    for (const theme of THEMES) {
      for (const token of DIFF) {
        for (const surface of SURFACES) {
          const measured = ratio(literal(theme.block, token), color(theme.block, surface));
          if (measured < 4.5) {
            failures.push(`${theme.name} ${token} on ${surface}: ${measured} < 4.5`);
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  test("Given each theme, When both diff tones are declared, Then the pair is complete", () => {
    // A theme with one half of the pair would render an addition in colour and a
    // removal in whatever the cascade left behind.
    for (const token of DIFF) {
      expect([...CSS.matchAll(new RegExp(`${token}:\\s*oklch\\(`, "g"))], token).toHaveLength(2);
    }
  });

  test("Given each theme, When the diff tones are compared to the accent, Then neither outranks it", () => {
    // The accent marks what is LIVE and what can be acted on. A fence is quoted
    // material — it must not carry more chroma than the one claim about right
    // now, or the loudest thing on screen becomes a block of old code.
    for (const theme of THEMES) {
      const chroma = accent(theme.block).chroma;
      for (const token of DIFF) {
        expect(
          literal(theme.block, token).chroma,
          `${theme.name} ${token} out-chromas the accent`,
        ).toBeLessThanOrEqual(chroma);
      }
    }
  });

  test("Given the two diff tones, When compared, Then they are distinguishable by hue", () => {
    // The pair has to be two signals, not one tone twice. They are also carried
    // by the literal `+`/`-` character, which is what makes the diff readable
    // with no colour at all — but a green and a red that measured alike would
    // make the drawn half of the signal decorative.
    for (const theme of THEMES) {
      const add = literal(theme.block, "--color-diff-add");
      const remove = literal(theme.block, "--color-diff-remove");

      expect(Math.abs(add.hue - remove.hue), theme.name).toBeGreaterThan(60);
    }
  });
});

describe("the accent budget", () => {
  test("Given the token file, When accents are counted, Then each theme declares exactly one", () => {
    const declarations = [...CSS.matchAll(/--color-accent:\s*oklch\(/g)];

    expect(declarations).toHaveLength(2);
  });

  test("Given the token file, When state colors are searched, Then none exist", () => {
    // State is text in a muted tone. A semantic color for it would reintroduce
    // the palette this reset removed.
    for (const token of ["--color-ok", "--color-warn", "--color-danger", "--color-info"]) {
      expect(CSS).not.toContain(token);
    }
  });

  test("Given the shell density block, When inspected, Then it re-points no color", () => {
    const shell = CSS.slice(CSS.indexOf('[data-density="shell"]'));
    const block = shell.slice(0, shell.indexOf("\n}"));

    expect(block).not.toContain("--color-");
  });
});

describe("the motion budget", () => {
  test("Given the token file, When durations are counted, Then content has one owner and the frame three named speeds", () => {
    // TWO SCALES, each with a single owner. Content motion — hover, surface,
    // a chevron — is `--motion-fast`, one duration composed with one easing so
    // a component cannot take one and not the other and invent a third speed.
    // The FRAME (tab strip zone, sidebar gap/container/content) moves on
    // the reference's measured scale: exactly `fast`/`base`/`slow` and one curve, and
    // nothing inside a column may spend them (docs/desktop-shell.md).
    const durations = [...CSS.matchAll(/^\s*(--[\w-]*duration[\w-]*):/gm)].map(([, name]) => name);
    const easings = [...CSS.matchAll(/^\s*(--[\w-]*ease[\w-]*):/gm)].map(([, name]) => name);

    expect(durations.filter((name) => name?.startsWith("--motion-"))).toEqual([
      "--motion-fast-duration",
    ]);
    expect(easings.filter((name) => name?.startsWith("--motion-"))).toEqual(["--motion-fast-ease"]);
    expect(CSS).toContain("--motion-fast-duration: 120ms");
    expect(CSS).toContain("--motion-fast:");

    // The frame's three, once each in `@theme`, and the utilities that read them.
    const theme = CSS.slice(CSS.indexOf("@theme {"), CSS.indexOf("\n}\n", CSS.indexOf("@theme {")));
    expect(
      [...theme.matchAll(/^\s*--duration-(\w+):\s*([^;]+);/gm)].map((m) => [m[1], m[2]]),
    ).toEqual([
      ["fast", "0.15s"],
      ["base", "0.24s"],
      ["slow", "0.3s"],
    ]);
    // The frame's curve IS the answer curve at another speed: one bezier in the
    // window, not two (.omo/reports/sidebar-toggle-ref-20260907.md).
    expect(theme).toContain("--ease-frame: var(--motion-fast-ease)");
    expect(durations.filter((name) => name?.startsWith("--duration-"))).toHaveLength(3);
    expect(easings.filter((name) => name?.startsWith("--ease-"))).toEqual(["--ease-frame"]);
  });

  test("Given the retired tokens, When searched, Then neither survives", () => {
    // The retirement has to be complete: a leftover `--duration-quiet` that
    // nothing references is a second answer waiting to be picked up.
    expect(CSS).not.toContain("--duration-quiet");
    expect(CSS).not.toContain("--ease-out-quiet");
  });

  test("Given every transition, When inspected, Then all of them use the motion token", () => {
    // No hardcoded `150ms` or bespoke cubic-bezier anywhere. A component that
    // hand-rolls a duration is exactly how a system reacquires three speeds.
    // `transition: none` is a DISABLE, not a speed — it is how reduced motion
    // and `.no-motion` surrender animation, and it is the one legal value that
    // does not reference the token.
    const transitions = [...CSS.matchAll(/transition(?:-duration)?:\s*([^;]+);/g)]
      .map(([, value]) => value?.trim() ?? "")
      .filter((value) => !value.startsWith("none"));

    expect(transitions.length, "transitions exist to check").toBeGreaterThan(0);
    for (const value of transitions) {
      expect(value, `transition "${value}" spends a motion token`).toMatch(
        /--motion-fast|--duration-(?:fast|base|slow)/,
      );
    }
  });

  test("Given the animations, When counted, Then only declared status and transcript motion exists", () => {
    // Status motion includes progress, waiting, and one-shot result entrances.
    const keyframes = [...CSS.matchAll(/@keyframes\s+([\w-]+)/g)].map(([, name]) => name);

    expect(keyframes.sort()).toEqual([
      "caret-blink",
      "spinner-step",
      "status-entrance",
      "status-pulse",
      "status-spin",
    ]);
  });

  test("Given reduced motion, When requested, Then animation and transition are both disabled", () => {
    const query = CSS.slice(CSS.indexOf("@media (prefers-reduced-motion: reduce)"));

    expect(query).toContain("animation: none !important");
    expect(query).toContain("transition: none !important");
  });

  test("Given reduced motion, When the live marks are frozen, Then they stay visible", () => {
    // A cancelled animation reverts to the element's unanimated style, which
    // for these two is not necessarily opaque. If this regressed, a `running`
    // session would become indistinguishable from a settled one for any reader
    // who asked the interface to hold still.
    const query = CSS.slice(CSS.indexOf("@media (prefers-reduced-motion: reduce)"));

    expect(query).toContain('[data-status-dot="running"]');
    expect(query).toContain('[data-caret][data-streaming="true"]');
  });
});

describe("focus is one ring", () => {
  test("Given the focus utility, When inspected, Then it is an inset accent ring on the surface radius", () => {
    const utility = CSS.slice(CSS.indexOf("@utility focus-ring"));
    const block = utility.slice(0, utility.indexOf("\n}\n"));

    // Inset, so a focused row is the same rectangle as a selected one rather
    // than a box drawn outside it and clipped by the column edge.
    expect(block).toContain("inset 0 0 0 1px var(--color-focus)");
    // Bound to the shared surface radius — focus reports focus, never a
    // different geometry.
    expect(block).toContain("border-radius: var(--radius-md)");
    // And the browser default is explicitly surrendered, not left to fight it.
    expect(block).toContain("outline: none");
  });

  test("Given the token file, When outlines are searched, Then no browser default survives", () => {
    // The failure this prevents: a primitive keeping `outline: 2px solid` for
    // its own focus state, so the system ships two focus treatments.
    const outlines = [...CSS.matchAll(/^\s*outline:\s*([^;]+);/gm)].map(([, value]) =>
      value?.trim(),
    );

    expect(outlines.length, "outline declarations exist to check").toBeGreaterThan(0);
    for (const value of outlines) {
      expect(value, `outline "${value}" is a surrender, not a ring`).toBe("none");
    }
  });
});
