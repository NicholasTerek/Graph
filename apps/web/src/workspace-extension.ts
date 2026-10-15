import type { ComponentType } from "react";
import type { GraphClient } from "@graph/sdk";
export type WorkspaceExtension = {
  ontology: string;
  label: string;
  component: ComponentType<{
    client: GraphClient;
    onOpenOperations?: () => void;
  }>;
};
export function defineWorkspaces(extensions: WorkspaceExtension[]) {
  if (new Set(extensions.map((e) => e.ontology)).size !== extensions.length)
    throw Error("Duplicate workspace ontology");
  return extensions;
}
