import manifest from "../package.json" with { type: "json" };

export const ONI_VERSION: string = manifest.version;
