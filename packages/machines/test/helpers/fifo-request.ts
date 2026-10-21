// Spawned by fs.test.ts: FIFO requests must settle in a fresh process so a
// blocking open would surface as a timeout there instead of hanging the suite.
// One process serves every request of a test: an instrumented cold start is
// the dominant cost under the exact collector.
import { z } from "zod";
import { Machine } from "@oni/protocol";
import { createFsDriver } from "./native";

const [root, requests] = process.argv.slice(2);
if (root === undefined || requests === undefined) throw new Error("usage: fifo-request <root> <requests-json>");
const driver = createFsDriver(new Map([["docs", root]]));
const results: Machine.FsResult[] = [];
for (const request of z.array(Machine.FsRequest).parse(JSON.parse(requests))) results.push(await driver(request));
driver.close();
process.stdout.write(JSON.stringify(results));
