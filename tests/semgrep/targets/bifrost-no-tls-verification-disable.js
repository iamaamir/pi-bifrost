import { request } from "node:https";

// ruleid: bifrost-no-tls-verification-disable
request({ rejectUnauthorized: false });

// ruleid: bifrost-no-tls-verification-disable
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// ruleid: bifrost-no-tls-verification-disable
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";

// ok: bifrost-no-tls-verification-disable
request({ rejectUnauthorized: true });

// ok: bifrost-no-tls-verification-disable
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";

// ok: bifrost-no-tls-verification-disable
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "1";
