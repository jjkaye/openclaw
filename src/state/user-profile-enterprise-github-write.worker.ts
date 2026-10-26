import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { parseEnterpriseGitHubPrincipal } from "../shared/enterprise-github-principal.js";
import { normalizeVerifiedEmail } from "../shared/verified-email.js";
import { normalizeGitHubLogin } from "../utils/github-login.js";
import { ensureProfileForEmailInDatabase } from "./user-profile-email.kernel.js";
import {
  publishUserProfileAuthorityChange,
  publishUserProfileIdentityChange,
} from "./user-profile-events.js";
import { publishUserProfilesChange } from "./user-profile-list.js";
import {
  runUserProfileWriteTransaction,
  type UserProfileMutationOptions,
} from "./user-profile-mutation.js";
import { userProfilesDb } from "./user-profiles-internal.js";
import { ensureUserProfilesSchema, UserProfileOwnerError } from "./user-profiles-schema.js";
import { normalizeInitialDisplayName } from "./user-profiles.js";

/** Creation, display adoption, and verified credit settle in the profile writer's transaction. */
export function ensureEnterpriseGitHubProfile(
  principal: string,
  name: string,
  metadata: { login: string; email?: string },
  options: UserProfileMutationOptions,
) {
  ensureUserProfilesSchema(options);
  const displayName = normalizeInitialDisplayName(name);
  return runUserProfileWriteTransaction(
    ({ db }) => {
      const now = Date.now();
      const profile = ensureProfileForEmailInDatabase(
        db,
        principal,
        displayName,
        now,
        options.mutation,
      );
      const adoptsName = Boolean(displayName && profile.displayName === principal);
      if (adoptsName) {
        options.mutation?.before(db, profile.id);
        executeSqliteQuerySync(
          db,
          userProfilesDb(db)
            .updateTable("user_profiles")
            .set({ display_name: displayName, updated_at: now })
            .where("id", "=", profile.id),
        );
        options.mutation?.publish(profile.id);
        publishUserProfilesChange(db, profile.id);
      }
      const identityProfileId = profile.id;
      const identityPrincipal = principal;
      const identityMutation = options.mutation;
      /** Only current authenticated Enterprise GitHub metadata can establish this host-scoped credit binding. */
      function applyEnterpriseGitHubIdentity(): number | undefined {
        if (identityProfileId === GATEWAY_OWNER_PROFILE_ID) {
          throw new UserProfileOwnerError("merge");
        }
        const parsedPrincipal = parseEnterpriseGitHubPrincipal(identityPrincipal);
        const accountId = parsedPrincipal?.accountId ?? Number.NaN;
        const provider = parsedPrincipal ? `github:${parsedPrincipal.host}` : "";
        const login = normalizeGitHubLogin(metadata.login);
        const binding = executeSqliteQueryTakeFirstSync(
          db,
          userProfilesDb(db)
            .selectFrom("user_profile_emails")
            .select(["profile_id", "binding_id"])
            .where("email", "=", identityPrincipal),
        );
        if (
          !Number.isSafeInteger(accountId) ||
          !login ||
          binding?.profile_id !== identityProfileId ||
          !binding.binding_id
        ) {
          throw new Error("Enterprise GitHub identity is invalid");
        }
        const email = normalizeVerifiedEmail(metadata.email);
        if (metadata.email !== undefined && !email) {
          throw new Error("Enterprise GitHub verified email is invalid");
        }
        // Historical payloads and moved aliases cannot confer credit. Reauthentication writes this binding.
        const proof = JSON.stringify({
          version: 1,
          profileId: identityProfileId,
          bindingId: binding.binding_id,
          ...(email ? { email } : {}),
        });
        const kysely = userProfilesDb(db);
        const before = executeSqliteQueryTakeFirstSync(
          db,
          kysely
            .selectFrom("user_profile_identities")
            .select(["profile_id", "canonical_login", "verified_email_json"])
            .where("provider", "=", provider)
            .where("subject", "=", String(accountId)),
        );
        if (
          before?.profile_id === identityProfileId &&
          before.canonical_login === login &&
          before.verified_email_json === proof
        ) {
          return undefined;
        }
        const changed = [...new Set([identityProfileId, ...(before ? [before.profile_id] : [])])];
        identityMutation?.before(db, ...changed);
        const values = {
          profile_id: identityProfileId,
          canonical_login: login,
          verified_email_json: proof,
        };
        const identityNow = Date.now();
        executeSqliteQuerySync(
          db,
          kysely
            .insertInto("user_profile_identities")
            .values({
              provider,
              subject: String(accountId),
              ...values,
              created_at: identityNow,
            })
            .onConflict((oc) => oc.columns(["provider", "subject"]).doUpdateSet(values)),
        );
        executeSqliteQuerySync(
          db,
          kysely
            .updateTable("user_profiles")
            .set({ updated_at: identityNow })
            .where("id", "=", identityProfileId),
        );
        identityMutation?.identity(...changed);
        identityMutation?.authority(...changed);
        identityMutation?.publish(...changed);
        publishUserProfileIdentityChange(db, ...changed);
        publishUserProfileAuthorityChange(db, ...changed);
        publishUserProfilesChange(db, ...changed);
        return identityNow;
      }
      const identityUpdatedAt = applyEnterpriseGitHubIdentity();
      return {
        ...profile,
        displayName: adoptsName ? displayName : profile.displayName,
        updatedAt: identityUpdatedAt ?? (adoptsName ? now : profile.updatedAt),
      };
    },
    options,
    { operationLabel: "user-profiles.enterprise-github-identity" },
  );
}
