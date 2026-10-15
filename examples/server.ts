import { composeExtensions } from "@graph/core";
import { ontologySchema } from "@graph/contracts";
import semiconductor from "./semiconductor/ontology.json";
import library from "./library/ontology.json";
import { launchReadiness } from "./semiconductor/functions/launch-readiness.js";
import { githubRecoveryAction } from "./semiconductor/actions/github.js";
import { semiconductorSources } from "./semiconductor/sources.js";
import { libraryAvailability } from "./library/functions.js";

export function exampleExtensions(env: NodeJS.ProcessEnv = {}) {
  const available = [
    {
      id: "semiconductor",
      ontologies: [ontologySchema.parse(semiconductor)],
      functions: [launchReadiness],
      actions: [
        githubRecoveryAction({
          repository: env.GRAPH_ACTION_REPOSITORY,
          token: env.GITHUB_TOKEN,
        }),
      ],
      sources: semiconductorSources.map((source) => ({
        ontology: "semiconductor",
        source,
      })),
    },
    {
      id: "library",
      ontologies: [ontologySchema.parse(library)],
      functions: [libraryAvailability],
    },
  ];
  const selected = env.GRAPH_EXTENSIONS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (selected?.some((id) => !available.some((e) => e.id === id)))
    throw Error("GRAPH_EXTENSIONS contains an unknown extension");
  const extensions = selected
    ? available.filter((e) => selected.includes(e.id))
    : available;
  composeExtensions(extensions);
  return extensions;
}
