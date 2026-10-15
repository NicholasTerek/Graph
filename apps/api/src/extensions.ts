// Compatibility for embedded scripts; production composes the extension manifest.
import { composeExtensions } from "@graph/core";
import { exampleExtensions } from "../../../examples/server.js";
export const platformFunctions =
  composeExtensions(exampleExtensions()).functions;
