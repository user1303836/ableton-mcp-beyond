#!/usr/bin/env node

import { serve } from "./host.js";

await serve(process.stdin, process.stdout);
