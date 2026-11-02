import type { z } from "zod";
import { createCatalogLoader } from "./loader";
import type { CatalogModel, CatalogProvider } from "./schema";

export namespace ModelsDev {
  export type Model = z.infer<typeof CatalogModel>;
  export type Provider = z.infer<typeof CatalogProvider>;

  export const get = createCatalogLoader();
}
