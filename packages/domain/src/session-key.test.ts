import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { SessionKey } from "./session-key.js";

const SAMPLE =
  "agent:cb30d64e-c6fe-474c-8566-90a66e51d656:feishu:default:direct:ou_f873ee025f33cd515e2e28e00e8d50be";
const SAMPLE_MD5 = "87f2915ee4caed4f9b02acef97b850fb";

describe("SessionKey", () => {
  test("builds channel peer session keys", () => {
    const sessionKey = SessionKey.forPeer({
      agentId: "cb30d64e-c6fe-474c-8566-90a66e51d656",
      channel: "feishu",
      accountId: "default",
      peerKind: "direct",
      peerId: "ou_f873ee025f33cd515e2e28e00e8d50be",
    });

    assert.equal(sessionKey.toString(), SAMPLE);
  });

  test("parses agent peer session keys", () => {
    const sessionKey = SessionKey.parse(SAMPLE);

    assert.deepEqual(sessionKey.agentParts, {
      agentId: "cb30d64e-c6fe-474c-8566-90a66e51d656",
      scope:
        "feishu:default:direct:ou_f873ee025f33cd515e2e28e00e8d50be",
      channel: "feishu",
      accountId: "default",
      peerKind: "direct",
      peerId: "ou_f873ee025f33cd515e2e28e00e8d50be",
    });
  });

  test("builds and parses main agent session keys", () => {
    const sessionKey = SessionKey.main("agent-1");

    assert.equal(sessionKey.toString(), "agent:agent-1:main");
    assert.deepEqual(sessionKey.agentParts, {
      agentId: "agent-1",
      scope: "main",
    });
  });

  test("returns null agent parts for non-agent legacy keys", () => {
    const sessionKey = SessionKey.fromString("fallback:abc123");

    assert.equal(sessionKey.agentParts, null);
  });

  test("hashes the exact raw session key with md5", () => {
    const sessionKey = SessionKey.parse(SAMPLE);

    assert.equal(sessionKey.toMd5(), SAMPLE_MD5);
    assert.equal(sessionKey.md5(), SAMPLE_MD5);
    assert.match(sessionKey.toMd5(), /^[a-f0-9]{32}$/);
  });

  test("derives downstream session ids by isolation strategy", () => {
    const sessionKey = SessionKey.fromString("channel-session");

    assert.equal(sessionKey.toSessionId({ type: "sessionKey" }), sessionKey.toMd5());
    assert.equal(
      sessionKey.toSessionId({
        type: "accountId",
        bindingId: "binding-1",
        accountId: "default",
      }),
      SessionKey.fromString("binding:binding-1:account:default").toMd5(),
    );

    assert.equal(sessionKey.toSessionId({ type: "request" }), undefined);
  });

  test("rejects empty session keys and empty build parts", () => {
    assert.throws(() => SessionKey.parse("   "), /sessionKey/);
    assert.throws(
      () =>
        SessionKey.forPeer({
          agentId: "agent-1",
          channel: "feishu",
          accountId: "default",
          peerKind: "direct",
          peerId: "",
        }),
      /peerId/,
    );
  });
});
