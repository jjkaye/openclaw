import type { ProvidedContext } from "vitest";
import type { ControlUiBuildInfo } from "../build-info-types.ts";
import type { PreparedNativeControlUiPluginBuild } from "./control-ui-plugin-fixture.ts";

export type ControlUiE2ePrebuiltAssets = {
  root: string;
  buildInfo: Pick<ControlUiBuildInfo, "buildId" | "version">;
};

declare module "vitest" {
  export interface ProvidedContext {
    controlUiE2ePrebuiltAssets?: ControlUiE2ePrebuiltAssets;
    controlUiE2eBuildRoot?: string;
    controlUiE2eNativePluginBuilds?: PreparedNativeControlUiPluginBuild[];
  }
}

export type ControlUiE2eBuildIdentity = NonNullable<
  ProvidedContext["controlUiE2ePrebuiltAssets"]
>["buildInfo"];

let sharedPreview: {
  baseUrl: string;
  buildInfo: ControlUiE2eBuildIdentity | null;
  nativePluginBuilds: readonly PreparedNativeControlUiPluginBuild[];
} | null = null;

export function getSharedControlUiE2ePreview() {
  return sharedPreview;
}

export function setSharedControlUiE2eServerBaseUrl(
  baseUrl: string | null,
  buildInfo?: ControlUiE2eBuildIdentity | null,
  nativePluginBuilds: readonly PreparedNativeControlUiPluginBuild[] = [],
): void {
  sharedPreview = baseUrl ? { baseUrl, buildInfo: buildInfo ?? null, nativePluginBuilds } : null;
}
