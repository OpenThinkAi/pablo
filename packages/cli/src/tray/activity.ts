/**
 * "A reader window is open" as a fact the tray can see across processes (AGT-1598).
 *
 * The tray opens a round as a child `pablo read`, but a reader may also run `pablo read` by hand, and the
 * window (with its Submit, which is how a review is posted) lives in that other process. The self-updater
 * must never replace pablo's files under a window, so every process that holds a reader window leaves a
 * marker file `<trayDir>/active/<pid>-<n>` while it is open, and the tray treats any marker whose pid is
 * still alive as "busy". A marker left by a crashed process names a dead pid and is swept on the next look.
 *
 * Best effort in the writing direction (a marker that cannot be written must never stop a window from
 * opening); conservative in the reading direction (an unreadable directory is not "busy": the in-process
 * view set the daemon keeps itself still guards the windows it opened).
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { trayDir } from "./state";

type Env = Record<string, string | undefined>;

export const activityDir = (env: Env = process.env): string => join(trayDir(env), "active");

let counter = 0;

/** Marks this process as holding a reader window; returns the release. Never throws. */
export function markReaderActive(env: Env = process.env): () => void {
  const path = join(activityDir(env), `${process.pid}-${(counter += 1)}`);
  try {
    mkdirSync(activityDir(env), { recursive: true });
    writeFileSync(path, "", "utf8");
  } catch {
    return () => {};
  }
  return () => {
    try {
      rmSync(path, { force: true });
    } catch {
      // gone is gone
    }
  };
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when any process still holds a reader window. Sweeps markers whose process is gone. */
export function readerActive(env: Env = process.env, alive: (pid: number) => boolean = pidAlive): boolean {
  let names: string[];
  try {
    names = readdirSync(activityDir(env));
  } catch {
    return false;
  }
  let active = false;
  for (const name of names) {
    const pid = Number(/^(\d+)-\d+$/.exec(name)?.[1]);
    if (!Number.isInteger(pid) || pid < 1) continue;
    if (alive(pid)) active = true;
    else {
      try {
        rmSync(join(activityDir(env), name), { force: true });
      } catch {
        // swept next time
      }
    }
  }
  return active;
}
