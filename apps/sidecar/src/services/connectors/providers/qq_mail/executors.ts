import type { CredentialValidators, ProviderExecutors } from "../../core/types";

import { createMailProviderRuntime } from "../../mail/runtime";
import { qqMailRuntimeConfig } from "./config";

const runtime = createMailProviderRuntime(qqMailRuntimeConfig);

export const executors: ProviderExecutors = runtime.executors;
export const credentialValidators: CredentialValidators = runtime.credentialValidators;
