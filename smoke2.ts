import { getTestDatabaseSupport } from "@paperclipai/db";

const s = await getTestDatabaseSupport();
console.log(JSON.stringify(s, null, 2));