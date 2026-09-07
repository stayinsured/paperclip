import type { ClickUpApiPort, ClickUpRemoteTask } from "./types.js";

export interface ClickUpReadbackPolicy {
  attempts?: number;
  delayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Bounded eventual-consistency readback. The first matching observation returns immediately. */
export async function readClickUpTaskUntil(input: {
  api: ClickUpApiPort;
  taskId: string;
  matches: (task: ClickUpRemoteTask | null) => boolean;
  policy?: ClickUpReadbackPolicy;
}): Promise<ClickUpRemoteTask | null> {
  const attempts = Math.max(1, Math.min(input.policy?.attempts ?? 3, 5));
  const delayMs = Math.max(0, Math.min(input.policy?.delayMs ?? 100, 2_000));
  const sleep = input.policy?.sleep ?? defaultSleep;
  let observed: ClickUpRemoteTask | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    observed = await input.api.getTask(input.taskId);
    if (input.matches(observed)) return observed;
    if (attempt + 1 < attempts && delayMs > 0) await sleep(delayMs * (attempt + 1));
  }
  return observed;
}
