import { appendFileSync } from "node:fs";
import bifrostExtension from "../../index.ts";

const reportPath = process.env.BIFROST_DISPATCH_IDENTITY_REPORT;

function record(event) {
  if (!reportPath) return;
  appendFileSync(reportPath, `${JSON.stringify(event)}\n`);
}

function userEntriesMatching(branch, message) {
  if (!message || message.role !== "user") return [];
  const content = JSON.stringify(message.content);
  return branch.filter((entry) => entry.type === "message"
    && entry.message.role === "user"
    && entry.message.timestamp === message.timestamp
    && JSON.stringify(entry.message.content) === content);
}

function inspectAutoRoute(request, ctx) {
  const branch = ctx.sessionManager.getBranch();
  const users = request.messages.filter((message) => message.role === "user");
  const latestUser = users.at(-1);
  const exactEntry = latestUser && branch.find((entry) =>
    entry.type === "message" && entry.message === latestUser);
  const matches = latestUser ? userEntriesMatching(branch, latestUser) : [];
  record({
    type: "auto_route",
    reason: request.reason,
    userMessageCount: users.length,
    latestUserReferenceMatchesBranch: exactEntry !== undefined,
    latestUserReferenceEntryId: exactEntry?.id,
    latestUserUniqueContentTimestampMatch: matches.length === 1,
    matchedUserEntryId: matches.length === 1 ? matches[0].id : undefined,
  });
}

export default function observeDispatchIdentity(pi) {
  const facade = new Proxy(pi, {
    get(target, property) {
      if (property === "registerVirtualModel") {
        return (definition) => {
          if (definition.provider !== "bifrost" || definition.id !== "auto") {
            return target.registerVirtualModel(definition);
          }
          const route = definition.route;
          return target.registerVirtualModel({
            ...definition,
            route: async (request, ctx) => {
              inspectAutoRoute(request, ctx);
              return route(request, ctx);
            },
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const extension = bifrostExtension(facade);

  pi.on("input", (event, ctx) => {
    record({
      type: "input_seen",
      source: event.source,
      matchesHandledFixture: event.text === "handled-identity-fixture",
      branchUserEntryCount: ctx.sessionManager.getBranch()
        .filter((entry) => entry.type === "message" && entry.message.role === "user").length,
    });
  });

  pi.on("turn_end", (event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    const entry = branch.find((candidate) => candidate.id === event.messageEntryId);
    const entryIndex = branch.findIndex((candidate) => candidate.id === event.messageEntryId);
    const nearestUser = branch.slice(0, entryIndex).findLast((candidate) =>
      candidate.type === "message" && candidate.message.role === "user");
    record({
      type: "turn_end",
      turnIndex: event.turnIndex,
      messageEntryId: event.messageEntryId,
      messageEntryMatchesEventObject: entry?.type === "message" && entry.message === event.message,
      entryRole: entry?.type === "message" ? entry.message.role : undefined,
      nearestUserEntryId: nearestUser?.id,
      outcome: event.outcome,
      parentId: entry?.parentId,
    });
  });

  pi.on("context_with_system", (event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    const users = event.messages.filter((message) => message.role === "user");
    const latestUser = users.at(-1);
    const exactEntry = latestUser && branch.find((entry) =>
      entry.type === "message" && entry.message === latestUser);
    const matches = latestUser ? userEntriesMatching(branch, latestUser) : [];
    record({
      type: "provider_context",
      userMessageCount: users.length,
      latestUserReferenceMatchesBranch: exactEntry !== undefined,
      latestUserReferenceEntryId: exactEntry?.id,
      latestUserUniqueContentTimestampMatch: matches.length === 1,
      matchedUserEntryId: matches.length === 1 ? matches[0].id : undefined,
      selectedModelIsBifrostAuto: ctx.model?.provider === "bifrost" && ctx.model.id === "auto",
    });
  });

  pi.on("agent_end", () => record({ type: "agent_end_seen" }));
  return extension;
}
