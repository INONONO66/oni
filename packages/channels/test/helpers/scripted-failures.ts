class ScriptedFailures {
  private readonly failures = new Map<string, Error>();

  fail(method: string, error: Error): void {
    this.failures.set(method, error);
  }

  check(method: string): void {
    const error = this.failures.get(method);
    if (error !== undefined) {
      this.failures.delete(method);
      throw error;
    }
  }
}

export class ScriptedClient {
  readonly logins: string[] = [];
  protected readonly failures = new ScriptedFailures();

  fail(method: string, error: Error): void {
    this.failures.fail(method, error);
  }

  login(credentials: { token: string }): Promise<object> {
    this.logins.push(credentials.token);
    return Promise.resolve(this);
  }
}
