/** Stable configuration identities for classifier backends. */
export const CLASSIFIER_BACKEND_IDS = {
  prompt: "prompt",
  typesafe: "typesafe",
} as const;

export type ClassifierBackend = typeof CLASSIFIER_BACKEND_IDS[keyof typeof CLASSIFIER_BACKEND_IDS];

export const TYPE_SAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const TYPE_SAFE_MODEL = "jev-1.13.0";
export const TYPE_SAFE_CREDENTIAL_KEY = CLASSIFIER_BACKEND_IDS.typesafe;
export const TYPE_SAFE_API_KEY_ENV = "TYPESAFE_API_KEY";

export function isClassifierBackend(value: unknown): value is ClassifierBackend {
  return value === CLASSIFIER_BACKEND_IDS.prompt || value === CLASSIFIER_BACKEND_IDS.typesafe;
}
