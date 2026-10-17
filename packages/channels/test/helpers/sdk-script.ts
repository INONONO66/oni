let responder: (() => Response | Promise<Response>) | undefined;

export function setSdkResponse(next: (() => Response | Promise<Response>) | undefined): void {
  responder = next;
}

export async function sdkResponse(): Promise<Response | undefined> {
  return responder?.();
}
