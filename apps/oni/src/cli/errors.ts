/**
 * A CLI-surfaced failure: bad input, an unsupported environment, or a
 * service-management command that did not do what it claimed. The CLI prints
 * the message and exits non-zero; the name makes the class greppable where a
 * bare `Error` would be indistinguishable from a defect.
 */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}
