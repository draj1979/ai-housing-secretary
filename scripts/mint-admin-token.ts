/**
 * scripts/mint-admin-token.ts
 *
 * The out-of-band token issuance gateway/adminAuth.ts's doc comment
 * refers to ("mintAdminToken is a building block for however tokens
 * actually get handed out ... not an HTTP login endpoint itself") — an
 * operator (not the app itself) runs this to get a token to hand to
 * someone directly. gateway/adminLoginRoutes.ts's `/admin/login`
 * (username + password, see scripts/hash-admin-password.ts) is now the
 * primary way a human secretary actually gets in through the dashboard;
 * this script stays as the out-of-band alternative — scripting, or
 * emergency access if the login endpoint itself is ever misconfigured or
 * down.
 *
 * Usage:
 *   pnpm admin:mint-token -- --sub "secretary@example-society.in" --role secretary
 *   pnpm admin:mint-token -- --sub "committee@example-society.in" --role read_only
 */
import { loadEnvAsync } from '../src/config/env.js';
import {
  adminAuthConfigFromEnv,
  mintAdminToken,
  ADMIN_ROLES,
  type AdminRole,
} from '../src/gateway/adminAuth.js';

function parseArgs(argv: string[]): { sub: string; role: AdminRole } {
  let sub: string | undefined;
  let role: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--sub') sub = argv[++i];
    else if (argv[i] === '--role') role = argv[++i];
  }
  if (!sub) {
    throw new Error(
      'Usage: pnpm admin:mint-token -- --sub <identifier> --role <secretary|read_only>',
    );
  }
  if (!role || !(ADMIN_ROLES as readonly string[]).includes(role)) {
    throw new Error(`--role must be one of: ${ADMIN_ROLES.join(', ')} (got: ${role ?? '<none>'})`);
  }
  return { sub, role: role as AdminRole };
}

async function main(): Promise<void> {
  const { sub, role } = parseArgs(process.argv.slice(2));
  // Real process entry point (HLD Sec 15) — resolves SECRETS_SOURCE=gcp's
  // JWT_SECRET before adminAuthConfigFromEnv reads it, same reasoning as
  // src/db/migrate.ts's identical comment.
  const env = await loadEnvAsync();
  const config = adminAuthConfigFromEnv(env);
  const token = mintAdminToken(config, { sub, role });

  console.log(`Admin token for "${sub}" (role: ${role}, expires in ${config.expiresIn}):\n`);
  console.log(token);
  console.log(
    '\nHand this to them directly (WhatsApp/Signal/in person) — never post it anywhere logged or committed. ' +
      'They paste it into the dashboard once; it is stored only in their browser (localStorage), never sent anywhere but this app.',
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
