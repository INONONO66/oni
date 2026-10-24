import { kernelDeliveryReceipt, type DeliveryReceipt } from "../support/deliver";
import type { ProviderDeliveryRoute } from "./contract";

export function kernelDeliveryRoute(
  surface: { deliver: (...args: Parameters<ProviderDeliveryRoute>) => Promise<DeliveryReceipt> },
): ProviderDeliveryRoute {
  return (...args) => surface.deliver(...args).then(kernelDeliveryReceipt);
}
