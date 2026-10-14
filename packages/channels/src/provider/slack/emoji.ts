/** `reactions.add` takes short names, not characters; a character outside this table is refused, never guessed. */
const SLACK_EMOJI_NAMES: ReadonlyMap<string, string> = new Map([
  ["👍", "+1"],
  ["👎", "-1"],
  ["👀", "eyes"],
  ["✅", "white_check_mark"],
  ["❌", "x"],
  ["❤", "heart"],
  ["🔥", "fire"],
  ["🎉", "tada"],
  ["🚀", "rocket"],
  ["👏", "clap"],
  ["🙏", "pray"],
  ["👌", "ok_hand"],
  ["🤔", "thinking_face"],
  ["😀", "grinning"],
  ["😁", "grin"],
  ["😂", "joy"],
  ["🤣", "rolling_on_the_floor_laughing"],
  ["😢", "cry"],
  ["😭", "sob"],
  ["😱", "scream"],
  ["😎", "sunglasses"],
  ["🙌", "raised_hands"],
  ["💯", "100"],
  ["⚡", "zap"],
  ["⏳", "hourglass_flowing_sand"],
  ["⌛", "hourglass"],
  ["⚠", "warning"],
  ["🐛", "bug"],
  ["📝", "memo"],
  ["🫡", "saluting_face"],
  ["🤷", "shrug"],
  ["💡", "bulb"],
  ["🔍", "mag"],
  ["🛠", "hammer_and_wrench"],
]);

const SHORT_NAME = /^:([a-z0-9_+-]+):$/;
/** Variation selectors and skin-tone modifiers do not change the short name. */
const PRESENTATION = /[\u{FE0E}\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu;

/** A `:short_name:` passes through; a character is looked up without its presentation marks. */
export function slackEmojiName(emoji: string): string | undefined {
  const short = SHORT_NAME.exec(emoji);
  if (short !== null) return short[1];
  return SLACK_EMOJI_NAMES.get(emoji.replace(PRESENTATION, ""));
}
