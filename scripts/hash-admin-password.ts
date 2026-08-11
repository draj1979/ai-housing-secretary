/**
 * scripts/hash-admin-password.ts
 *
 * Generates the bcrypt hash gateway/adminLoginRoutes.ts's `/admin/login`
 * checks a submitted password against. Run this once (locally, never on
 * the deploy VM's shell history) to turn a real password into the value
 * that actually goes in Secret Manager (`admin-password-hash`, per
 * .env.example's `GCP_SECRET_ADMIN_PASSWORD_HASH`) — the plaintext
 * password itself is never stored anywhere, this script included; it's
 * read once (hidden input, not a CLI arg — same reasoning as
 * scripts/provision-gcp.sh's `prompt_or_env`) and discarded the moment
 * `hash()` returns.
 *
 * Must be run interactively (a real TTY) — reads raw keypresses directly
 * (not readline: `readline/promises`'s `question()` called twice in a
 * row doesn't reliably see the second line when stdin is a non-TTY pipe,
 * a Node quirk this sidesteps rather than works around).
 *
 * Usage:
 *   pnpm admin:hash-password
 *   # paste the hash it prints into Secret Manager:
 *   printf '%s' '<hash>' | gcloud secrets versions add admin-password-hash --data-file=-
 */
import { hash } from 'bcryptjs';

// bcrypt's own cost factor — 12 is a reasonable default for 2026
// hardware (roughly a quarter-second per hash), high enough to make
// offline brute-forcing of a leaked hash slow, low enough not to make
// every login request noticeably sluggish.
const COST_FACTOR = 12;

// Control characters as explicit char codes, not literal bytes in
// source — invisible control chars are fragile across editors/diffs/
// grep, String.fromCharCode isn't.
const ENTER_CR = String.fromCharCode(13);
const ENTER_LF = String.fromCharCode(10);
const CTRL_C = String.fromCharCode(3);
const BACKSPACE = String.fromCharCode(8);
const DEL = String.fromCharCode(127);

/** Reads one line from stdin with the terminal echo suppressed (each keystroke shows nothing). */
async function promptHiddenPassword(promptText: string): Promise<string> {
  process.stdout.write(promptText);

  if (!process.stdin.isTTY) {
    throw new Error('This script must be run interactively (a real terminal), not piped input.');
  }

  return new Promise((resolve, reject) => {
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
    };

    function onData(chunk: string) {
      for (const char of chunk) {
        if (char === ENTER_CR || char === ENTER_LF) {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === CTRL_C) {
          cleanup();
          reject(new Error('Aborted.'));
          return;
        }
        if (char === BACKSPACE || char === DEL) {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    }

    process.stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const password = await promptHiddenPassword('New admin password (hidden): ');
  const confirm = await promptHiddenPassword('Confirm: ');
  if (!password) {
    throw new Error('Password cannot be empty.');
  }
  if (password !== confirm) {
    throw new Error('Passwords did not match.');
  }

  const hashed = await hash(password, COST_FACTOR);

  console.log('\nbcrypt hash (this is what goes in Secret Manager, not the password itself):\n');
  console.log(hashed);
  console.log(
    "\nStore it: printf '%s' '<hash above>' | gcloud secrets versions add admin-password-hash --data-file=-",
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
