#!/usr/bin/env node
import { runReachCli } from "../lib/reach/cli.mjs";

process.exitCode = await runReachCli(process.argv.slice(2), { stdout: process.stdout });
