// Production Bifrost extension loader for the child Auto inline override
// regression harness. Registers the real extension, no fixtures or stubs.
import bifrostExtension from "../../index.ts";

export default function loadBifrostExtension(pi) {
  return bifrostExtension(pi);
}
