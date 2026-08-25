import type { ProviderActionDefinition } from "../../core/provider-definition";
import type { MailActionName } from "../../mail/actions";

import { createMailActions } from "../../mail/actions";

export const qqMailActions: readonly ProviderActionDefinition<MailActionName>[] = createMailActions(
  "qq_mail",
  "QQ Mail",
);
