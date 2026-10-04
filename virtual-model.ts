import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * Pi's virtual catalog API id. The Pi package exports only
 * VIRTUAL_MODEL_STATE_ENTRY today, so this is the one owned mirror of the
 * host constant — drop in favor of the export when Pi publishes it.
 */
export const VIRTUAL_MODEL_API = "pi-virtual";

/** Provider/id under which Bifrost registers its opt-in virtual model. */
export const BIFROST_AUTO_PROVIDER = "bifrost";
export const BIFROST_AUTO_ID = "auto";

export function isVirtualModel(model: { api: string } | undefined): boolean {
  return model?.api === VIRTUAL_MODEL_API;
}

export function isBifrostAuto(model: Model<Api> | undefined): boolean {
  return (
    model?.provider === BIFROST_AUTO_PROVIDER &&
    model.id === BIFROST_AUTO_ID &&
    isVirtualModel(model)
  );
}
