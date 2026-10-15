import LaunchPlanner from "./semiconductor/app/LaunchPlanner.js";
import LibraryWorkspace from "./library/Workspace.js";
import { defineWorkspaces } from "../apps/web/src/workspace-extension.js";
export const workspaceExtensions = defineWorkspaces([
  {
    ontology: "semiconductor",
    label: "Launch operations",
    component: LaunchPlanner,
  },
  {
    ontology: "library",
    label: "Library circulation",
    component: LibraryWorkspace,
  },
]);
