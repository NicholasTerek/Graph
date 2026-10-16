import { GraphApiError } from "@graph/sdk";
export function requestErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof GraphApiError)) return message;
  if (error.status === 401)
    return `${message}. Open API access and apply a valid session credential from your workspace operator.`;
  if (error.status === 403)
    return `${message}. Ask your workspace operator to check this credential's scopes and ontology access; approval and execution require separate permissions.`;
  return message;
}
