#!/usr/bin/env node
import { browserCliArgs, runDefaultBench } from "benchforge";

await runDefaultBench(undefined, browserCliArgs);
