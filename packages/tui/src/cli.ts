#!/usr/bin/env bun
import { USAGE } from "./usage";

if (import.meta.main) {
  process.stdout.write(USAGE);
  process.exit(0);
}
