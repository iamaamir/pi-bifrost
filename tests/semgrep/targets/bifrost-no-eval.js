// ruleid: bifrost-no-eval
eval("1 + 1");

// ruleid: bifrost-no-eval
const dynamic = new Function("return 1");

// ok: bifrost-no-eval
const literal = "1 + 1";
