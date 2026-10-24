export function recordHttp(respond: (request: Request) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  const requests: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      requests.push(request);
      return await respond(request);
    },
    { preconnect: original.preconnect },
  );
  return { requests, restore: () => { globalThis.fetch = original; } };
}
