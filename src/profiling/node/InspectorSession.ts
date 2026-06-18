import { Session } from "node:inspector/promises";

/** Run fn with a connected inspector Session, disconnecting after. Pass an
 *  external session to reuse it; the caller then owns its connect/disconnect
 *  (and any domain enable/disable), so this leaves it open. */
export async function withSession<T>(
  external: Session | undefined,
  fn: (session: Session) => Promise<T>,
): Promise<T> {
  const session = external ?? new Session();
  const owned = !external;
  if (owned) session.connect();
  try {
    return await fn(session);
  } finally {
    if (owned) session.disconnect();
  }
}
