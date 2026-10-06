/** Stable configuration identities for classifier backends. */
export const CLASSIFIER_BACKEND_IDS = {
  prompt: "prompt",
  typesafe: "typesafe",
  piNative: "pi-native",
} as const;

export type ClassifierBackend = typeof CLASSIFIER_BACKEND_IDS[keyof typeof CLASSIFIER_BACKEND_IDS];

/** Provider-neutral classifier result retained through policy and UI layers. */
export interface ClassificationJudgment {
  readonly tier: string;
  readonly backend: ClassifierBackend;
  readonly model?: string;
  readonly confidence?: number;
  readonly probabilities?: Readonly<Record<string, number>>;
}

export type ClassifierOutput = ClassificationJudgment | string;

/** Criterion for one tier: a plain string or a structured description. */
export type TierCriterion = string | {
  readonly what: string;
  readonly notFor?: string;
  readonly examples?: readonly string[];
};

/** One classification request. The caller pre-bounds `prompt`. */
export interface ClassifierRequest {
  readonly prompt: string;
  readonly tiers: readonly string[];
  readonly criteria: Readonly<Record<string, TierCriterion>>;
}

/** Transport contract for direct classifier backends (typesafe, pi-native). */
export type ClassifierTransport = (
  request: ClassifierRequest,
  signal?: AbortSignal,
) => Promise<ClassificationJudgment | undefined>;

export const TYPE_SAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const TYPE_SAFE_MODEL = "jev-1.13.0";
export const TYPE_SAFE_CREDENTIAL_KEY = CLASSIFIER_BACKEND_IDS.typesafe;
export const TYPE_SAFE_API_KEY_ENV = "TYPESAFE_API_KEY";

interface SystemOneTransport {
  readonly typesafe?: { readonly endpoint?: string; readonly model?: string };
}

export function systemOneEndpoint(classifier: SystemOneTransport | undefined): string {
  return classifier?.typesafe?.endpoint ?? TYPE_SAFE_ENDPOINT;
}

export function systemOneModel(classifier: SystemOneTransport | undefined): string {
  return classifier?.typesafe?.model ?? TYPE_SAFE_MODEL;
}

/** Only the hosted TypeSafe endpoint needs, and ever receives, the stored TypeSafe key. */
export function systemOneRequiresKey(classifier: SystemOneTransport | undefined): boolean {
  return systemOneEndpoint(classifier) === TYPE_SAFE_ENDPOINT;
}

export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function isClassifierBackend(value: unknown): value is ClassifierBackend {
  return value === CLASSIFIER_BACKEND_IDS.prompt
    || value === CLASSIFIER_BACKEND_IDS.typesafe
    || value === CLASSIFIER_BACKEND_IDS.piNative;
}
