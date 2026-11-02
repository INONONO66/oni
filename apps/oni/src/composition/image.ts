import { type Image, makeImage, resolveAuthFilePath } from "@oni/ai";
import { type BusEvent, traceIdFromUuid } from "@oni/protocol";
import type { ImageCall } from "../bundles/tools/image/index";
import type { OniConfig } from "../config";

export function composeImage(
  model: Pick<OniConfig["model"], "imageRows">,
  services: { readonly observations: BusEvent.Sink; readonly now: () => number },
): Image {
  return makeImage({
    authFilePath: resolveAuthFilePath(),
    ...(model.imageRows === undefined ? {} : { rows: model.imageRows }),
    events: services.observations,
    now: services.now,
  });
}

/**
 * The gateway's image door over the composed `Image`: every call runs under
 * its own trace, and a model id override stays on the row that serves the
 * default call, whose credential the rows own.
 */
export function createImagePort(image: Image, id: () => string): (call: ImageCall) => ReturnType<Image["generate"]> {
  return (call) =>
    image.generate({
      prompt: call.prompt,
      traceId: traceIdFromUuid(id()),
      ...(call.model === undefined ? {} : { model: call.model }),
      ...(call.size === undefined ? {} : { size: call.size }),
      ...(call.n === undefined ? {} : { n: call.n }),
    });
}
