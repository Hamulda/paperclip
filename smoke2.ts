import { getTestDatabaseSupport } from "./packages/db/src/test-database-provider.js";

const s = await getTestDatabaseSupport();
console.log(JSON.stringify(s, null, 2));