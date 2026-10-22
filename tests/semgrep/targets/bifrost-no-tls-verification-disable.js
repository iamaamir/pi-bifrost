import { request } from "node:https";

// ruleid: bifrost-no-tls-verification-disable
request({ rejectUnauthorized: false });

// ok: bifrost-no-tls-verification-disable
request({ rejectUnauthorized: true });
