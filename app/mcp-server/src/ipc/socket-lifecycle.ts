import fs from 'node:fs';
import net from 'node:net';

const SOCKET_PROBE_TIMEOUT_MS = 500;

export interface UnixSocketIdentity {
  dev: number;
  ino: number;
}

export type UnixSocketPreparation = 'missing' | 'active' | 'removed';

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT',
  );
}

function identityFromStats(stats: fs.Stats): UnixSocketIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(left: UnixSocketIdentity, right: UnixSocketIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function probeUnixSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      socket.destroy();
      callback();
    };

    const timeoutId = setTimeout(() => {
      // A connection that neither succeeds nor refuses may belong to a live but
      // overloaded process. Never unlink it on an ambiguous probe.
      finish(() => resolve(true));
    }, SOCKET_PROBE_TIMEOUT_MS);
    timeoutId.unref?.();

    socket.once('connect', () => finish(() => resolve(true)));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') {
        finish(() => resolve(false));
        return;
      }
      finish(() => reject(error));
    });
  });
}

/**
 * Prepare a Unix-domain socket path without ever replacing a live listener or
 * an unrelated filesystem entry. A stale socket is removed only when the
 * identity observed before and after the liveness probe is unchanged.
 */
export async function prepareUnixSocketPath(socketPath: string): Promise<UnixSocketPreparation> {
  let initialStats: fs.Stats;
  try {
    initialStats = fs.lstatSync(socketPath);
  } catch (error) {
    if (isMissingPathError(error)) return 'missing';
    throw error;
  }

  if (!initialStats.isSocket()) {
    throw new Error(`Refusing to replace non-socket IPC path: ${socketPath}`);
  }

  if (await probeUnixSocket(socketPath)) {
    return 'active';
  }

  let currentStats: fs.Stats;
  try {
    currentStats = fs.lstatSync(socketPath);
  } catch (error) {
    if (isMissingPathError(error)) return 'missing';
    throw error;
  }

  if (
    !currentStats.isSocket() ||
    !sameIdentity(identityFromStats(initialStats), identityFromStats(currentStats))
  ) {
    throw new Error(`IPC socket path changed during stale-socket probe: ${socketPath}`);
  }

  fs.unlinkSync(socketPath);
  return 'removed';
}

export function captureUnixSocketIdentity(socketPath: string): UnixSocketIdentity {
  const stats = fs.lstatSync(socketPath);
  if (!stats.isSocket()) {
    throw new Error(`IPC listener did not create a socket: ${socketPath}`);
  }
  return identityFromStats(stats);
}

/** Remove the path only when it is still the socket created by this process. */
export function removeOwnedUnixSocket(
  socketPath: string,
  expectedIdentity: UnixSocketIdentity,
): boolean {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(socketPath);
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }

  if (!stats.isSocket() || !sameIdentity(identityFromStats(stats), expectedIdentity)) {
    return false;
  }

  fs.unlinkSync(socketPath);
  return true;
}
