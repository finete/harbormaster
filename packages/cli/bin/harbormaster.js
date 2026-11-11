#!/usr/bin/env node
// `harbormaster` entry point: a thin client of the running app's local
// socket (see ../src/index.ts). Built output lives in ../dist.
import { run } from "../dist/index.js";

run();
