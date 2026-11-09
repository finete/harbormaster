// Spawn host: an Electron utility process whose only job is to run core's
// child processes (`git`, `gh`) off the main process. See
// spawn-host-client.ts for the why; this side just answers requests.

import { execFileRunner } from "@harbormaster/core";
import {
  handleSpawnHostRequest,
  type SpawnHostRequest,
} from "./spawn-host-protocol";

process.parentPort.on("message", (event) => {
  void handleSpawnHostRequest(
    execFileRunner,
    event.data as SpawnHostRequest,
  ).then((response) => process.parentPort.postMessage(response));
});
